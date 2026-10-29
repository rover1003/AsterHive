import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { createBoard, createTask, returnTaskFromReview } from '../src/tasks.ts';
import { registerAgent } from '../src/agents.ts';
import { claimTask, checkpointTask, submitTask } from '../src/verbs.ts';
import { ensureUserAgent } from '../src/user.ts';
import { openDb } from '../src/db.ts';

function setup() {
  const rig = mkRig();
  createBoard(rig.ctx, { id: 'executions', name: 'Executions' });
  const worker = registerAgent(rig.ctx, { id: 'exec-worker', name: 'Worker', handle: 'exec-worker', role: 'worker' });
  createTask(rig.ctx, 'executions', { id: 'EXEC-1', title: 'Observe execution', lane: 'Ready', assignee: worker.agent.id });
  return { ...rig, worker, app: createApp(rig.ctx) };
}

test('claim creates a persistent execution; keepalive does not invent model or tool progress', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    let response = await rig.app.request('/tasks/EXEC-1/executions');
    assert.equal(response.status, 200);
    const first = (await response.json()).executions[0];
    assert.equal(first.taskId, 'EXEC-1');
    assert.equal(first.workerId, rig.worker.agent.id);
    assert.equal(first.attempt, 1);
    assert.equal(first.state, 'accepted');
    assert.equal(first.lastActivityAt, null);
    checkpointTask(rig.ctx, rig.worker.agent, 'EXEC-1', { note: 'keepalive', isKeepalive: true, kind: 'keepalive' });
    response = await rig.app.request('/tasks/EXEC-1/executions');
    const current = (await response.json()).executions[0];
    assert.equal(current.id, first.id);
    assert.equal(current.lastActivityAt, null);
    assert.equal(current.state, 'accepted');
  } finally { rig.cleanup(); }
});

test('execution events reject foreign and stale writers and deduplicate repeated sequences', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    const foreign = registerAgent(rig.ctx, { id: 'foreign-worker', name: 'Foreign', handle: 'foreign-worker', role: 'worker' });
    const send = (token: string, body: object) => rig.app.request('/tasks/EXEC-1/executions/1/events', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    const event = { sequence: 1, kind: 'tool', phase: 'start', toolName: 'read', callId: 'call-1' };
    assert.equal((await send(foreign.token, event)).status, 403);
    assert.equal((await send(rig.worker.token, event)).status, 200);
    assert.equal((await send(rig.worker.token, event)).status, 200);
    let response = await rig.app.request('/tasks/EXEC-1/executions');
    let execution = (await response.json()).executions[0];
    assert.equal(execution.state, 'waiting_tool');
    assert.equal(execution.waitingFor, 'read');
    const taskSnapshot = await (await rig.app.request('/tasks/EXEC-1')).json();
    assert.equal(taskSnapshot.task.lastRealActivityAt, execution.lastActivityAt);
    assert.equal(taskSnapshot.task.lastProgressAt, null, 'tool activity is not an explicit milestone');
    const events = await rig.app.request(`/tasks/EXEC-1/executions/${execution.id}/events`);
    assert.equal(events.status, 200);
    const toolStarts = (await events.json()).events.filter((e: { kind: string; sequence?: number }) => e.kind === 'tool' && e.sequence === 1);
    assert.equal(toolStarts.length, 1);
    assert.equal((await send(rig.worker.token, { ...event, sequence: 2, phase: 'end' })).status, 200);
    response = await rig.app.request('/tasks/EXEC-1/executions');
    execution = (await response.json()).executions[0];
    assert.equal(execution.state, 'running');
    assert.equal(execution.waitingFor, null);
    // A newer completion cannot be undone by an old start.
    assert.equal((await send(rig.worker.token, event)).status, 200);
    response = await rig.app.request('/tasks/EXEC-1/executions');
    assert.equal((await response.json()).executions[0].state, 'running');
    rig.ctx.holder.db.prepare('UPDATE task SET attempt = 2 WHERE id = ?').run('EXEC-1');
    assert.equal((await send(rig.worker.token, { ...event, sequence: 3 })).status, 409);
  } finally { rig.cleanup(); }
});

