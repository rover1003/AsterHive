import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkspace, prepareWorkspace } from '../src/workspace.ts';
import * as workspaceModule from '../src/workspace.ts';

test('execution submission gate rejects failed execution and git commit errors, but permits code commits and exploratory results without file changes', () => {
  const workspace = workspaceModule as unknown as {
    canSubmitExecution?: (input: { exitCode: number | null; commitHash?: string; commitFailed?: boolean; noCode?: boolean }) => boolean;
  };
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 1, commitHash: 'abc123', noCode: false }), false);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, commitFailed: true, noCode: false }), false);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, commitHash: 'abc123', noCode: false }), true);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, noCode: true }), true);
  assert.equal(workspace.canSubmitExecution?.({ exitCode: 0, noCode: false }), false, '代码任务无 commitHash 时必须拒绝提交');
});

// 项目工作区持久化（T15 / §9.4）：repo 模式 clone/pull --rebase/任务分支/本地 commit，
// scratch 模式一次性目录；clone 失败抛错阻塞、绝不静默 fallback。

// 大多数测试使用固定身份，避免依赖本机 Git 配置；缺省身份场景单独覆盖。
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
function makeBundle(root: string, taskId: string): { bundleFile: Buffer; baseCommit: string; reworkCommit: string } {
  const repo = join(root, `bundle-src-${++seq}`);
  gitSync(['init', '-q', repo]);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  gitSync(['add', 'base.txt'], repo);
  gitSync(['commit', '-q', '-m', 'base commit'], repo);
  const baseCommit = gitSync(['rev-parse', 'HEAD'], repo).trim();

  const branch = `asterhive/${taskId}`;
  gitSync(['checkout', '-b', branch], repo);
  writeFileSync(join(repo, 'feature.txt'), 'attempt 1\n');
  gitSync(['add', 'feature.txt'], repo);
  gitSync(['commit', '-q', '-m', 'attempt 1 commit'], repo);
  const reworkCommit = gitSync(['rev-parse', 'HEAD'], repo).trim();

  const bundlePath = join(root, `test-${seq}.bundle`);
  gitSync(['bundle', 'create', bundlePath, 'HEAD', branch], repo);
  const bundleFile = readFileSync(bundlePath);
  return { bundleFile, baseCommit, reworkCommit };
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

test('commit: 无 Git 身份时可提交，且不覆盖已有仓库身份', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-identity-'));
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const repo = makeRemote(root);
    for (const key of keys) delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = join(root, 'missing-global-config');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const ws = await prepareWorkspace({ workdirRoot: root, boardId: 'identity', taskId: 'T1', repo, log: noopLog });
    writeFileSync(join(ws.dir, 'agent.txt'), 'agent');
    gitSync(['add', 'agent.txt'], ws.dir);
    gitSync(['commit', '-m', 'agent commit'], ws.dir);
    writeFileSync(join(ws.dir, 'first.txt'), 'first');
    assert.ok(await commitWorkspace(ws, 'first'));
    assert.equal(gitSync(['log', '-1', '--format=%an <%ae>'], ws.dir).trim(), 'AsterHive Worker <worker@asterhive.invalid>');
    gitSync(['config', '--local', 'user.name', 'Existing Author'], ws.dir);
    gitSync(['config', '--local', 'user.email', 'existing@example.invalid'], ws.dir);
    writeFileSync(join(ws.dir, 'second.txt'), 'second');
    assert.ok(await commitWorkspace(ws, 'second'));
    assert.equal(gitSync(['log', '-1', '--format=%an <%ae>'], ws.dir).trim(), 'Existing Author <existing@example.invalid>');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
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

test('managed 模式: 支持重做快照签出（检出上一轮 advertised rework commit，保留原始 baseCommit）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-rework-'));
  try {
    const { bundleFile, baseCommit, reworkCommit } = makeBundle(root, 'T101');
    let uploadedAttempt: number | undefined;
    let uploadedBuf: Uint8Array | undefined;
    const mockWorker = {
      downloadTaskSnapshot: async () => ({
        buffer: bundleFile.buffer.slice(bundleFile.byteOffset, bundleFile.byteOffset + bundleFile.byteLength),
        baseCommit,
        reworkCommit,
        reworkBranch: 'asterhive/T101',
      }),
      uploadTaskResult: async (_taskId: string, buf: Uint8Array, _sha256: string, attempt?: number) => {
        uploadedAttempt = attempt;
        uploadedBuf = buf;
        return { taskRef: 'refs/asterhive/tasks/T101', headCommit: 'dummy' };
      },
    };

    const ws = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-rework',
      taskId: 'T101',
      attempt: 2,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });

    assert.equal(ws.mode, 'managed');
    assert.equal(ws.baseCommit, baseCommit, '原始基线必须保留，不可被 HEAD 覆盖');
    assert.equal(ws.attempt, 2);
    const currentHead = gitSync(['rev-parse', 'HEAD'], ws.dir).trim();
    assert.equal(currentHead, reworkCommit, '重做工作区必须切到上一轮成果提交');
    assert.ok(existsSync(join(ws.dir, 'feature.txt')), '上一轮成果文件应当存在');

    writeFileSync(join(ws.dir, 'rework-fix.txt'), 'fixed in attempt 2\n');
    const newHash = await commitWorkspace(ws, '落实重做反馈');
    assert.ok(newHash);
    assert.notEqual(newHash, reworkCommit);
    assert.equal(uploadedAttempt, 2, '上传 bundle 须携带 attempt 栅栏');
    assert.ok(uploadedBuf && uploadedBuf.byteLength > 0);
  } finally {
    cleanup(root);
  }
});

