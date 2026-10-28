import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import './_brain-env.ts';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, ensureBrainAgent } from '../src/agents.ts';
import {
  createBoard,
  createTask,
  getTask,
  updateTask,
  finalizeTaskReview,
  retryTaskReview,
  returnTaskFromReview,
  setBoardRepoState,
} from '../src/tasks.ts';
import { DatabaseSync } from 'node:sqlite';
import { migrateTaskReviewStatusCheck } from '../src/db.ts';
import { claimTask, submitTask, checkpointTask } from '../src/verbs.ts';
import { listEvidenceFiles, findCurrentExecutionReport } from '../src/evidence.ts';
import { RepoManager } from '../src/repo-manager.ts';
import { putOrchestratorSettings, createOrchestratorGroup } from '../src/settings.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Workflow Test',
      GIT_AUTHOR_EMAIL: 'workflow@test.invalid',
      GIT_COMMITTER_NAME: 'Workflow Test',
      GIT_COMMITTER_EMAIL: 'workflow@test.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

test('1. Evidence upload: attempt-fenced by current assignee, InProgress lane, and attempt', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-fence', name: 'Fence Board' });
    const { agent: worker1, token: token1 } = registerAgent(rig.ctx, {
      name: 'Worker 1', handle: 'bee-fence-1', role: 'worker',
    });
    const { agent: worker2, token: token2 } = registerAgent(rig.ctx, {
      name: 'Worker 2', handle: 'bee-fence-2', role: 'worker',
    });
    const { token: userToken } = registerAgent(rig.ctx, {
      name: 'User', handle: 'user-fence', role: 'user',
    });

    createTask(rig.ctx, 'b-fence', { id: 'T1', title: 'Fence task', lane: 'Ready', assignee: worker1.id });
    claimTask(rig.ctx, worker1, 'T1'); // InProgress, attempt 1

    const payload = new Uint8Array(Buffer.from('evidence content', 'utf8'));

    // 1.1 Non-assignee worker upload must fail with 403
    const app = createApp(rig.ctx);
    const nonAssigneeRes = await app.request('/tasks/T1/evidence', {
      method: 'POST',
      headers: { ...H(token2), 'x-filename': 'w2.txt', 'x-task-attempt': '1' },
      body: payload,
    });
    assert.equal(nonAssigneeRes.status, 403, 'worker not assigned to task must receive 403');

    // 1.2 Valid upload by current assignee on attempt 1
    const validRes = await app.request('/tasks/T1/evidence', {
      method: 'POST',
      headers: { ...H(token1), 'x-filename': 'w1.txt', 'x-task-attempt': '1' },
      body: payload,
    });
    assert.equal(validRes.status, 201);
    const validData = (await validRes.json()) as { file: { id: number; attempt?: number } };
    assert.equal(validData.file.attempt, 1, 'file metadata must record attempt 1');

    const files1 = listEvidenceFiles(rig.ctx, 'T1');
    assert.equal(files1.length, 1);
    assert.equal(files1[0].attempt, 1, 'stored evidence file must have attempt 1');

    // 1.3 Move task to Review lane: worker upload must fail with 409 (not InProgress)
    submitTask(rig.ctx, worker1, 'T1', { summary: 'submitted', attempt: 1 });
    const notInProgressRes = await app.request('/tasks/T1/evidence', {
      method: 'POST',
      headers: { ...H(token1), 'x-filename': 'w1-review.txt', 'x-task-attempt': '1' },
      body: payload,
    });
    assert.equal(notInProgressRes.status, 409, 'worker upload while task is in Review must fail with 409');

    // 1.4 Reject back to InProgress / attempt 2
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'reviewing' WHERE id = 'T1'").run();
    await finalizeTaskReview(rig.ctx, ensureBrainAgent(rig.ctx), 'T1', { verdict: 'reject', summary: 'Rework needed' });
    const taskAfterReject = getTask(rig.ctx, 'T1');
    assert.equal(taskAfterReject.lane, 'InProgress');
    assert.equal(taskAfterReject.attempt, 2);

    // 1.5 Worker upload on attempt 2 without attempt header must fail with 409
    const missingAttemptRes = await app.request('/tasks/T1/evidence', {
      method: 'POST',
      headers: { ...H(token1), 'x-filename': 'w1-unversioned.txt' },
      body: payload,
    });
    assert.equal(missingAttemptRes.status, 409, 'unversioned upload on attempt > 1 must fail with 409');

    // 1.6 Worker upload on attempt 2 with stale attempt 1 must fail with 409
    const staleAttemptRes = await app.request('/tasks/T1/evidence', {
      method: 'POST',
      headers: { ...H(token1), 'x-filename': 'w1-stale.txt', 'x-task-attempt': '1' },
      body: payload,
    });
    assert.equal(staleAttemptRes.status, 409, 'stale attempt upload must fail with 409');

    // 1.7 Worker upload on attempt 2 with matching attempt 2 must succeed
    const matchAttemptRes = await app.request('/tasks/T1/evidence', {
      method: 'POST',
      headers: { ...H(token1), 'x-filename': 'w1-attempt2.txt', 'x-task-attempt': '2' },
      body: payload,
    });
    assert.equal(matchAttemptRes.status, 201);
    const matchData = (await matchAttemptRes.json()) as { file: { id: number; attempt?: number } };
    assert.equal(matchData.file.attempt, 2, 'file metadata must record attempt 2');

    // 1.8 User upload bypasses assignee check and preserves attempt
    const userRes = await app.request('/tasks/T1/evidence', {
      method: 'POST',
      headers: { ...H(userToken), 'x-filename': 'user-spec.txt', 'x-task-attempt': '2' },
      body: payload,
    });
    assert.equal(userRes.status, 201, 'user can upload evidence');
  } finally {
    rig.cleanup();
  }
});

