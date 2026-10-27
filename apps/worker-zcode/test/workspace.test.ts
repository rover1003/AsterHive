import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkspace, prepareWorkspace } from '../src/workspace.ts';
import * as workspaceModule from '../src/workspace.ts';

test('execution submission gate rejects failed execution and missing code commit, but permits explicit no-code work', () => {
  const workspace = workspaceModule as unknown as {
    canSubmitExecution?: (input: { exitCode: number | null; commitHash?: string; commitFailed?: boolean; noCode: boolean }) => boolean;
  };
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 1, commitHash: 'abc123', noCode: false }), false);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, noCode: false }), false);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, commitHash: 'abc123', noCode: false }), true);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, noCode: true }), true);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, commitFailed: true, noCode: true }), false);
});

// 项目工作区持久化（T15 / §9.4）：repo 模式 clone/pull --rebase/任务分支/本地 commit，
// scratch 模式一次性目录；clone 失败抛错阻塞、绝不静默 fallback。

// commitWorkspace 用设备 git 全局身份（产品代码不代设）——测试经环境变量提供，
// 避免依赖本机是否配过 user.name / user.email。
process.env.GIT_AUTHOR_NAME = '星巢测试';
process.env.GIT_AUTHOR_EMAIL = 'test@asterhive.local';
process.env.GIT_COMMITTER_NAME = '星巢测试';
process.env.GIT_COMMITTER_EMAIL = 'test@asterhive.local';

let seq = 0;

function gitSync(args: string[], cwd?: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}

// fixture：临时目录里 git init --bare 一个"远端" + clone 出 seed 做初始提交推上去。
// 用 push origin HEAD 规避各 git 版本默认分支名差异（master/main）。
function makeRemote(root: string): string {
  const repo = join(root, `remote-${++seq}.git`);
  gitSync(['init', '--bare', '-q', repo]);
  const seed = join(root, `seed-${seq}`);
  gitSync(['clone', '-q', repo, seed]);
  writeFileSync(join(seed, 'README.md'), `# seed ${seq}\n`);
  gitSync(['add', '-A'], seed);
  gitSync(['commit', '-q', '-m', 'init'], seed);
  gitSync(['push', '-q', 'origin', 'HEAD'], seed);
  return repo;
}

const noopLog = () => {};

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows 下 git 只读对象偶发删不掉：留在系统临时目录，不影响测试结论
  }
}

test('工作区: 首任务 clone（cloned=true、.git 存在、projects/<boardId> 路径）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-clone-'));
  try {
    const repo = makeRemote(root);
    const ws = await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T1', repo, log: noopLog });
    assert.equal(ws.mode, 'repo');
    assert.equal(ws.cloned, true, '首次接入应 clone');
    assert.equal(ws.pulled, undefined, '首次接入不 pull');
    assert.equal(ws.dir, join(root, 'projects', 'b1'));
    assert.equal(ws.branch, 'asterhive/T1');
    assert.ok(existsSync(join(ws.dir, '.git')), 'clone 出完整 git 工作区');
  } finally {
    cleanup(root);
  }
});

test('工作区: 同板第二任务 pull --rebase（不重复 clone）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-pull-'));
  try {
    const repo = makeRemote(root);
    const ws1 = await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T1', repo, log: noopLog });
    const ws2 = await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T2', repo, log: noopLog });
    assert.equal(ws2.cloned, undefined, '同一持久工作区不重复 clone');
    assert.equal(ws2.pulled, true, '第二个任务走 pull --rebase');
    assert.equal(ws2.dir, ws1.dir, '同板同设备共用一个工作区目录');
    assert.equal(ws2.branch, 'asterhive/T2', '每次任务切自己的任务分支');
  } finally {
    cleanup(root);
  }
});

test('工作区: 上任务留下的任务分支不影响下次 pull（先切回默认分支再 rebase）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-branch-'));
  try {
    const repo = makeRemote(root);
    await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T1', repo, log: noopLog });
    // T2 正常开工：此时工作区还停在 asterhive/T1（无 upstream），pull 必须先切回默认分支
    const ws2 = await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T2', repo, log: noopLog });
    assert.equal(ws2.pulled, true);
    // 同任务重做：同名分支已存在 → 复用而不是报错
    const ws1again = await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T1', repo, log: noopLog });
    assert.equal(ws1again.branch, 'asterhive/T1');
    const on = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], ws1again.dir).trim();
    assert.equal(on, 'asterhive/T1', '复用已存在的任务分支');
  } finally {
    cleanup(root);
  }
});

