import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { createBoard, createTask, getTask } from '../src/tasks.ts';
import { claimTask } from '../src/verbs.ts';

test('受控恢复凭据：可在设置中查看与修改密码，并驱动解除占用门禁', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    // 1. 初始未配置
    const getInit = await app.request('/settings/admin-recovery');
    assert.equal(getInit.status, 200);
    const initJson = await getInit.json() as { configured: boolean; updatedAt: number | null };
    assert.equal(initJson.configured, false);
    assert.equal(initJson.updatedAt, null);

    // 2. 校验非法输入（空串或非字符串）
    const badReq = await app.request('/settings/admin-recovery', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: '' }),
    });
    assert.equal(badReq.status, 422);

    // 3. 在设置中保存恢复密码
    const putRes = await app.request('/settings/admin-recovery', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'user-chosen-password-888' }),
    });
    assert.equal(putRes.status, 200);
    const putJson = await putRes.json() as { configured: boolean; updatedAt: number | null };
    assert.equal(putJson.configured, true);
    assert.ok(putJson.updatedAt && putJson.updatedAt > 0);

    // 4. 读取确认已配置，且不泄露哈希或密码
    const getAfter = await app.request('/settings/admin-recovery');
    assert.equal(getAfter.status, 200);
    const afterJson = await getAfter.json() as Record<string, unknown>;
    assert.equal(afterJson.configured, true);
    assert.equal(typeof afterJson.updatedAt, 'number');
    assert.equal(afterJson.hash, undefined);
    assert.equal(afterJson.salt, undefined);
    assert.equal(afterJson.password, undefined);

    // 5. 验证解除占用门禁：正确密码可解锁，错误密码 403，无密码 401
    const worker = registerAgent(rig.ctx, { name: 'bee', handle: 'recovery-bee' });
    createBoard(rig.ctx, { id: 'b', name: 'sandbox' });
    createTask(rig.ctx, 'b', { id: 'T1', title: 'stuck task', lane: 'Ready', assignee: worker.agent.id });
    claimTask(rig.ctx, worker.agent, 'T1');

    const requestRelease = (token?: string, confirmedStopped = true) =>
      app.request(`/agents/${worker.agent.id}/control/release-task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ taskId: 'T1', confirmedStopped }),
      });

    assert.equal((await requestRelease(undefined, true)).status, 401);
    assert.equal((await requestRelease('wrong-password', true)).status, 403);
    assert.equal((await requestRelease('user-chosen-password-888', false)).status, 409);
    assert.equal(getTask(rig.ctx, 'T1').lane, 'InProgress');

    const okRes = await requestRelease('user-chosen-password-888', true);
    assert.equal(okRes.status, 200);
    assert.equal(getTask(rig.ctx, 'T1').lane, 'Ready');
    assert.equal(getTask(rig.ctx, 'T1').attempt, 2);
  } finally {
    rig.cleanup();
  }
});
