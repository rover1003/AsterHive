import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { createBoard, createTask, getTask } from '../src/tasks.ts';
import { claimTask } from '../src/verbs.ts';

test('受控解除占用只接受管理员凭据及真实用户停止确认', async () => {
  const rig = mkRig();
  try {
    const adminToken = 'A'.repeat(48);
    rig.ctx.cfg.adminRecoveryToken = adminToken;
    const worker = registerAgent(rig.ctx, { name: 'bee', handle: 'test-bee' });
    const forgedUser = registerAgent(rig.ctx, { name: 'user', handle: 'test-user', role: 'user' });
    createBoard(rig.ctx, { id: 'b', name: 'sandbox' });
    createTask(rig.ctx, 'b', { id: 'T1', title: 'sandbox', lane: 'Ready', assignee: worker.agent.id });
    claimTask(rig.ctx, worker.agent, 'T1');
    const app = createApp(rig.ctx);
    const request = (token: string | undefined, confirmedStopped: boolean) => app.request(`/agents/${worker.agent.id}/control/release-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ taskId: 'T1', confirmedStopped }),
    });
    assert.equal((await request(undefined, true)).status, 401);
    assert.equal((await request(forgedUser.token, true)).status, 403);
    assert.equal((await request(adminToken, false)).status, 409);
    assert.equal(getTask(rig.ctx, 'T1').lane, 'InProgress');
    assert.equal((await request(adminToken, true)).status, 200);
    assert.equal(getTask(rig.ctx, 'T1').lane, 'Ready');
  } finally {
    rig.cleanup();
  }
});
