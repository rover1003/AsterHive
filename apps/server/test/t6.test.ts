import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { readAudit } from '../src/backup.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('T6: heartbeat 刷新 last_seen；agent 列表不泄露 token 哈希', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1' });

    let res = await app.request('/agents');
    let body = (await res.json()) as { agents: Record<string, unknown>[] };
    assert.equal(body.agents.length, 1);
    assert.ok(!('token_hash' in body.agents[0]), '不泄露哈希');
    assert.ok(!('tokenHash' in body.agents[0]));

    const before = (body.agents[0] as { lastSeenAt: number | null }).lastSeenAt;
    assert.equal(before, null);

    const res2 = await app.request(`/agents/${bee.agent.id}/heartbeat`, {
      method: 'POST',
      headers: H(bee.token),
    });
    assert.equal(res2.status, 200);
    res = await app.request('/agents');
    body = (await res.json()) as typeof body;
    assert.ok((body.agents[0] as { lastSeenAt: number | null }).lastSeenAt !== null);
  } finally {
    rig.cleanup();
  }
});

test('T6: 审计覆盖——各类结构化写均可在 /audit 查到', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'zcode' });
    const OH = H(orch.token);

    await app.request('/boards', { method: 'POST', headers: OH, body: JSON.stringify({ id: 'b', name: '板' }) });
    await app.request('/boards/b/tasks', {
      method: 'POST',
      headers: OH,
      body: JSON.stringify({ id: 'T1', title: '卡', lane: 'Ready' }),
    });
    await app.request('/tasks/T1/claim', { method: 'POST', headers: H(bee.token), body: '{}' });
    await app.request('/tasks/T1/checkpoint', {
      method: 'POST',
      headers: H(bee.token),
      body: JSON.stringify({ note: '进行中' }),
    });
    await app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ content: '@zcode 干得不错' }),
    });

    const res = await app.request('/api/audit?limit=100');
    const body = (await res.json()) as { entries: { label: string; result: string }[] };
    const labels = new Set(body.entries.map((e) => e.label));
    for (const expected of [
      'agent.register',
      'board.create',
      'task.create',
      'task.claim',
      'task.checkpoint',
      'message.create',
    ]) {
      assert.ok(labels.has(expected), `审计含 ${expected}`);
    }
    assert.ok(body.entries.every((e) => e.result === 'ok'));
    // 与文件侧审计一致
    const fileAudit = readAudit(rig.ctx.cfg.dataDir, 500);
    assert.equal(fileAudit.length, body.entries.length);
  } finally {
    rig.cleanup();
  }
});

test('T6: 启停闸门（requireElevated）——匿名（=user）可启停、worker 403、无效 token 401、orchestrator 可吊销；吊销后 inbox 401', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1' });

    let res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H('ah-invalid'),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 401, '无效 bearer 401（不静默降权）');

    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(bee.token), // worker 角色不够格
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 403, 'worker 角色不能吊销');

    // 零令牌：无凭据即唯一用户（user 角色），可启停
    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200, '匿名（=user）可启停 agent');
    assert.equal(((await res.json()) as { agent: { enabled: boolean } }).agent.enabled, false);

    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(orch.token),
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200, 'orchestrator 身份可启停 agent');

    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(orch.token),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200, 'orchestrator 身份吊销成功');

    res = await app.request('/agents/me/inbox', { headers: H(bee.token) });
    assert.equal(res.status, 401, '吊销后 inbox 拒绝');
  } finally {
    rig.cleanup();
  }
});
