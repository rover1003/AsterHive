import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http.ts';
import { makeCtx } from '../src/types.ts';
import { openDb } from '../src/db.ts';
import { registerAgent, setAgentEnabled } from '../src/agents.ts';
import { createBoard, createTask, setBoardRepoState } from '../src/tasks.ts';
import { RepoManager } from '../src/repo-manager.ts';
import { claimTask, submitTask } from '../src/verbs.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';
import { mkRig } from './helpers.ts';

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E Test',
      GIT_AUTHOR_EMAIL: 'e2e@test.invalid',
      GIT_COMMITTER_NAME: 'E2E Test',
      GIT_COMMITTER_EMAIL: 'e2e@test.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

test('Managed repository end-to-end: snapshot -> worker commit -> upload -> brain inspect -> integrate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-managed-e2e-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const db = openDb(dataDir);
  const ctx = makeCtx(db, { dataDir, ttlMinutes: 10, keepSnapshots: 2 });
  const app = createApp(ctx);
  const mgr = new RepoManager(ctx);

  try {
    // 1. 注册主脑、worker
    const brain = registerAgent(ctx, { name: 'Master', handle: 'asterhive-brain', role: 'orchestrator' });
    const worker = registerAgent(ctx, { name: 'Worker', handle: 'worker-node', role: 'worker' });

    // 2. 建 managed 板与初始 bare 仓库
    const board = createBoard(ctx, { id: 'proj-managed', name: 'Managed Project', repoMode: 'managed' });
    mgr.initialize(board.id, 'empty');
    await mgr.waitForJob(board.id);

    // 3. 在服务器主仓里打一个初始提交
    const bareRepo = mgr.repoPath(board.id);
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'README.md'), '# Managed Project Initial\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'Initial commit'], seed);
    git(['push', '-q', bareRepo, 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bareRepo);
    const initialHead = git(['rev-parse', 'HEAD'], seed);
    setBoardRepoState(ctx, board.id, { status: 'ready', head: initialHead });

    // 4. 立项一个任务
    const task = createTask(ctx, board.id, {
      id: 'TASK-1',
      title: 'Add feature file',
      detail: 'Create feature.txt',
      lane: 'Ready',
      assignee: worker.agent.id,
    });
    claimTask(ctx, worker.agent, task.id);

    // 5. Worker 请求 snapshot bundle 端点
    const snapRes = await app.request(`/tasks/${task.id}/repo-snapshot`, {
      headers: { authorization: `Bearer ${worker.token}` },
    });
    assert.equal(snapRes.status, 200);
    const snapBuf = Buffer.from(await snapRes.arrayBuffer());
    assert.ok(snapBuf.length > 0);

    // 6. Worker 在本地临时工作区解包、修改并打包结果 bundle
    const workerBase = join(root, 'worker-worktree');
    mkdirSync(workerBase);
    const snapFile = join(workerBase, 'snapshot.bundle');
    writeFileSync(snapFile, snapBuf);
    const workerDir = join(workerBase, 'src');
    git(['clone', snapFile, workerDir], workerBase);
    git(['checkout', '-b', 'asterhive/TASK-1'], workerDir);
    writeFileSync(join(workerDir, 'feature.txt'), 'hello from managed worker\n');
    git(['add', '-A'], workerDir);
    git(['commit', '-m', 'asterhive(TASK-1): add feature file'], workerDir);
    const workerCommit = git(['rev-parse', 'HEAD'], workerDir);

    const resBundle = join(workerBase, 'result.bundle');
    git(['bundle', 'create', resBundle, 'asterhive/TASK-1'], workerDir);
    const resBuf = readFileSync(resBundle);
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(resBuf).digest('hex');

    // 7. Worker 回传任务结果 bundle
    const uploadRes = await app.request(`/tasks/${task.id}/repo-result`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${worker.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(resBuf.length),
        'x-content-sha256': sha256,
      },
      body: resBuf,
    });
    if (uploadRes.status !== 200) {
      const errText = await uploadRes.text();
      assert.fail(`upload failed HTTP ${uploadRes.status}: ${errText}`);
    }
    assert.equal(uploadRes.status, 200);
    const uploadJson = (await uploadRes.json()) as { status: string; taskRef: string; headCommit: string };
    assert.equal(uploadJson.status, 'saved');
    assert.equal(uploadJson.headCommit, workerCommit);

    // 8. 主脑通过受限工具检查差异与证据
    const inspectTool = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_inspect_task')!;
    const inspection = (await inspectTool.handle(ctx, brain, { taskId: task.id })) as {
      base: string;
      head: string;
      changedFiles: string[];
    };
    assert.equal(inspection.head, workerCommit);
    assert.ok(inspection.changedFiles.includes('feature.txt'));

    // 9. 人工验收不能跳过集成；专用端点必须先合并再将任务标为 Done。
    submitTask(ctx, worker.agent, task.id, { summary: '工作完成', attempt: 1 });
    const bypass = await app.request(`/tasks/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lane: 'Done' }),
    });
    assert.equal(bypass.status, 409);
    const accepted = await app.request(`/tasks/${task.id}/review/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(accepted.status, 200);
    const acceptance = await accepted.json() as { task: { lane: string }; mergedCommit: string };
    assert.equal(acceptance.task.lane, 'Done');
    assert.ok(acceptance.mergedCommit);

    // 10. 验证服务器 bare repo 的 main 分支已推进，包含 worker 的改动
    const finalHead = git(['rev-parse', 'refs/heads/main'], bareRepo);
    assert.equal(finalHead, acceptance.mergedCommit);
    const show = git(['log', '-1', '--oneline', finalHead], bareRepo);
    assert.ok(show.includes('Integrate task TASK-1 into main'));
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

test('人工验收托管代码任务缺少 task ref 时保持 Review', async () => {
  const rig = mkRig();
  try {
    const manager = new RepoManager(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: 'worker', handle: 'no-ref-bee' });
    const board = createBoard(rig.ctx, { id: 'no-ref', name: 'No ref', repoMode: 'managed' });
    manager.initialize(board.id, 'empty');
    await manager.waitForJob(board.id);
    const task = createTask(rig.ctx, board.id, { id: 'T1', title: 'No result', lane: 'Ready', assignee: worker.agent.id });
    claimTask(rig.ctx, worker.agent, task.id);
    submitTask(rig.ctx, worker.agent, task.id, { summary: 'missing result', attempt: 1 });
    const app = createApp(rig.ctx, manager);
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'reviewing' WHERE id = ?").run(task.id);
    assert.equal((await app.request(`/tasks/${task.id}/review/accept`, { method: 'POST' })).status, 409);
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'none' WHERE id = ?").run(task.id);
    const response = await app.request(`/tasks/${task.id}/review/accept`, { method: 'POST' });
    assert.equal(response.status, 404);
    const after = await (await app.request(`/tasks/${task.id}`)).json() as { task: { lane: string } };
    assert.equal(after.task.lane, 'Review');
  } finally {
    rig.cleanup();
  }
});

test('托管无代码任务须先进入 Review，人工验收无需代码引用', async () => {
  const rig = mkRig();
  try {
    const worker = registerAgent(rig.ctx, { name: 'worker', handle: 'no-code-bee' });
    createBoard(rig.ctx, { id: 'no-code', name: 'No code', repoMode: 'managed' });
    assert.throws(() => createTask(rig.ctx, 'no-code', { id: 'T1', title: 'bypass', lane: 'Done', workspace: { noCode: true } }), /不能直接创建为 Done/);
    createTask(rig.ctx, 'no-code', { id: 'T2', title: 'investigate', lane: 'Ready', assignee: worker.agent.id, workspace: { noCode: true } });
    const app = createApp(rig.ctx);
    assert.equal((await app.request('/tasks/T2', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lane: 'Done' }) })).status, 409);
    claimTask(rig.ctx, worker.agent, 'T2');
    submitTask(rig.ctx, worker.agent, 'T2', { summary: 'investigation', attempt: 1 });
    const response = await app.request('/tasks/T2/review/accept', { method: 'POST' });
    assert.equal(response.status, 200);
    const result = await response.json() as { task: { lane: string; reviewStatus: string; reviewSummary: string }; mergedCommit: string | null };
    assert.equal(result.task.lane, 'Done');
    assert.equal(result.task.reviewStatus, 'none');
    assert.equal(result.task.reviewSummary, '用户人工验收通过');
    assert.equal(result.mergedCommit, null);
  } finally {
    rig.cleanup();
  }
});