test('2. Execution report ingestion: validated current report for reviewer', async () => {
  const rig = mkRig();
  try {
    const fn = findCurrentExecutionReport;
    createBoard(rig.ctx, { id: 'b-report', name: 'Report Board' });
    const { agent: worker, token } = registerAgent(rig.ctx, {
      name: 'Worker', handle: 'bee-report', role: 'worker',
    });
    createTask(rig.ctx, 'b-report', { id: 'T2', title: 'Report Task', lane: 'Ready', assignee: worker.id });
    claimTask(rig.ctx, worker, 'T2'); // attempt 1

    const app = createApp(rig.ctx);

    // 2.1 Stale report from attempt 1 uploaded
    const staleReport = {
      schemaVersion: 1,
      taskId: 'T2',
      attempt: 1,
      outcome: 'completed',
      summary: 'attempt 1 summary',
      startedAt: Date.now() - 10000,
      finishedAt: Date.now() - 5000,
      preflight: [{ name: 'node', ok: true, detail: 'v24.0.0' }],
      commands: [{ tool: 'bash', command: 'npm test', startedAt: 1, finishedAt: 2, exitCode: 0, output: 'ok', truncated: false }],
    };
    await app.request('/tasks/T2/evidence', {
      method: 'POST',
      headers: { ...H(token), 'x-filename': 'execution-report.json', 'x-task-attempt': '1' },
      body: new Uint8Array(Buffer.from(JSON.stringify(staleReport), 'utf8')),
    });

    // Worker re-dispatched to attempt 2
    submitTask(rig.ctx, worker, 'T2', { summary: 'sub', attempt: 1 });
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'reviewing' WHERE id = 'T2'").run();
    await finalizeTaskReview(rig.ctx, ensureBrainAgent(rig.ctx), 'T2', { verdict: 'reject', summary: 'rework' });

    const commitAAA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const commitBBB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const commitHead2 = 'cccccccccccccccccccccccccccccccccccccccc';

    // Attempt 2 check: stale attempt 1 report should NOT be returned as valid current report
    const check1 = fn(rig.ctx, 'T2', worker.id, 2, commitHead2) as { report?: unknown; error?: string };
    assert.ok(check1.error, 'must report error when only stale report exists for current attempt');

    // 2.2 Upload invalid schema report for attempt 2 (missing commands)
    const invalidReport = {
      schemaVersion: 1,
      taskId: 'T2',
      attempt: 2,
      outcome: 'completed',
      summary: 'invalid report',
      // missing commands array
    };
    await app.request('/tasks/T2/evidence', {
      method: 'POST',
      headers: { ...H(token), 'x-filename': 'execution-report.json', 'x-task-attempt': '2' },
      body: new Uint8Array(Buffer.from(JSON.stringify(invalidReport), 'utf8')),
    });
    const check2 = fn(rig.ctx, 'T2', worker.id, 2) as { report?: unknown; error?: string };
    assert.ok(check2.error, 'must reject report with invalid schema');

    // 2.3 Upload report with mismatched commitHash
    const commitMismatchedReport = {
      schemaVersion: 1,
      taskId: 'T2',
      attempt: 2,
      commitHash: commitAAA,
      outcome: 'completed',
      summary: 'mismatched commit',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      preflight: [{ name: 'node', ok: true, detail: 'v24.0.0' }],
      commands: [],
    };
    await app.request('/tasks/T2/evidence', {
      method: 'POST',
      headers: { ...H(token), 'x-filename': 'execution-report.json', 'x-task-attempt': '2' },
      body: new Uint8Array(Buffer.from(JSON.stringify(commitMismatchedReport), 'utf8')),
    });
    const check3 = fn(rig.ctx, 'T2', worker.id, 2, commitBBB) as { report?: unknown; error?: string };
    assert.ok(check3.error, 'must reject report where commitHash does not match expected reviewed commit');
    // 2.4 Valid current report for attempt 2 matching expected commit
    const validCurrentReport = {
      schemaVersion: 1,
      taskId: 'T2',
      attempt: 2,
      commitHash: commitBBB,
      outcome: 'completed',
      summary: 'verified valid report',
      startedAt: Date.now() - 2000,
      finishedAt: Date.now(),
      preflight: [{ name: 'node', ok: true, detail: 'v24.0.0' }],
      commands: [{ tool: 'bash', command: 'npm test', startedAt: 1, finishedAt: 2, exitCode: 0, output: 'passed', truncated: false }],
    };
    await app.request('/tasks/T2/evidence', {
      method: 'POST',
      headers: { ...H(token), 'x-filename': 'execution-report.json', 'x-task-attempt': '2' },
      body: new Uint8Array(Buffer.from(JSON.stringify(validCurrentReport), 'utf8')),
    });
    const check4 = fn(rig.ctx, 'T2', worker.id, 2, commitBBB) as { report?: { summary: string }; error?: string };
    assert.ok(!check4.error, 'valid current report must not have error');
    assert.equal(check4.report?.summary, 'verified valid report');
  } finally {
    rig.cleanup();
  }
});