test('commit: 写文件返回 hash、log 含任务分支与约定格式；无变更返回 undefined', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-commit-'));
  try {
    const repo = makeRemote(root);
    const ws = await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T2', repo, log: noopLog });

    // 无变更 → undefined
    assert.equal(await commitWorkspace(ws, '没有变更'), undefined);

    // 有变更 → hash + 变更清单 + 约定格式的提交信息，分支保持 asterhive/<taskId>
    writeFileSync(join(ws.dir, 'out.txt'), '成果\n');
    const hash = await commitWorkspace(ws, '任务标题');
    assert.ok(hash, '有变更应返回 commit hash');
    assert.match(hash!, /^[0-9a-f]{7,40}$/);
    assert.deepEqual(ws.changedFiles, ['out.txt']);
    assert.equal(ws.commitHash, hash);
    assert.equal(gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], ws.dir).trim(), 'asterhive/T2', '分支保持任务分支不合并');
    assert.equal(gitSync(['log', '-1', '--pretty=%B'], ws.dir).trim(), 'asterhive(T2): 任务标题');
    assert.ok(gitSync(['branch', '--list', 'asterhive/T2'], ws.dir).includes('asterhive/T2'));

    // 再 commit 一次（无新变更）→ undefined
    assert.equal(await commitWorkspace(ws, '重复'), undefined);
  } finally {
    cleanup(root);
  }
});

test('commit: 中文文件名与删除也计入变更（porcelain -z 解析）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-cjk-'));
  try {
    const repo = makeRemote(root);
    const ws = await prepareWorkspace({ workdirRoot: root, boardId: 'b1', taskId: 'T1', repo, log: noopLog });
    writeFileSync(join(ws.dir, '报告.md'), '中文内容\n');
    gitSync(['rm', '-q', 'README.md'], ws.dir);
    const hash = await commitWorkspace(ws, '中文与删除');
    assert.ok(hash);
    assert.deepEqual([...(ws.changedFiles ?? [])].sort(), ['README.md', '报告.md']);
  } finally {
    cleanup(root);
  }
});

test('repo 不可达: 抛错阻塞，不 fallback 到 scratch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-badrepo-'));
  try {
    const badRepo = join(root, 'no-such-repo');
    await assert.rejects(
      prepareWorkspace({ workdirRoot: root, boardId: 'b2', taskId: 'T9', repo: badRepo, log: noopLog }),
      /失败/,
      'clone 失败必须抛错（调用方转 checkpoint 阻塞上报）',
    );
    assert.equal(existsSync(join(root, 'projects', 'b2', '.git')), false, '不留下半成品工作区');

    // 目录存在但不是 git 仓库：同样抛错（来历不明的残留宁可阻塞）
    const stray = join(root, 'projects', 'b3');
    mkdirSync(stray, { recursive: true });
    await assert.rejects(
      prepareWorkspace({ workdirRoot: root, boardId: 'b3', taskId: 'T9', repo: makeRemote(root), log: noopLog }),
      /需人工清理/,
    );
  } finally {
    cleanup(root);
  }
});

test('scratch 模式: 无 repo 建一次性目录 <workdirRoot>/<taskId>，commit 无语义', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-scratch-'));
  try {
    const ws = await prepareWorkspace({ workdirRoot: root, boardId: 'bx', taskId: 'T3', repo: null, log: noopLog });
    assert.equal(ws.mode, 'scratch');
    assert.equal(ws.dir, join(root, 'T3'));
    assert.ok(existsSync(ws.dir), '目录已建');
    assert.equal(existsSync(join(ws.dir, '.git')), false, 'scratch 无 git 语义');
    assert.equal(ws.branch, undefined);
    assert.equal(await commitWorkspace(ws, 'x'), undefined, 'scratch 模式不提交');
  } finally {
    cleanup(root);
  }
});