test('managed 模式: 无全局 Git 身份时，新工作区与复用工作区均可提交，且支持模型直接 git commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-managed-id-'));
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const { bundleFile, baseCommit } = makeBundle(root, 'T201');
    for (const key of keys) delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = join(root, 'missing-global-config');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const mockWorker = {
      downloadTaskSnapshot: async () => ({
        buffer: bundleFile.buffer.slice(bundleFile.byteOffset, bundleFile.byteOffset + bundleFile.byteLength),
        baseCommit,
      }),
      uploadTaskResult: async () => ({ taskRef: 'ref', headCommit: 'head' }),
    };

    // 1. 新工作区准备，测试直接 git commit
    const ws1 = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-id',
      taskId: 'T201',
      attempt: 1,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });
    writeFileSync(join(ws1.dir, 'agent-managed.txt'), 'agent commit');
    gitSync(['add', 'agent-managed.txt'], ws1.dir);
    gitSync(['commit', '-m', 'agent direct commit'], ws1.dir);
    assert.equal(gitSync(['log', '-1', '--format=%an <%ae>'], ws1.dir).trim(), 'AsterHive Worker <worker@asterhive.invalid>');

    // 2. 复用工作区准备，包含在途未提交修改
    writeFileSync(join(ws1.dir, 'pending.txt'), 'pending changes');
    const ws2 = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-id',
      taskId: 'T201',
      attempt: 1,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });
    assert.equal(ws2.dir, ws1.dir);
    assert.ok(existsSync(join(ws2.dir, 'pending.txt')));
    const hash = await commitWorkspace(ws2, 'commit pending');
    assert.ok(hash);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    cleanup(root);
  }
});

test('managed 模式: 非重做任务（isRework=false）即使快照带有历史 reworkCommit 也不切历史成果', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-fresh-'));
  try {
    const { bundleFile, baseCommit, reworkCommit } = makeBundle(root, 'T301');
    const mockWorker = {
      downloadTaskSnapshot: async () => ({
        buffer: bundleFile.buffer.slice(bundleFile.byteOffset, bundleFile.byteOffset + bundleFile.byteLength),
        baseCommit,
        reworkCommit,
        reworkBranch: 'asterhive/T301',
      }),
      uploadTaskResult: async () => ({ taskRef: 'ref', headCommit: 'head' }),
    };

    // 全新任务领活（非重做，isRework=false）
    const ws = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-fresh',
      taskId: 'T301',
      attempt: 1,
      isRework: false,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });

    assert.equal(ws.mode, 'managed');
    assert.equal(ws.baseCommit, baseCommit);
    const currentHead = gitSync(['rev-parse', 'HEAD'], ws.dir).trim();
    assert.equal(currentHead, baseCommit, '非重做任务必须基于原始基线 HEAD，不得签出历史成果');
    assert.equal(existsSync(join(ws.dir, 'feature.txt')), false, '全新任务工作区不应包含上一轮产物');
  } finally {
    cleanup(root);
  }
});