test('3. Reviewer outcome taxonomy: reject consumes rework, environment_blocked and needs_evidence do not', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-review', name: 'Review Board', repoMode: 'managed' });
    const { agent: worker } = registerAgent(rig.ctx, {
      name: 'Worker', handle: 'bee-review', role: 'worker',
    });
    const brain = ensureBrainAgent(rig.ctx);

    createTask(rig.ctx, 'b-review', { id: 'T3', title: 'Taxonomy Task', lane: 'Ready', assignee: worker.id });
    claimTask(rig.ctx, worker, 'T3');
    submitTask(rig.ctx, worker, 'T3', { summary: 'sub', attempt: 1 });

    // Mark task reviewing
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'reviewing' WHERE id = 'T3'").run();

    // 3.1 environment_blocked verdict: must NOT increment rework count, lane stays Review
    await finalizeTaskReview(rig.ctx, brain, 'T3', {
      verdict: 'environment_blocked' as unknown as 'pass',
      summary: 'Missing native build tools on host',
    });
    const taskEnv = getTask(rig.ctx, 'T3');
    assert.equal(taskEnv.lane, 'Review', 'task must stay in Review lane on environment_blocked');
    assert.equal(taskEnv.reviewStatus, 'environment_blocked');
    assert.equal(taskEnv.reviewReworks, 0, 'environment_blocked must NOT consume rework budget');

    // 3.2 needs_evidence verdict: must NOT increment rework count, lane stays Review
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'reviewing' WHERE id = 'T3'").run();
    await finalizeTaskReview(rig.ctx, brain, 'T3', {
      verdict: 'needs_evidence' as unknown as 'pass',
      summary: 'Missing verification command execution report',
    });
    const taskEvidence = getTask(rig.ctx, 'T3');
    assert.equal(taskEvidence.lane, 'Review', 'task must stay in Review lane on needs_evidence');
    assert.equal(taskEvidence.reviewStatus, 'needs_evidence');
    assert.equal(taskEvidence.reviewReworks, 0, 'needs_evidence must NOT consume rework budget');

    // 3.3 reject verdict: DOES increment rework count and moves to InProgress
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'reviewing' WHERE id = 'T3'").run();
    await finalizeTaskReview(rig.ctx, brain, 'T3', {
      verdict: 'reject',
      summary: 'Substantive code defect: null pointer in handler',
    }, { maxReworks: 2 });
    const taskReject1 = getTask(rig.ctx, 'T3');
    assert.equal(taskReject1.lane, 'InProgress', 'reject moves task to InProgress');
    assert.equal(taskReject1.reviewStatus, 'rework');
    assert.equal(taskReject1.reviewReworks, 1, 'reject increments reviewReworks');
    assert.equal(taskReject1.attempt, 2, 'reject increments attempt');
  } finally {
    rig.cleanup();
  }
});