test('重做转为无代码交付后人工验收不合入上一轮被退回的代码', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'runtime-no-code', name: 'Runtime no code', repoMode: 'managed' });
    const manager = new RepoManager(rig.ctx);
    manager.initialize(board.id, 'empty');
    await manager.waitForJob(board.id);
    const bare = manager.repoPath(board.id);
    const seed = join(rig.ctx.cfg.dataDir, 'seed-no-code');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'README.md'), 'base\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'Base'], seed);
    const base = git(['rev-parse', 'HEAD'], seed);
    git(['push', '-q', bare, 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
    setBoardRepoState(rig.ctx, board.id, { status: 'ready', head: base });
    const worker = registerAgent(rig.ctx, { name: 'Runtime no code', handle: 'runtime-no-code' });
    createTask(rig.ctx, board.id, { id: 'NC-3', title: 'Investigate', lane: 'Ready', assignee: worker.agent.id, files: ['rejected.txt'] });
    claimTask(rig.ctx, worker.agent, 'NC-3');
    writeFileSync(join(seed, 'rejected.txt'), 'rejected code\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'First attempt, rejected'], seed);
    git(['push', '-q', bare, 'HEAD:refs/asterhive/tasks/NC-3'], seed);
    submitTask(rig.ctx, worker.agent, 'NC-3', { summary: 'First attempt', attempt: 1 });
    const app = createApp(rig.ctx);
    const returned = await app.request('/tasks/NC-3/review/return', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Investigate further without accepting the old code' }) });
    assert.equal(returned.status, 200);
    const review = submitTask(rig.ctx, worker.agent, 'NC-3', { summary: 'Exploration result; no new code', attempt: 2, noCode: true });
    assert.equal(review.lane, 'Review');
    const response = await app.request('/tasks/NC-3/review/accept', { method: 'POST' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.mergedCommit, null);
    assert.equal(result.task.workspace.noCode, true);
    assert.equal(result.task.lane, 'Done');
    assert.equal(git(['rev-parse', 'HEAD'], bare), base);
  } finally { rig.cleanup(); }
});

test('同一托管仓库的并行人工验收保留两份成果，不发生非快进推送竞态', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'parallel-merge', name: 'Parallel merge', repoMode: 'managed' });
    const manager = new RepoManager(rig.ctx);
    manager.initialize(board.id, 'empty');
    await manager.waitForJob(board.id);
    const bare = manager.repoPath(board.id);
    const seed = join(rig.ctx.cfg.dataDir, 'seed');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'README.md'), 'initial\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'Initial'], seed);
    const base = git(['rev-parse', 'HEAD'], seed);
    git(['push', '-q', bare, 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
    setBoardRepoState(rig.ctx, board.id, { status: 'ready', head: base });
    for (const index of [1, 2]) {
      const id = `MERGE-${index}`;
      createTask(rig.ctx, board.id, { id, title: id, lane: 'Review', files: [`feature-${index}.txt`] });
      git(['checkout', '-q', '-B', `task-${index}`, base], seed);
      writeFileSync(join(seed, `feature-${index}.txt`), `result-${index}\n`);
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', id], seed);
      git(['push', '-q', bare, `HEAD:refs/asterhive/tasks/${id}`], seed);
    }
    const app = createApp(rig.ctx);
    const responses = await Promise.all([1, 2].map(index => app.request(`/tasks/MERGE-${index}/review/accept`, { method: 'POST' })));
    const results = await Promise.all(responses.map(async response => ({ status: response.status, body: await response.json() })));
    assert.deepEqual(results.map(result => result.status), [200, 200], JSON.stringify(results));
    assert.equal(git(['show', 'HEAD:feature-1.txt'], bare), 'result-1');
    assert.equal(git(['show', 'HEAD:feature-2.txt'], bare), 'result-2');
    for (const result of results) assert.equal(result.body.task.lane, 'Done');
    assert.equal(rig.ctx.holder.db.prepare('SELECT repo_head FROM board WHERE id=?').get(board.id)?.repo_head, git(['rev-parse', 'HEAD'], bare));
  } finally { rig.cleanup(); }
});