test('managed 模式恢复: 复用包含未上交提交的干净工作区时，对齐 initialCommit 并成功补交未上传成果', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-retry-'));
  try {
    const { bundleFile, baseCommit } = makeBundle(root, 'T401');
    let uploadedAttempt: number | undefined;
    let uploadCalls = 0;
    const mockWorker = {
      downloadTaskSnapshot: async () => ({
        buffer: bundleFile.buffer.slice(bundleFile.byteOffset, bundleFile.byteOffset + bundleFile.byteLength),
        baseCommit,
      }),
      uploadTaskResult: async (_taskId: string, _buf: Uint8Array, _sha256: string, attempt?: number) => {
        uploadCalls++;
        uploadedAttempt = attempt;
        return { taskRef: 'refs/asterhive/tasks/T401', headCommit: 'dummy' };
      },
    };

    // 1. 首次执行：准备工作区并在其中提交了一个改动，但假设因网络等原因未成功上传/上交
    const ws1 = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-retry',
      taskId: 'T401',
      attempt: 1,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });
    writeFileSync(join(ws1.dir, 'outstanding.txt'), 'committed earlier\n');
    gitSync(['add', 'outstanding.txt'], ws1.dir);
    gitSync(['commit', '-m', 'outstanding commit before crash'], ws1.dir);
    const outstandingHash = gitSync(['rev-parse', 'HEAD'], ws1.dir).trim();
    const existingBundle = join(root, 'ephemeral', 'b-retry-T401', 'snapshot.bundle');
    writeFileSync(existingBundle, 'preserved snapshot');

    // 2. 第二次重试（复用现有工作区）：工作区树此时是干净的（没有未暂存/未提交改动）
    const ws2 = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-retry',
      taskId: 'T401',
      attempt: 2,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });
    assert.equal(ws2.dir, ws1.dir);
    assert.equal(ws2.baseCommit, baseCommit);
    assert.equal(readFileSync(existingBundle, 'utf8'), 'preserved snapshot');
    assert.equal(ws2.initialCommit, baseCommit);

    // 3. commitWorkspace 必须能够对比 initialCommit 识别到已落盘的 outstanding 提交，完成补交而不是抛弃
    const submittedHash = await commitWorkspace(ws2, 'retry submission');
    assert.equal(submittedHash, outstandingHash, '必须补交已存在但未上交的提交');
    assert.equal(uploadCalls, 1, '应当触发结果 bundle 上传');
    assert.equal(uploadedAttempt, 2, '上传时携带新代次 attempt 栅栏');
  } finally {
    cleanup(root);
  }
});