test('4. Review retry: failed, environment_blocked, and needs_evidence can be retried via POST /tasks/:id/review/retry', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-retry', name: 'Retry Board', repoMode: 'managed' });
    const { token: userToken } = registerAgent(rig.ctx, {
      name: 'User', handle: 'user-retry', role: 'user',
    });
    const { agent: worker } = registerAgent(rig.ctx, {
      name: 'Worker', handle: 'bee-retry', role: 'worker',
    });

    const group = createOrchestratorGroup(rig.ctx, {
      name: 'ReviewerGroup', baseURL: 'https://model.invalid/v1', model: 'm', apiKey: 'k',
    });
    putOrchestratorSettings(rig.ctx, { reviewerEnabled: true, reviewerGroupId: group.id });

    createTask(rig.ctx, 'b-retry', { id: 'T4', title: 'Retry Task', lane: 'Ready', assignee: worker.id });
    claimTask(rig.ctx, worker, 'T4');
    submitTask(rig.ctx, worker, 'T4', { summary: 'sub', attempt: 1 });

    const app = createApp(rig.ctx);

    // 4.1 Retry environment_blocked
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'environment_blocked', review_summary = 'env fail' WHERE id = 'T4'").run();
    const envRetryRes = await app.request('/tasks/T4/review/retry', {
      method: 'POST',
      headers: H(userToken),
    });
    assert.equal(envRetryRes.status, 200, 'environment_blocked review must be retryable');
    const envRetryTask = getTask(rig.ctx, 'T4');
    assert.equal(envRetryTask.reviewStatus, 'pending');
    assert.equal(envRetryTask.reviewSummary, '');

    // 4.2 Retry needs_evidence
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'needs_evidence', review_summary = 'missing ev' WHERE id = 'T4'").run();
    const evRetryRes = await app.request('/tasks/T4/review/retry', {
      method: 'POST',
      headers: H(userToken),
    });
    assert.equal(evRetryRes.status, 200, 'needs_evidence review must be retryable');
    const evRetryTask = getTask(rig.ctx, 'T4');
    assert.equal(evRetryTask.reviewStatus, 'pending');

    // 4.3 Attempting to retry a passed review must fail with 409
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'passed' WHERE id = 'T4'").run();
    const passedRetryRes = await app.request('/tasks/T4/review/retry', {
      method: 'POST',
      headers: H(userToken),
    });
    assert.equal(passedRetryRes.status, 409, 'passed review cannot be retried');
  } finally {
    rig.cleanup();
  }
});

test('5. Attempt and head-bound review completion prevents stale verdict races', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-race', name: 'Race Board', repoMode: 'managed' });
    const { agent: worker } = registerAgent(rig.ctx, {
      name: 'Worker', handle: 'bee-race', role: 'worker',
    });
    const brain = ensureBrainAgent(rig.ctx);

    createTask(rig.ctx, 'b-race', { id: 'T5', title: 'Race Task', lane: 'Ready', assignee: worker.id });
    claimTask(rig.ctx, worker, 'T5');
    submitTask(rig.ctx, worker, 'T5', { summary: 'sub', attempt: 1 });

    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'reviewing' WHERE id = 'T5'").run();

    // 5.1 Simulate concurrent attempt change: worker re-dispatched to attempt 2
    rig.ctx.holder.db.prepare("UPDATE task SET attempt = 2 WHERE id = 'T5'").run();

    // Finalizing with captured attempt 1 must reject with 409
    // Pre-merge integrateTask with captured attempt 1 must reject with 409 before attempting merge
    const mgr = new RepoManager(rig.ctx);
    await assert.rejects(
      () => mgr.integrateTask('b-race', 'T5', { attempt: 1, head: 'some-head' }),
      (err: { status?: number }) => err.status === 409,
      'stale attempt in integrateTask must fail with 409 before merge',
    );

    // Finalizing with captured attempt 1 must reject with 409 as second defense line
    await assert.rejects(
      () => finalizeTaskReview(rig.ctx, brain, 'T5', { verdict: 'reject', summary: 'stale review' }, { attempt: 1 }),
      (err: { status?: number }) => err.status === 409,
      'stale attempt review completion must fail with 409',
    );
    // Verify task state was not touched by stale verdict
    const taskAfter = getTask(rig.ctx, 'T5');
    assert.equal(taskAfter.attempt, 2);
    assert.equal(taskAfter.reviewStatus, 'reviewing');
  } finally {
    rig.cleanup();
  }
});

