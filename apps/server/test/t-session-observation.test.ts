import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { createBoard, createTask } from '../src/tasks.ts';
import { claimTask } from '../src/verbs.ts';
import { openDb } from '../src/db.ts';
import { parseSessionBatch, storeSessionBatch, setSessionObservation } from '../src/session-observation.ts';
import { withWrite } from '../src/write.ts';
import { ensureUserAgent } from '../src/user.ts';

function setup() {
  const rig = mkRig();
  createBoard(rig.ctx, { id: 'sessions', name: 'Session observation' });
  const worker = registerAgent(rig.ctx, { id: 'session-worker', name: 'Session worker', handle: 'session-worker', role: 'worker', specs: { executor: 'pi' } });
  const foreign = registerAgent(rig.ctx, { id: 'foreign-session', name: 'Other', handle: 'foreign-session', role: 'worker' });
  createTask(rig.ctx, 'sessions', { id: 'S-1', title: 'Observe session', lane: 'Ready', assignee: worker.agent.id, workspace: { observeSession: true } });
  claimTask(rig.ctx, worker.agent, 'S-1');
  const user = ensureUserAgent(rig.ctx);
  withWrite(rig.ctx, 'session.consent.setup', () => setSessionObservation(rig.ctx, user, 'S-1', true));
  const app = createApp(rig.ctx);
  const send = (body: object, token = worker.token, attempt = 1) => app.request(`/tasks/S-1/executions/${attempt}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ events: [body] }),
  });
  return { ...rig, app, worker, foreign, send };
}

test('only current assigned worker may publish opted-in session events; reads stay task-scoped', async () => {
  const rig = setup();
  try {
    const event = { sequence: 1, kind: 'assistant_text', messageId: 'm1', contentIndex: 0, text: 'Visible reply\n' };
    assert.equal((await rig.send(event, rig.foreign.token)).status, 403);
    assert.equal((await rig.send(event, rig.worker.token, 2)).status, 409);
    assert.equal((await rig.send(event)).status, 200);
    assert.equal((await rig.send(event)).status, 200);
    const { executions } = await (await rig.app.request('/tasks/S-1/executions')).json();
    const response = await rig.app.request(`/tasks/S-1/executions/${executions[0].id}/session`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.events.filter((e: { sequence: number }) => e.sequence === 1).length, 1);
    assert.equal(snapshot.events[0].text, 'Visible reply\n');
    assert.equal(snapshot.cursor, 1);
    createTask(rig.ctx, 'sessions', { id: 'S-2', title: 'Other task' });
    assert.equal((await rig.app.request(`/tasks/S-2/executions/${executions[0].id}/session`)).status, 404);
    assert.equal((await rig.app.request('/tasks/S-1/session-observation', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${rig.worker.token}` }, body: JSON.stringify({ enabled: false }) })).status, 403);
    assert.equal((await rig.app.request('/tasks/S-1/session-observation', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).status, 200);
    assert.equal((await rig.send({ ...event, sequence: 2 })).status, 409);
  } finally { rig.cleanup(); }
});

test('session snapshots survive restart and retained event overflow exposes a gap', async () => {
  const rig = setup();
  try {
    // One event is a bounded visible block, not an unbounded message or raw SDK frame.
    assert.equal((await rig.send({ sequence: 1, kind: 'assistant_text', messageId: 'm1', text: 'x'.repeat(4097) })).status, 422);
    withWrite(rig.ctx, 'session.retention-smoke', () => {
      for (let sequence = 1; sequence <= 140; sequence++) {
        const events = parseSessionBatch({ events: [{ sequence, kind: 'assistant_text', messageId: 'm1', contentIndex: 0, text: `${sequence}: ${'界'.repeat(1000)}\n` }] });
        storeSessionBatch(rig.ctx, rig.worker.agent, 'S-1', 1, events);
      }
    });
    const { executions } = await (await rig.app.request('/tasks/S-1/executions')).json();
    rig.ctx.holder.db.close();
    rig.ctx.holder.db = openDb(rig.ctx.cfg.dataDir);
    const response = await rig.app.request(`/tasks/S-1/executions/${executions[0].id}/session?after=0`);
    const snapshot = await response.json();
    assert.equal(snapshot.cursor, 140);
    assert.equal(snapshot.gap, true);
    assert.ok(snapshot.events[0].sequence > 1);
    assert.match(snapshot.events.at(-1).text, /^140:/);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot.events)) < 300_000);
  } finally { rig.cleanup(); }
});

test('server removes known credential patterns and never stores raw arguments or reasoning fields', async () => {
  const rig = setup();
  try {
    const response = await rig.send({ sequence: 1, kind: 'assistant_text', messageId: 'm1', text: 'api_key=sk-local-sentinel-123456789\n', args: { password: 'PRIVATE_ARG' }, reasoning: 'PRIVATE_REASONING' });
    assert.equal(response.status, 200);
    const { executions } = await (await rig.app.request('/tasks/S-1/executions')).json();
    const snapshot = await (await rig.app.request(`/tasks/S-1/executions/${executions[0].id}/session`)).json();
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /sk-local-sentinel|PRIVATE_ARG|PRIVATE_REASONING/);
    assert.equal(snapshot.events[0].kind, 'redacted');
  } finally { rig.cleanup(); }
});

test('worker-writable workspace flags cannot grant permission to publish session content', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'consent', name: 'Consent' });
    const worker = registerAgent(rig.ctx, { id: 'consent-worker', name: 'Worker', handle: 'consent-worker', specs: { executor: 'pi' } });
    createTask(rig.ctx, 'consent', { id: 'NC-1', title: 'No consent', lane: 'Ready', assignee: worker.agent.id, workspace: { observeSession: true } });
    claimTask(rig.ctx, worker.agent, 'NC-1');
    const app = createApp(rig.ctx);
    const response = await app.request('/tasks/NC-1/executions/1/session', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${worker.token}` },
      body: JSON.stringify({ events: [{ sequence: 1, kind: 'assistant_text', messageId: 'm1', text: 'not authorized' }] }),
    });
    assert.equal(response.status, 409);
  } finally { rig.cleanup(); }
});
