import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { registerAgent } from '../src/agents.ts';
import { createBoard, createTask, getTask, listTasks, cancelTask, claimTaskForReview, finalizeTaskReview } from '../src/tasks.ts';
import { claimTask, submitTask } from '../src/verbs.ts';
import { createOrchestratorGroup, putOrchestratorSettings } from '../src/settings.ts';
import { dispatchTask } from '../src/messages.ts';
import { withTaskIntegrationLock } from '../src/task-integration-lock.ts';

test('explicit cancellation persists history, hides task from board lists, and blocks worker/review actions', async () => {
  const rig = mkRig();
  const user = registerAgent(rig.ctx, { id: 'user', name: '老板', handle: 'boss', role: 'user' }).agent;
  try {
    const board = createBoard(rig.ctx, { id: 'cancel-board', name: 'Cancel', repo: '' });
    const worker = registerAgent(rig.ctx, { id: 'worker-cancel', name: 'Worker', handle: 'worker-cancel', role: 'worker' }).agent;
    createTask(rig.ctx, board.id, { id: 'CAN-1', title: 'Cancel me', lane: 'Ready', assignee: worker.id });
    rig.ctx.holder.db.prepare("UPDATE task SET evidence='[{\"path\":\"proof.txt\",\"note\":\"kept\"}]' WHERE id='CAN-1'").run();
    claimTask(rig.ctx, worker, 'CAN-1');
    const cancelled = await cancelTask(rig.ctx, user, 'CAN-1', '用户决定停止');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(getTask(rig.ctx, 'CAN-1').evidence[0]?.path, 'proof.txt');
    assert.throws(() => dispatchTask(rig.ctx, user, 'CAN-1', { content: '@worker 已取消' }), /cancelled/i);
    assert.deepEqual(listTasks(rig.ctx, board.id), []);
    assert.throws(() => claimTask(rig.ctx, worker, 'CAN-1'), /cancelled/i);
  } finally { rig.cleanup(); }
});

test('cancelled reviewer completion cannot finalize or release dependencies', async () => {
  const rig = mkRig();
  try {
    const user = registerAgent(rig.ctx, { id: 'cancel-user', name: '老板', handle: 'boss-cancel', role: 'user' }).agent;
    const board = createBoard(rig.ctx, { id: 'cancel-review', name: 'Review', repoMode: 'managed', repoStatus: 'ready' });
    const worker = registerAgent(rig.ctx, { id: 'cancel-review-worker', name: 'Worker', handle: 'cancel-review-worker', role: 'worker' }).agent;
    createOrchestratorGroup(rig.ctx, { name: 'review', baseURL: 'https://review.invalid/v1', apiKey: 'test-key', model: 'review-model' });
    putOrchestratorSettings(rig.ctx, { reviewerEnabled: true });
    createTask(rig.ctx, board.id, { id: 'CAN-2', title: 'Review task', lane: 'Ready', assignee: worker.id });
    const dep = createTask(rig.ctx, board.id, { id: 'CAN-3', title: 'Dependent', lane: 'Backlog', dependsOn: ['CAN-2'] });
    claimTask(rig.ctx, worker, 'CAN-2');
    const submitted = submitTask(rig.ctx, worker, 'CAN-2', { summary: 'submitted for review' });
    assert.equal(submitted.reviewStatus, 'pending');
    assert.ok(claimTaskForReview(rig.ctx, 'CAN-2'));
    await cancelTask(rig.ctx, user, 'CAN-2', '停止审核');
    assert.throws(() => finalizeTaskReview(rig.ctx, user, 'CAN-2', { verdict: 'pass', summary: 'ok' }, { integrated: true }), /cancelled/i);
    assert.equal(getTask(rig.ctx, 'CAN-2').lane, 'Review');
    assert.equal(getTask(rig.ctx, 'CAN-3').lane, 'Backlog');
    assert.equal(dep.autoUnblockedAt, null);
  } finally { rig.cleanup(); }
});

test('cancellation waits for in-flight integration critical section', async () => {
  const rig = mkRig();
  const user = registerAgent(rig.ctx, { id: 'cancel-user-race', name: '老板', handle: 'boss-race', role: 'user' }).agent;
  try {
    const board = createBoard(rig.ctx, { id: 'cancel-race', name: 'Race', repo: '' });
    createTask(rig.ctx, board.id, { id: 'CAN-4', title: 'Integrating', lane: 'Review' });
    const { promise, resolve } = Promise.withResolvers<void>();
    const integration = withTaskIntegrationLock('CAN-4', async () => { await promise; });
    await Promise.resolve();
    let cancelled = false;
    const cancellation = cancelTask(rig.ctx, user, 'CAN-4', 'stop').then(() => { cancelled = true; });
    await Promise.resolve();
    assert.equal(cancelled, false);
    resolve();
    await Promise.all([integration, cancellation]);
    assert.equal(getTask(rig.ctx, 'CAN-4').status, 'cancelled');
  } finally { rig.cleanup(); }
});

test('cancelled tasks do not consume WIP capacity or satisfy dependencies', async () => {
  const rig = mkRig();
  const user = registerAgent(rig.ctx, { id: 'cancel-user-wip', name: '老板', handle: 'boss-wip', role: 'user' }).agent;
  try {
    const board = createBoard(rig.ctx, { id: 'cancel-wip', name: 'Capacity', wip: { InProgress: 1 } });
    createTask(rig.ctx, board.id, { id: 'CAN-5', title: 'Cancelled occupant', lane: 'InProgress' });
    await cancelTask(rig.ctx, user, 'CAN-5', 'free slot');
    const active = createTask(rig.ctx, board.id, { id: 'CAN-6', title: 'Replacement', lane: 'InProgress' });
    assert.equal(active.status, 'active');
    createTask(rig.ctx, board.id, { id: 'CAN-7', title: 'Previously done', lane: 'Done' });
    await cancelTask(rig.ctx, user, 'CAN-7', 'cancel dependency');
    assert.throws(
      () => createTask(rig.ctx, board.id, { id: 'CAN-8', title: 'Blocked dependent', lane: 'Ready', dependsOn: ['CAN-7'] }),
      /dependencies not Done/,
    );
  } finally { rig.cleanup(); }
});