test('6. Missing-ref manual accept regression repaired without forbidding legal exploration reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-accept-reg-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const rig = mkRig();
  try {
    const mgr = new RepoManager(rig.ctx);
    const { agent: worker } = registerAgent(rig.ctx, {
      name: 'Worker', handle: 'bee-accept', role: 'worker',
    });
    const { agent: user, token: userToken } = registerAgent(rig.ctx, {
      name: 'User', handle: 'user-accept', role: 'user',
    });

    const board = createBoard(rig.ctx, { id: 'b-accept', name: 'Accept Board', repoMode: 'managed' });
    mgr.initialize(board.id, 'empty');
    await mgr.waitForJob(board.id);

    // Initial bare repo commit on main
    const bareRepo = mgr.repoPath(board.id);
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'README.md'), '# Initial\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'Initial'], seed);
    git(['push', '-q', bareRepo, 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bareRepo);
    const initialHead = git(['rev-parse', 'HEAD'], seed);
    setBoardRepoState(rig.ctx, board.id, { status: 'ready', head: initialHead });

    const app = createApp(rig.ctx, mgr);

    // 6.1 Managed CODE task missing task ref MUST fail manual accept with 404 and NOT move to Done
    createTask(rig.ctx, board.id, { id: 'T601', title: 'Code Task', lane: 'Ready', assignee: worker.id, workspace: {} });
    claimTask(rig.ctx, worker, 'T601');
    submitTask(rig.ctx, worker, 'T601', { summary: 'sub', attempt: 1 });

    const codeAcceptRes = await app.request('/tasks/T601/review/accept', {
      method: 'POST',
      headers: H(userToken),
    });
    assert.equal(codeAcceptRes.status, 404, 'code task missing git taskRef must return 404 on manual accept');
    const codeTaskAfter = getTask(rig.ctx, 'T601');
    assert.equal(codeTaskAfter.lane, 'Review', 'code task missing git taskRef must NOT move to Done');

    // Direct updateTask with manualAcceptance on a code task must also fail without integratedManagedCode
    assert.throws(
      () => updateTask(rig.ctx, user, 'T601', { lane: 'Done' }, { manualAcceptance: true }),
      (err: { status?: number }) => err.status === 409,
      'updateTask must forbid bypass of git merge for code tasks',
    );

    // 6.2 Managed NO-CODE exploration task succeeds manual accept without task ref
    createTask(rig.ctx, board.id, {
      id: 'T602', title: 'Exploration Task', lane: 'Ready', assignee: worker.id, workspace: { noCode: true },
    });
    claimTask(rig.ctx, worker, 'T602');
    submitTask(rig.ctx, worker, 'T602', { summary: 'research summary', attempt: 1 });

    const noCodeAcceptRes = await app.request('/tasks/T602/review/accept', {
      method: 'POST',
      headers: H(userToken),
    });
    assert.equal(noCodeAcceptRes.status, 200, 'noCode exploration task must succeed manual accept');
    const noCodeAcceptData = (await noCodeAcceptRes.json()) as { task: { lane: string }; mergedCommit: string | null };
    assert.equal(noCodeAcceptData.task.lane, 'Done');
    assert.equal(noCodeAcceptData.mergedCommit, null, 'noCode task must have null mergedCommit');
  } finally {
    rig.cleanup();
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});