test('review rework creates a new instance without overwriting the prior execution', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    checkpointTask(rig.ctx, rig.worker.agent, 'EXEC-1', { note: 'Result ready', kind: 'milestone' });
    submitTask(rig.ctx, rig.worker.agent, 'EXEC-1', { summary: 'Investigation result', noCode: true });
    const beforeResponse = await rig.app.request('/tasks/EXEC-1/executions');
    assert.equal(beforeResponse.status, 200);
    const before = await beforeResponse.json();
    assert.equal(before.executions[0].state, 'awaiting_review');
    await returnTaskFromReview(rig.ctx, ensureUserAgent(rig.ctx), 'EXEC-1', 'Provide missing evidence');
    const afterResponse = await rig.app.request('/tasks/EXEC-1/executions');
    assert.equal(afterResponse.status, 200);
    const after = await afterResponse.json();
    assert.deepEqual(after.executions.map((e: { attempt: number }) => e.attempt), [2, 1]);
    assert.notEqual(after.executions[0].id, after.executions[1].id);
    assert.equal(after.executions[1].state, 'awaiting_review');
    assert.equal(after.executions[0].state, 'dispatched');
  } finally { rig.cleanup(); }
});

test('concurrent tool endings preserve another tool wait and checkpoint does not erase its phase', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    const send = async (sequence: number, phase: string, callId: string, toolName: string) => {
      const response = await rig.app.request('/tasks/EXEC-1/executions/1/events', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rig.worker.token}` },
        body: JSON.stringify({ sequence, kind: 'tool', phase, callId, toolName }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).execution;
    };
    await send(1, 'start', 'call-a', 'read');
    await send(2, 'start', 'call-b', 'write');
    const afterFirstEnd = await send(3, 'end', 'call-b', 'write');
    assert.equal(afterFirstEnd.state, 'waiting_tool');
    assert.equal(afterFirstEnd.waitingFor, 'read');
    assert.equal(typeof afterFirstEnd.phaseSince, 'number');
    checkpointTask(rig.ctx, rig.worker.agent, 'EXEC-1', { kind: 'tool', note: 'observed tool activity' });
    const snapshot = await (await rig.app.request('/tasks/EXEC-1/executions')).json();
    assert.equal(snapshot.executions[0].state, 'waiting_tool');
    assert.equal(snapshot.executions[0].phaseSince, afterFirstEnd.phaseSince);
    assert.equal((await send(4, 'end', 'call-a', 'read')).state, 'running');
  } finally { rig.cleanup(); }
});

test('worker-reported workspace base is retained and activity gaps do not masquerade as a continuous wait', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    const send = async (body: object) => {
      const response = await rig.app.request('/tasks/EXEC-1/executions/1/events', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rig.worker.token}` },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return (await response.json()).execution;
    };
    const baseCommit = 'a'.repeat(40);
    const started = await send({ sequence: 1, kind: 'started', executor: 'pi', baseCommit });
    assert.equal(started.baseCommit, baseCommit);
    assert.equal(started.executor, 'pi');
    await send({ sequence: 2, kind: 'tool', phase: 'start', toolName: 'read', callId: 'lost-call' });
    assert.equal((await send({ sequence: 5, kind: 'gap' })).state, 'unknown');
    await send({ sequence: 6, kind: 'tool', phase: 'start', toolName: 'write', callId: 'known-call' });
    const ended = await send({ sequence: 7, kind: 'tool', phase: 'end', toolName: 'write', callId: 'known-call' });
    assert.equal(ended.state, 'running');
    assert.equal(ended.waitingFor, null);
  } finally { rig.cleanup(); }
});

