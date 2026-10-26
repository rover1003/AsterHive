import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type AddressInfo } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './_brain-env.ts';
import { mkRig } from './helpers.ts';
import { registerAgent, ensureBrainAgent } from '../src/agents.ts';
import {
  createBoard,
  createTask,
  getTask,
  finalizeTaskReview,
  claimTaskForReview,
  failTaskReview,
  retryTaskReview,
  recoverReviewerClaims,
} from '../src/tasks.ts';
import { submitTask, claimTask } from '../src/verbs.ts';
import { getOrchestratorSettings, putOrchestratorSettings, createOrchestratorGroup } from '../src/settings.ts';
import { createApp } from '../src/http.ts';
import { listEvents } from '../src/write.ts';
import { listMessages } from '../src/messages.ts';
import { RepoManager } from '../src/repo-manager.ts';
import { Brain } from '../src/brain.ts';
import { PiRuntimeManager } from '../src/pi-runtime.ts';

function git(args: string[], cwd?: string): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Reviewer Test',
      GIT_AUTHOR_EMAIL: 'review@test.invalid',
      GIT_COMMITTER_NAME: 'Reviewer Test',
      GIT_COMMITTER_EMAIL: 'review@test.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function sseChunk(id: string, delta: Record<string, unknown>, finish: string | null, usage = false): string {
  const payload: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'review-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) {
    payload.choices = [];
    payload.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  }
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function startReviewerMock(verdict: 'pass' | 'reject'): { server: Server; port: () => number; reviewerRequests: () => number; dispose: () => Promise<void> } {
  let reviewerRequests = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (data) => (body += data));
    req.on('end', () => {
      const json = JSON.parse(body) as { messages?: { role?: string; content?: unknown }[]; tools?: unknown[] };
      const reviewerRequest = (json.messages ?? []).some((m) => m.role === 'system' && String(m.content).includes('独立代码审核员'));
      if (reviewerRequest) {
        reviewerRequests += 1;
        assert.equal(json.tools?.length ?? 0, 0, 'reviewer must have no tools');
      }
      const responseVerdict = reviewerRequest ? verdict : 'pass';
      const content = JSON.stringify({ verdict: responseVerdict, summary: responseVerdict === 'pass' ? '验收标准均由新增文件直接满足，未发现阻断问题。' : 'src/feature.ts 缺少错误分支处理，请补充并增加回归测试。' });
      let stream = sseChunk(String(reviewerRequests), { role: 'assistant', content: '' }, null);
      stream += sseChunk(String(reviewerRequests), { content }, null);
      stream += sseChunk(String(reviewerRequests), {}, 'stop');
      stream += sseChunk(String(reviewerRequests), {}, null, true);
      stream += 'data: [DONE]\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.end(stream);
    });
  });
  return {
    server,
    port: () => (server.address() as AddressInfo).port,
    reviewerRequests: () => reviewerRequests,
    dispose: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function waitFor(ctx: ReturnType<typeof mkRig>['ctx'], taskId: string, predicate: (task: ReturnType<typeof getTask>) => boolean): Promise<ReturnType<typeof getTask>> {
  for (let i = 0; i < 150; i++) {
    const task = getTask(ctx, taskId);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`task ${taskId} did not reach expected reviewer state; current=${getTask(ctx, taskId).reviewStatus}/${getTask(ctx, taskId).lane}; summary=${getTask(ctx, taskId).reviewSummary}`);
}

test('独立 Reviewer 配置：组引用校验、secret 不回显、删除组自动解绑', async () => {
  const rig = mkRig();
  try {
    const group = createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'secret-review', model: 'review-model' });
    const saved = putOrchestratorSettings(rig.ctx, { reviewerEnabled: true, reviewerGroupId: group.id });
    assert.equal(saved.reviewerEnabled, true);
    assert.equal(saved.reviewerGroupId, group.id);
    assert.equal(JSON.stringify(saved).includes('secret-review'), false);
    assert.equal(saved.groups[0]?.apiKeySet, true);
    assert.throws(() => putOrchestratorSettings(rig.ctx, { reviewerGroupId: 'missing-group' }), /模型组不存在/);
    const app = (await import('../src/http.ts')).createApp(rig.ctx);
    const deleted = await app.request(`/settings/orchestrator/groups/${group.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(getOrchestratorSettings(rig.ctx).reviewerGroupId, null);
  } finally { rig.cleanup(); }
});

test('Reviewer: managed submit queues automatically; legacy submit preserves manual review', () => {
  const rig = mkRig();
  try {
    const workerReg = registerAgent(rig.ctx, { name: 'Worker', handle: 'review-worker' });
    createBoard(rig.ctx, { id: 'managed-review', name: 'Managed', repoMode: 'managed', repoStatus: 'ready' });
    createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'test-key', model: 'review-model' });
    createBoard(rig.ctx, { id: 'legacy-review', name: 'Legacy', repo: 'https://example.invalid/repo.git' });
    putOrchestratorSettings(rig.ctx, { reviewerEnabled: true });

    createTask(rig.ctx, 'managed-review', { id: 'REV-1', title: 'Managed review', lane: 'Ready', acceptance: 'File exists' });
    claimTask(rig.ctx, workerReg.agent, 'REV-1');
    const managed = submitTask(rig.ctx, workerReg.agent, 'REV-1', { summary: 'Done', evidence: [{ path: 'feature.ts' }] });
    assert.equal(managed.lane, 'Review');
    assert.equal(managed.reviewStatus, 'pending');
    assert.equal(managed.reviewAttempts, 0);
    assert.equal(managed.reviewSummary, '');
    assert.equal(managed.submitSummary, 'Done');

    createTask(rig.ctx, 'legacy-review', { id: 'REV-2', title: 'Legacy review', lane: 'Ready' });
    claimTask(rig.ctx, workerReg.agent, 'REV-2');
    const legacy = submitTask(rig.ctx, workerReg.agent, 'REV-2', { summary: 'Done' });
    assert.equal(legacy.reviewStatus, 'none');
    assert.ok(!listEvents(rig.ctx, { type: 'task.review_queued', limit: 10 }).some((e) => e.payload.taskId === 'REV-2'));
  } finally { rig.cleanup(); }
});

test('Reviewer: rejection allows two reworks, third rejection blocks, manual pass requires integration', () => {
  const rig = mkRig();
  try {
    const worker = registerAgent(rig.ctx, { name: 'Worker', handle: 'review-worker-3' }).agent;
    const reviewer = registerAgent(rig.ctx, { name: 'Brain', handle: 'review-brain', role: 'orchestrator' }).agent;
    createBoard(rig.ctx, { id: 'review-board', name: 'Review Board', repoMode: 'managed', repoStatus: 'ready' });
    createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'test-key', model: 'review-model' });
    putOrchestratorSettings(rig.ctx, { reviewerEnabled: true });
    createTask(rig.ctx, 'review-board', { id: 'REV-3', title: 'Review target', lane: 'Ready' });
    claimTask(rig.ctx, worker, 'REV-3');
    submitTask(rig.ctx, worker, 'REV-3', { summary: 'First submission' });

    let claimed = claimTaskForReview(rig.ctx, 'REV-3');
    assert.ok(claimed);
    assert.equal(claimed.reviewStatus, 'reviewing');
    assert.equal(claimed.reviewAttempts, 1);
    assert.throws(() => finalizeTaskReview(rig.ctx, reviewer, 'REV-3', { verdict: 'pass', summary: 'Pass' }), /integrated/);
    assert.equal(finalizeTaskReview(rig.ctx, reviewer, 'REV-3', { verdict: 'reject', summary: 'Fix issue A' }).reviewReworks, 1);

    submitTask(rig.ctx, worker, 'REV-3', { summary: 'Updated once' });
    claimed = claimTaskForReview(rig.ctx, 'REV-3');
    assert.ok(claimed);
    let task = finalizeTaskReview(rig.ctx, reviewer, 'REV-3', { verdict: 'reject', summary: 'Fix issue B' });
    assert.equal(task.reviewReworks, 2);

    submitTask(rig.ctx, worker, 'REV-3', { summary: 'Updated twice' });
    claimed = claimTaskForReview(rig.ctx, 'REV-3');
    assert.ok(claimed);
    task = finalizeTaskReview(rig.ctx, reviewer, 'REV-3', { verdict: 'reject', summary: 'Still broken' });
    assert.equal(task.reviewStatus, 'blocked');
    assert.equal(task.lane, 'Review');
    assert.ok(listMessages(rig.ctx, 'review-board').some((m) => m.content.includes('达到 2 次重做上限')));
  } finally { rig.cleanup(); }
});

test('Reviewer: failed runs require explicit retry and interrupted claims are recovered', () => {
  const rig = mkRig();
  try {
    const worker = registerAgent(rig.ctx, { name: 'Worker', handle: 'review-worker-4' }).agent;
    const reviewer = registerAgent(rig.ctx, { name: 'Brain', handle: 'review-brain-2', role: 'orchestrator' }).agent;
    createBoard(rig.ctx, { id: 'review-recovery', name: 'Review Recovery', repoMode: 'managed', repoStatus: 'ready' });
    createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'test-key', model: 'review-model' });
    putOrchestratorSettings(rig.ctx, { reviewerEnabled: true });
    createTask(rig.ctx, 'review-recovery', { id: 'REV-4', title: 'Review target', lane: 'Ready' });
    claimTask(rig.ctx, worker, 'REV-4');
    submitTask(rig.ctx, worker, 'REV-4', { summary: 'Submitted' });
    assert.ok(claimTaskForReview(rig.ctx, 'REV-4'));
    failTaskReview(rig.ctx, 'REV-4', 'Temporary upstream error');
    assert.equal(getTask(rig.ctx, 'REV-4').reviewStatus, 'failed');
    assert.equal(claimTaskForReview(rig.ctx, 'REV-4'), null);
    retryTaskReview(rig.ctx, reviewer, 'REV-4');
    assert.equal(getTask(rig.ctx, 'REV-4').reviewStatus, 'pending');
    assert.ok(claimTaskForReview(rig.ctx, 'REV-4'));
    assert.equal(recoverReviewerClaims(rig.ctx), 1);
    assert.equal(getTask(rig.ctx, 'REV-4').reviewStatus, 'pending');
  } finally { rig.cleanup(); }
});

test('Reviewer: managed diff endpoint returns bounded diff; legacy mode is rejected', async () => {
  const rig = mkRig();
  try {
    const manager = new RepoManager(rig.ctx);
    const board = createBoard(rig.ctx, { id: 'diff-managed', name: 'Diff Managed', repoMode: 'managed', repoStatus: 'empty' });
    manager.initialize(board.id, 'empty');
    await manager.waitForJob(board.id);
    const root = mkdtempSync(join(tmpdir(), 'review-diff-'));
    try {
      const seed = join(root, 'seed');
      mkdirSync(seed);
      git(['init', '-q', '-b', 'main'], seed);
      writeFileSync(join(seed, 'README.md'), 'base\n');
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'seed'], seed);
      git(['push', '-q', manager.repoPath(board.id), 'main'], seed);
      git(['symbolic-ref', 'HEAD', 'refs/heads/main'], manager.repoPath(board.id));
      const worker = registerAgent(rig.ctx, { name: 'Diff Worker', handle: 'diff-worker' });
      createTask(rig.ctx, board.id, { id: 'DIF-1', title: 'Add feature', lane: 'Ready' });
      claimTask(rig.ctx, worker.agent, 'DIF-1');
      const clone = join(root, 'clone');
      git(['clone', '-q', manager.repoPath(board.id), clone]);
      git(['checkout', '-b', 'asterhive/DIF-1'], clone);
      writeFileSync(join(clone, 'feature.txt'), 'visible diff line\n');
      git(['add', '-A'], clone);
      git(['commit', '-q', '-m', 'feature'], clone);
      const bundle = join(root, 'result.bundle');
      git(['bundle', 'create', bundle, 'asterhive/DIF-1'], clone);
      const bytes = readFileSync(bundle);
      await manager.importTaskResult(board.id, 'DIF-1', [bytes], bytes.length, createHash('sha256').update(bytes).digest('hex'));

      const app = createApp(rig.ctx, manager);
      const authorized = await app.request('/tasks/DIF-1/repo-diff');
      assert.equal(authorized.status, 200);
      const diff = await authorized.json() as { diffText: string; diffTruncated: boolean; changedFiles: string[] };
      assert.match(diff.diffText, /visible diff line/);
      assert.equal(diff.diffTruncated, false);
      assert.ok(diff.changedFiles.includes('feature.txt'));

      const legacy = createBoard(rig.ctx, { id: 'diff-legacy', name: 'Legacy' });
      createTask(rig.ctx, legacy.id, { id: 'DIF-2', title: 'Legacy task' });
      const rejected = await app.request('/tasks/DIF-2/repo-diff');
      assert.equal(rejected.status, 409);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
  } finally { rig.cleanup(); }
});
async function prepareManagedSubmission(rig: ReturnType<typeof mkRig>, boardId: string, taskId: string): Promise<{ manager: RepoManager; worker: ReturnType<typeof registerAgent>['agent'] }> {
  const workerReg = registerAgent(rig.ctx, { name: 'Worker', handle: `worker-${taskId.toLowerCase()}` });
  const manager = new RepoManager(rig.ctx);
  createBoard(rig.ctx, { id: boardId, name: boardId, repoMode: 'managed', repoStatus: 'empty' });
  manager.initialize(boardId, 'empty');
  await manager.waitForJob(boardId);
  const root = mkdtempSync(join(tmpdir(), `review-seed-${taskId}-`));
  try {
    const bare = manager.repoPath(boardId);
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'README.md'), '# Seed\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['push', '-q', bare, 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
    const sourceHead = git(['rev-parse', 'HEAD'], seed);
    const { setBoardRepoState } = await import('../src/tasks.ts');
    setBoardRepoState(rig.ctx, boardId, { status: 'ready', head: sourceHead });

    createTask(rig.ctx, boardId, { id: taskId, title: 'Add feature', lane: 'Ready', acceptance: 'feature.txt contains expected text' });
    claimTask(rig.ctx, workerReg.agent, taskId);
    const cloneDir = join(root, 'worker');
    git(['clone', '-q', bare, cloneDir]);
    git(['checkout', '-b', `asterhive/${taskId}`], cloneDir);
    writeFileSync(join(cloneDir, 'feature.txt'), 'expected text\n');
    git(['add', '-A'], cloneDir);
    git(['commit', '-q', '-m', `asterhive(${taskId}): add feature`], cloneDir);
    const bundle = join(root, 'result.bundle');
    git(['bundle', 'create', bundle, `asterhive/${taskId}`], cloneDir);
    const bytes = readFileSync(bundle);
    await manager.importTaskResult(boardId, taskId, [bytes], bytes.length, createHash('sha256').update(bytes).digest('hex'));
    return { manager, worker: workerReg.agent };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}


test('审核后 Diff 固定到任务基线：已合并任务仍保留原始代码差异', async () => {
  const rig = mkRig();
  try {
      const manager = new RepoManager(rig.ctx);
      createBoard(rig.ctx, { id: 'diff-after-merge', name: 'Diff After Merge', repoMode: 'managed', repoStatus: 'empty' });
      const reviewerGroup = createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'test-key', model: 'review-model' });
      putOrchestratorSettings(rig.ctx, { reviewerEnabled: true, reviewerGroupId: reviewerGroup.id });
      manager.initialize('diff-after-merge', 'empty');
    await manager.waitForJob('diff-after-merge');
    const root = mkdtempSync(join(tmpdir(), 'diff-after-merge-'));
    try {
      const bare = manager.repoPath('diff-after-merge');
      const seed = join(root, 'seed');
      mkdirSync(seed);
      git(['init', '-q', '-b', 'main'], seed);
      writeFileSync(join(seed, 'README.md'), 'base\n');
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'seed'], seed);
      git(['push', '-q', bare, 'main'], seed);
      git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
      const baseCommit = git(['rev-parse', 'HEAD'], seed);
      const { setBoardRepoState } = await import('../src/tasks.ts');
      setBoardRepoState(rig.ctx, 'diff-after-merge', { status: 'ready', head: baseCommit });
      await manager.exportTaskSnapshot('diff-after-merge', 'DIF-3');

      const workerDir = join(root, 'worker');
      git(['clone', '-q', bare, workerDir]);
      git(['checkout', '-b', 'asterhive/DIF-3'], workerDir);
      writeFileSync(join(workerDir, 'feature.ts'), 'export const diffSurvivesMerge = true;\n');
      git(['add', '-A'], workerDir);
      git(['commit', '-q', '-m', 'feature'], workerDir);
      const bundle = join(root, 'result.bundle');
      git(['bundle', 'create', bundle, 'asterhive/DIF-3'], workerDir);
      const bytes = readFileSync(bundle);
      await manager.importTaskResult('diff-after-merge', 'DIF-3', [bytes], bytes.length, createHash('sha256').update(bytes).digest('hex'));

      const worker = registerAgent(rig.ctx, { name: 'Worker', handle: 'diff-worker' }).agent;
      const task = createTask(rig.ctx, 'diff-after-merge', { id: 'DIF-3', title: 'Show diff after merge', lane: 'Ready' });
      claimTask(rig.ctx, worker, task.id);
      submitTask(rig.ctx, worker, task.id, { summary: 'Added feature' });
      assert.ok(claimTaskForReview(rig.ctx, task.id));
      const reviewer = registerAgent(rig.ctx, { name: 'Reviewer', handle: 'diff-reviewer', role: 'orchestrator' }).agent;
      await manager.integrateTask('diff-after-merge', task.id);
      const result = await manager.inspectTask('diff-after-merge', task.id);
      assert.equal(result.base, baseCommit);
      assert.match(result.diffText, /diffSurvivesMerge/);
      finalizeTaskReview(rig.ctx, reviewer, task.id, { verdict: 'pass', summary: 'The committed diff is present.' }, { integrated: true });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  } finally { rig.cleanup(); }
});
test('内置 Pi Reviewer 自动双盲审核并在 Pass 后合并到服务器默认分支', async () => {
  const rig = mkRig();
  const mock = startReviewerMock('pass');
  const brain = new Brain(rig.ctx, new PiRuntimeManager(rig.ctx));
  try {
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const { manager, worker } = await prepareManagedSubmission(rig, 'review-e2e', 'REV-10');
    const group = createOrchestratorGroup(rig.ctx, { name: 'review-model', baseURL: `http://127.0.0.1:${mock.port()}/v1`, apiKey: 'review-secret', model: 'review-model' });
    putOrchestratorSettings(rig.ctx, { enabled: true, reviewerEnabled: true, reviewerGroupId: group.id });
    brain.start();
    submitTask(rig.ctx, worker, 'REV-10', { summary: 'Added feature.txt containing expected text.' });
    const completed = await waitFor(rig.ctx, 'REV-10', (task) => task.lane === 'Done');
    assert.equal(mock.reviewerRequests(), 1);
    const mainHead = git(['rev-parse', 'refs/heads/main'], manager.repoPath('review-e2e'));
    const taskRef = git(['rev-parse', 'refs/asterhive/tasks/REV-10'], manager.repoPath('review-e2e'));
    assert.notEqual(mainHead, taskRef, 'integration should create a merge commit on the default branch');
    assert.equal(completed.reviewStatus, 'passed');
    assert.ok(listEvents(rig.ctx, { type: 'repo.task_integrated', limit: 5 }).some((e) => e.payload.taskId === 'REV-10'));
  } finally {
    brain.stop();
    await mock.dispose();
    rig.cleanup();
  }
});