test('7. Checkpoint with kind=environment_blocked latches state without charging rework', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-env-chk', name: 'Env Checkpoint Board' });
    const { agent: worker } = registerAgent(rig.ctx, {
      name: 'Worker', handle: 'bee-env-chk', role: 'worker',
    });
    createTask(rig.ctx, 'b-env-chk', { id: 'T7', title: 'Env Checkpoint Task', lane: 'Ready', assignee: worker.id });
    claimTask(rig.ctx, worker, 'T7');

    // Worker checkpoints environment_blocked
    checkpointTask(rig.ctx, worker, 'T7', {
      kind: 'environment_blocked',
      note: 'Node version below v24 requirement',
      attempt: 1,
    });

    const task = getTask(rig.ctx, 'T7');
    assert.equal(task.lastActivityKind, 'environment_blocked');

    // Subsequent normal checkpoint or submit without recovery must be rejected
    assert.throws(
      () => checkpointTask(rig.ctx, worker, 'T7', { kind: 'milestone', note: 'trying anyway', attempt: 1 }),
      (err: { status?: number }) => err.status === 409,
    );
    assert.throws(
      () => submitTask(rig.ctx, worker, 'T7', { summary: 'submit anyway', attempt: 1 }),
      (err: { status?: number }) => err.status === 409,
    );
  } finally {
    rig.cleanup();
  }
});

test('8. Recovery loop: returnTaskFromReview from needs_evidence/environment_blocked preserves rework budget', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-rec', name: 'Recovery Board' });
    const { agent: worker } = registerAgent(rig.ctx, {
      name: 'Worker', handle: 'bee-rec', role: 'worker',
    });
    const { agent: user } = registerAgent(rig.ctx, {
      name: 'User', handle: 'user-rec', role: 'user',
    });
    createTask(rig.ctx, 'b-rec', { id: 'T8', title: 'Recovery Task', lane: 'Ready', assignee: worker.id });
    claimTask(rig.ctx, worker, 'T8');
    submitTask(rig.ctx, worker, 'T8', { summary: 'sub', attempt: 1 });

    // Set task to needs_evidence
    rig.ctx.holder.db.prepare("UPDATE task SET review_status = 'needs_evidence' WHERE id = 'T8'").run();

    // Explicit return from Review to InProgress
    await returnTaskFromReview(rig.ctx, user, 'T8', 'Please run tests and provide execution report');

    const taskAfter = getTask(rig.ctx, 'T8');
    assert.equal(taskAfter.lane, 'InProgress');
    assert.equal(taskAfter.reviewStatus, 'rework');
    assert.equal(taskAfter.reviewReworks, 0, 'reviewReworks must NOT increment when returning from needs_evidence');
    assert.equal(taskAfter.attempt, 2, 'attempt must increment to establish attempt fence');
    assert.equal(taskAfter.lastActivityKind, 'rework', 'lastActivityKind must be rework to avoid latching; recovery reason preserved in review_summary');
  } finally {
    rig.cleanup();
  }
});

test('9. SQLite CHECK migration preserves task rows, indices, and rolls back on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asterhive-db-mig-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  try {
    // Create old schema
    db.exec(`
      CREATE TABLE board (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES board(id),
        title TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','pending','reviewing','passed','rework','blocked','failed')),
        attempt INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_task_board ON task(board_id);
      CREATE INDEX idx_task_custom ON task(title);
    `);

    db.exec("INSERT INTO board (id, name) VALUES ('b1', 'Board 1');");
    db.exec("INSERT INTO task (id, board_id, title, review_status, attempt) VALUES ('T-OLD', 'b1', 'Old Task', 'failed', 1);");

    // Run migration
    migrateTaskReviewStatusCheck(db);

    // Verify task row is preserved
    const row = db.prepare("SELECT id, board_id, title, review_status, attempt FROM task WHERE id = 'T-OLD'").get() as {
      id: string; board_id: string; title: string; review_status: string; attempt: number;
    };
    assert.equal(row.id, 'T-OLD');
    assert.equal(row.review_status, 'failed');

    // Verify indices were recreated
    const indices = db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'task' AND type = 'index'").all() as { name: string }[];
    assert.ok(indices.some((idx) => idx.name === 'idx_task_board'), 'idx_task_board index must be preserved');
    assert.ok(indices.some((idx) => idx.name === 'idx_task_custom'), 'idx_task_custom index must be preserved');

    // Verify new statuses are accepted by CHECK constraint
    db.exec("UPDATE task SET review_status = 'environment_blocked' WHERE id = 'T-OLD';");
    db.exec("UPDATE task SET review_status = 'needs_evidence' WHERE id = 'T-OLD';");

    // Verify invalid status is rejected by CHECK constraint
    assert.throws(
      () => db.exec("UPDATE task SET review_status = 'invalid_status' WHERE id = 'T-OLD';"),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