test('an already started execution cannot be silently restarted within the same attempt', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    const send = (sequence: number) => rig.app.request('/tasks/EXEC-1/executions/1/events', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rig.worker.token}` },
      body: JSON.stringify({ sequence, kind: 'started', executor: 'pi' }),
    });
    assert.equal((await send(1)).status, 200);
    assert.equal((await send(1)).status, 200, 'same event is an idempotent retry');
    assert.equal((await send(2)).status, 409, 'new process must use controlled recovery/new attempt');
  } finally { rig.cleanup(); }
});

test('server restart retains execution identity, sequence and event history', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    const before = await (await rig.app.request('/tasks/EXEC-1/executions')).json();
    const response = await rig.app.request('/tasks/EXEC-1/executions/1/events', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rig.worker.token}` },
      body: JSON.stringify({ sequence: 1, kind: 'model', phase: 'start' }),
    });
    assert.equal(response.status, 200);
    rig.ctx.holder.db.close();
    rig.ctx.holder.db = openDb(rig.ctx.cfg.dataDir);
    const after = await (await rig.app.request('/tasks/EXEC-1/executions')).json();
    assert.equal(after.executions[0].id, before.executions[0].id);
    assert.equal(after.executions[0].lastSequence, 1);
    assert.equal(after.executions[0].state, 'waiting_model');
    const events = await (await rig.app.request(`/tasks/EXEC-1/executions/${after.executions[0].id}/events`)).json();
    assert.equal(events.events.find((event: { sequence: number }) => event.sequence === 1)?.kind, 'model');
  } finally { rig.cleanup(); }
});

test('legacy migration retains task round but does not invent execution start or phase', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    rig.ctx.holder.db.exec('DROP TABLE execution_event; DROP TABLE execution');
    rig.ctx.holder.db.close();
    rig.ctx.holder.db = openDb(rig.ctx.cfg.dataDir);
    const after = await (await rig.app.request('/tasks/EXEC-1/executions')).json();
    assert.equal(after.executions[0].attempt, 1);
    assert.equal(after.executions[0].workerId, 'exec-worker');
    assert.equal(after.executions[0].state, 'unknown');
    assert.equal(after.executions[0].startedAt, null);
    assert.equal(after.executions[0].lastActivityAt, null);
    assert.equal(rig.ctx.holder.db.prepare('SELECT lane FROM task WHERE id=?').get('EXEC-1')?.lane, 'InProgress');
  } finally { rig.cleanup(); }
});

test('abort request remains outcome unknown until a worker confirms the execution actually settled', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    const send = (sequence: number, kind: string) => rig.app.request('/tasks/EXEC-1/executions/1/events', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rig.worker.token}` },
      body: JSON.stringify({ sequence, kind }),
    });
    const requested = await send(1, 'cancel_requested');
    assert.equal(requested.status, 200);
    assert.equal((await requested.json()).execution.state, 'unknown');
    checkpointTask(rig.ctx, rig.worker.agent, 'EXEC-1', { note: 'abort still settling', kind: 'milestone' });
    const snapshot = await (await rig.app.request('/tasks/EXEC-1/executions')).json();
    assert.equal(snapshot.executions[0].state, 'unknown');
    assert.equal(snapshot.executions[0].endedAt, null);
    const confirmed = await send(2, 'cancelled');
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).execution.state, 'cancelled');
  } finally { rig.cleanup(); }
});

test('a missing activity sequence is exposed and cannot leave a lost tool pending forever', async () => {
  const rig = setup();
  try {
    claimTask(rig.ctx, rig.worker.agent, 'EXEC-1');
    const send = async (sequence: number, phase: string, callId: string) => {
      const response = await rig.app.request('/tasks/EXEC-1/executions/1/events', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rig.worker.token}` },
        body: JSON.stringify({ sequence, kind: 'tool', phase, callId, toolName: 'read' }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).execution;
    };
    await send(1, 'start', 'lost-call');
    await send(4, 'start', 'current-call');
    const ended = await send(5, 'end', 'current-call');
    assert.equal(ended.state, 'running');
    const history = await (await rig.app.request(`/tasks/EXEC-1/executions/${ended.id}/events`)).json();
    assert.ok(history.events.some((event: { kind: string }) => event.kind === 'gap'));
  } finally { rig.cleanup(); }
});