test('managed 模式恢复: 重做任务在已接受的成果上无新产出时保持阻塞（返回 undefined 且禁止交活）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-rework-blocked-'));
  try {
    const { bundleFile, baseCommit, reworkCommit } = makeBundle(root, 'T501');
    let uploadCalls = 0;
    const mockWorker = {
      downloadTaskSnapshot: async () => ({
        buffer: bundleFile.buffer.slice(bundleFile.byteOffset, bundleFile.byteOffset + bundleFile.byteLength),
        baseCommit,
        reworkCommit,
        reworkBranch: 'asterhive/T501',
      }),
      uploadTaskResult: async () => {
        uploadCalls++;
        return { taskRef: 'refs/asterhive/tasks/T501', headCommit: 'dummy' };
      },
    };

    // 首次领重做任务，签出上一轮已接受的成果 reworkCommit
    const ws1 = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-block',
      taskId: 'T501',
      attempt: 2,
      isRework: true,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });
    assert.equal(gitSync(['rev-parse', 'HEAD'], ws1.dir).trim(), reworkCommit);

    // 假设重试或再次复用，且模型未在该成果上做出任何新提交或改动
    const ws2 = await prepareWorkspace({
      workdirRoot: root,
      boardId: 'b-block',
      taskId: 'T501',
      attempt: 2,
      isRework: true,
      repoMode: 'managed',
      worker: mockWorker,
      log: noopLog,
    });
    assert.equal(ws2.initialCommit, reworkCommit, '重做对比起点必须是已接受的上一轮 reworkCommit');

    // 没有新改动时 commitWorkspace 必须返回 undefined，严禁把旧成果重复当作新提交提交
    const hash = await commitWorkspace(ws2, 'no new changes');
    assert.equal(hash, undefined, '无新改动时绝不重复提交旧成果');
    assert.equal(uploadCalls, 0, '绝不上载空结果 bundle');
  } finally {
    cleanup(root);
  }
});

test('managed 无代码任务退回重做时无需不存在的任务提交', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-no-code-rework-'));
  try {
    const { bundleFile, baseCommit } = makeBundle(root, 'T601');
    const worker = {
      downloadTaskSnapshot: async () => ({
        buffer: bundleFile.buffer.slice(bundleFile.byteOffset, bundleFile.byteOffset + bundleFile.byteLength),
        baseCommit,
      }),
      uploadTaskResult: async () => ({ taskRef: '', headCommit: '' }),
    };
    const ws = await prepareWorkspace({
      workdirRoot: root, boardId: 'b', taskId: 'T601', repoMode: 'managed',
      isRework: true, noCode: true, worker, log: noopLog,
    });
    assert.equal(gitSync(['rev-parse', 'HEAD'], ws.dir).trim(), baseCommit);
  } finally {
    cleanup(root);
  }
});

test('commit: evidence 包含模型已提交和后续未提交的所有文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-ws-evidence-'));
  try {
    const repo = makeRemote(root);
    const ws = await prepareWorkspace({ workdirRoot: root, boardId: 'b', taskId: 'T1', repo, log: noopLog });
    writeFileSync(join(ws.dir, 'first.txt'), 'first');
    gitSync(['add', 'first.txt'], ws.dir);
    gitSync(['commit', '-m', 'agent commit'], ws.dir);
    writeFileSync(join(ws.dir, 'second.txt'), 'second');
    assert.ok(await commitWorkspace(ws, 'complete'));
    assert.deepEqual([...(ws.changedFiles ?? [])].sort(), ['first.txt', 'second.txt']);
  } finally {
    cleanup(root);
  }
});

test('managed 上交不覆盖用户 result.bundle，上传失败保留可重试提交与原始基线', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-bundle-preserve-'));
  try {
    const { bundleFile, baseCommit } = makeBundle(root, 'T701');
    let fail = true;
    const worker = {
      downloadTaskSnapshot: async () => ({
        buffer: bundleFile.buffer.slice(bundleFile.byteOffset, bundleFile.byteOffset + bundleFile.byteLength),
        baseCommit,
      }),
      uploadTaskResult: async () => {
        if (fail) throw new Error('上传中断');
        return { taskRef: 'refs/asterhive/tasks/T701', headCommit: 'abc' };
      },
    };
    const ws = await prepareWorkspace({ workdirRoot: root, boardId: 'b', taskId: 'T701', repoMode: 'managed', worker, log: noopLog });
    const userFile = join(ws.dir, 'result.bundle');
    writeFileSync(userFile, '用户文件');
    await assert.rejects(commitWorkspace(ws, 'first'), /上传中断/);
    assert.equal(readFileSync(userFile, 'utf8'), '用户文件');
    assert.equal(ws.baseCommit, baseCommit);
    fail = false;
    assert.ok(await commitWorkspace(ws, 'retry'));
    assert.equal(readFileSync(userFile, 'utf8'), '用户文件');
    assert.equal(gitSync(['status', '--porcelain'], ws.dir), '');
  } finally {
    cleanup(root);
  }
});
