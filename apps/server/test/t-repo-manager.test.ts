import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkRig } from './helpers.ts';
import { createBoard, getBoard, createTask, getTask, finalizeTaskReview, claimTaskForReview, failTaskReview, retryTaskReview, recoverReviewerClaims } from '../src/tasks.ts';
import { registerAgent, ensureBrainAgent } from '../src/agents.ts';
import { submitTask } from '../src/verbs.ts';
import { RepoManager } from '../src/repo-manager.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';

function git(args: string[], cwd?: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

test('RepoManager initializes a server-owned managed bare repository', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'managed-b', name: 'Managed B', repoMode: 'managed', repoStatus: 'empty' });
    const manager = new RepoManager(rig.ctx);
    assert.deepEqual(manager.initialize(board.id, 'empty'), { status: 'queued' });
    await manager.waitForJob(board.id);
    const updated = getBoard(rig.ctx, board.id);
    assert.equal(updated.repoMode, 'managed');
    assert.equal(updated.repoStatus, 'ready');
    assert.equal(updated.repoError, '');
    assert.equal(existsSync(manager.repoPath(board.id)), true);
    assert.equal(git(['rev-parse', '--is-bare-repository'], manager.repoPath(board.id)), 'true');
    assert.equal(git(['symbolic-ref', 'HEAD'], manager.repoPath(board.id)), 'refs/heads/main');
  } finally { rig.cleanup(); }
});

test('RepoManager rejects unsafe remotes and does not initialize remote-legacy boards', async () => {
  const rig = mkRig();
  try {
    const managed = createBoard(rig.ctx, { id: 'managed-r', name: 'Managed R', repoMode: 'managed', repoStatus: 'empty' });
    const legacy = createBoard(rig.ctx, { id: 'legacy-r', name: 'Legacy R', repo: 'https://example.invalid/repo.git' });
    const manager = new RepoManager(rig.ctx);
    assert.throws(() => manager.initialize(managed.id, 'clone', 'file:///etc/passwd'), /HTTPS or SSH/);
    assert.throws(() => manager.initialize(legacy.id, 'empty'), /not in managed/);
    assert.equal(existsSync(manager.repoPath(managed.id)), false);
  } finally { rig.cleanup(); }
});

test('蜂后协议工具：asterhive_board_repo_status 与 asterhive_board_repo_init 状态检查与主仓初始化', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'init-test', name: 'Init Test', repoMode: 'managed', repoStatus: 'empty' });
    const legacy = createBoard(rig.ctx, { id: 'legacy-init', name: 'Legacy Init', repo: 'https://example.com/repo.git' });
    const brain = ensureBrainAgent(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'worker1', role: 'worker' }).agent;

    const toolStatus = TOOL_DEFS.find((t) => t.name === 'asterhive_board_repo_status')!;
    const toolInit = TOOL_DEFS.find((t) => t.name === 'asterhive_board_repo_init')!;
    assert.ok(toolStatus, 'asterhive_board_repo_status 存在');
    assert.ok(toolInit, 'asterhive_board_repo_init 存在');

    // 1. 状态检查：空仓需要初始化
    const st1 = (await toolStatus.handle(rig.ctx, brain, { boardId: board.id })) as { needsInit: boolean; repoStatus: string };
    assert.equal(st1.needsInit, true);
    assert.equal(st1.repoStatus, 'empty');

    // 2. 本机导入指引：生成 CLI 命令
    const cmdRes = (await toolInit.handle(rig.ctx, brain, { boardId: board.id, mode: 'local_import' })) as { command: string; mode: string };
    assert.equal(cmdRes.mode, 'local_import');
    assert.ok(cmdRes.command.includes('repo import --board init-test'));

    // 3. 执行 empty 模式初始化
    const emptyRes = (await toolInit.handle(rig.ctx, brain, { boardId: board.id, mode: 'empty' })) as { status: string; mode: string };
    assert.equal(emptyRes.mode, 'empty');
    assert.equal(emptyRes.status, 'ready');

    // 4. 再次检查：已就绪，needsInit 为 false
    const st2 = (await toolStatus.handle(rig.ctx, brain, { boardId: board.id })) as { needsInit: boolean; repoStatus: string };
    assert.equal(st2.needsInit, false);
    assert.equal(st2.repoStatus, 'ready');

    // 5. 权限与模式边界：工蜂调用 403；legacy 板调用 409
    await assert.rejects(async () => toolInit.handle(rig.ctx, worker, { boardId: board.id, mode: 'empty' }), /workers cannot/);
    await assert.rejects(async () => toolInit.handle(rig.ctx, brain, { boardId: legacy.id, mode: 'empty' }), /remote-legacy/);
  } finally {
    rig.cleanup();
  }
});
