import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { listEvents } from '../src/write.ts';

// Agent 设置与模型自报：注册自报 models / me/models 自报更新 / PATCH 档案（name/note/preferredModel）/ me/profile
function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('agent 设置: 注册带 models 自报落库，/agents 列表与 me/profile 均可见', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const res = await app.request('/agents/register', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ name: '工蜂1', handle: 'bee1', models: ['gpt-5.2', 'claude-opus-4'] }),
    });
    assert.equal(res.status, 201);
    const { agent, token } = (await res.json()) as { agent: Agent; token: string };
    assert.deepEqual(agent.models, ['gpt-5.2', 'claude-opus-4']);
    assert.equal(agent.preferredModel, null);
    assert.equal(agent.note, '');

    // /agents 投影带新字段
    const list = await app.request('/agents');
    const agents = ((await list.json()) as { agents: Agent[] }).agents;
    const bee = agents.find((a) => a.id === agent.id)!;
    assert.deepEqual(bee.models, ['gpt-5.2', 'claude-opus-4']);
    assert.equal(bee.preferredModel, null);
    assert.equal(bee.note, '');

    // me/profile（worker token）：返回自己的自报与首选
    const profile = await app.request('/agents/me/profile', { headers: H(token) });
    assert.equal(profile.status, 200);
    const p = (await profile.json()) as { agentId: string; models: string[]; preferredModel: string | null };
    assert.equal(p.agentId, agent.id);
    assert.deepEqual(p.models, ['gpt-5.2', 'claude-opus-4']);
    assert.equal(p.preferredModel, null);
  } finally {
    rig.cleanup();
  }
});

test('agent 设置: me/models worker token 自报更新（去重/去空白）、事件落账、无效 token 401、非法载荷 422', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1' });

    // 无效 token：明确 401（不静默降权成 user）
    let res = await app.request('/agents/me/models', {
      method: 'POST',
      headers: H('ah-invalid'),
      body: JSON.stringify({ models: ['x'] }),
    });
    assert.equal(res.status, 401, '无效 bearer 401');

    // 非法载荷
    res = await app.request('/agents/me/models', { method: 'POST', headers: H(bee.token), body: JSON.stringify({ models: 'x' }) });
    assert.equal(res.status, 422, 'models 非数组 422');

    // worker token 自报：全量覆盖 + 归一（trim / 去空 / 去重）
    res = await app.request('/agents/me/models', {
      method: 'POST',
      headers: H(bee.token),
      body: JSON.stringify({ models: [' gpt-5.2 ', '', 'gpt-5.2', 'claude-opus-4'] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agent: Agent };
    assert.deepEqual(body.agent.models, ['gpt-5.2', 'claude-opus-4'], '归一化：去空白/去空/去重');

    // 事件台账
    const ev = listEvents(rig.ctx).find((e) => e.type === 'agent.models_reported');
    assert.ok(ev, 'agent.models_reported 事件落账');
    assert.equal(ev!.payload.agentId, 'bee1');
    assert.deepEqual(ev!.payload.models, ['gpt-5.2', 'claude-opus-4']);

    // me/profile 读回一致
    const profile = await app.request('/agents/me/profile', { headers: H(bee.token) });
    const p = (await profile.json()) as { models: string[] };
    assert.deepEqual(p.models, ['gpt-5.2', 'claude-opus-4']);
  } finally {
    rig.cleanup();
  }
});

test('agent 设置: PATCH 匿名（=user）改 name/note/preferredModel 落库+事件；worker 403；空串清空首选；id=user 可改备注', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1', models: ['gpt-5.2'] });

    // worker token 不够格（requireElevated）
    let res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(bee.token),
      body: JSON.stringify({ note: '越权' }),
    });
    assert.equal(res.status, 403, 'worker token 不可改他人档案');

    // 无效 token 401
    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H('ah-invalid'),
      body: JSON.stringify({ note: 'x' }),
    });
    assert.equal(res.status, 401, '无效 bearer 401');

    // 匿名（=user）改档案：preferredModel 允许不在自报清单内（自由填写是明确需求）
    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ name: '工作机甲', note: '机房 3 号机', preferredModel: 'gpt-5.2' }),
    });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { agent: Agent };
    assert.equal(body.agent.name, '工作机甲');
    assert.equal(body.agent.note, '机房 3 号机');
    assert.equal(body.agent.preferredModel, 'gpt-5.2');

    // 事件台账：agent.updated 记录变更字段
    const ev = listEvents(rig.ctx).find((e) => e.type === 'agent.updated');
    assert.ok(ev, 'agent.updated 事件落账');
    assert.equal(ev!.payload.agentId, 'bee1');
    assert.deepEqual(ev!.payload.fields, ['name', 'note', 'preferredModel']);

    // 部分更新：只传 preferredModel 空串 → 清空（worker 回退本地配置），其余字段不动
    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ preferredModel: '' }),
    });
    assert.equal(res.status, 200);
    body = (await res.json()) as typeof body;
    assert.equal(body.agent.preferredModel, null, '空串清空首选');
    assert.equal(body.agent.note, '机房 3 号机', '未传字段保持不变');

    // 只改首选为清单外模型也允许
    res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ preferredModel: 'openai/gpt-5.2' }),
    });
    assert.equal(res.status, 200);
    body = (await res.json()) as typeof body;
    assert.equal(body.agent.preferredModel, 'openai/gpt-5.2');

    // id='user'：用户给自己的备注（匿名即 user 本人）
    res = await app.request('/agents/user', { method: 'PATCH', headers: H(), body: JSON.stringify({ note: '本人' }) });
    assert.equal(res.status, 200, 'user 身份行可改自己的备注');
    body = (await res.json()) as typeof body;
    assert.equal(body.agent.id, 'user');
    assert.equal(body.agent.note, '本人');

    // 空显示名 422；无任何字段 422
    res = await app.request(`/agents/${bee.agent.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ name: '  ' }) });
    assert.equal(res.status, 422);
    res = await app.request(`/agents/${bee.agent.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({}) });
    assert.equal(res.status, 422, '至少一个字段');
  } finally {
    rig.cleanup();
  }
});

test('agent 设置: 注册自报 host——带 host 落库可见、缺省空串、models+host 一次走通', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    // 设备自助注册：host + models 随注册一次上报（CLI 语义——在哪台设备跑就属于哪台设备）
    let res = await app.request('/agents/register', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ name: '开发机', handle: 'pcdev', host: 'PC-DEV-1', models: ['gpt-5.2', ' claude-opus-4 '] }),
    });
    assert.equal(res.status, 201);
    const { agent } = (await res.json()) as { agent: Agent };
    assert.equal(agent.host, 'PC-DEV-1');
    assert.deepEqual(agent.models, ['gpt-5.2', 'claude-opus-4'], 'models 与 host 同报一次走通');

    // GET /agents 投影带 host
    const list = await app.request('/agents');
    const pcdev = ((await list.json()) as { agents: Agent[] }).agents.find((a) => a.id === agent.id)!;
    assert.equal(pcdev.host, 'PC-DEV-1');

    // 不带 host：手动预创建的身份壳，host 空串
    res = await app.request('/agents/register', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ name: '壳', handle: 'shell' }),
    });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { agent: Agent }).agent.host, '');
  } finally {
    rig.cleanup();
  }
});

test('agent 设置: 启停与档案合一端点不破坏原语义——只传 enabled 照常、me/profile 匿名落 user', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1' });

    // 原 T6 语义回归：匿名启停
    let res = await app.request(`/agents/${bee.agent.id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { agent: Agent }).agent.enabled, false);
    // 启停不产生 agent.updated 事件（那是档案事件）
    assert.ok(!listEvents(rig.ctx).some((e) => e.type === 'agent.updated'), '启停不触发 agent.updated');

    // 启用后 me/profile 匿名（=user）也能查自己（user 行恒存在）
    res = await app.request('/agents/me/profile', { headers: H() });
    assert.equal(res.status, 200);
    const p = (await res.json()) as { agentId: string; models: string[]; preferredModel: string | null };
    assert.equal(p.agentId, 'user');
    assert.deepEqual(p.models, []);
    assert.equal(p.preferredModel, null);
  } finally {
    rig.cleanup();
  }
});

test('Phase 4: 工蜂设备硬件能力自报——注册自报、me/specs 自报、心跳更新与 422 校验', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    // 1. 注册时自报 specs
    let regRes = await app.request('/agents/register', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({
        name: 'Omp Bee',
        handle: 'omp-bee',
        models: ['gemini-flash'],
        host: 'X5800',
        specs: {
          os: 'win32',
          arch: 'x64',
          cpus: 16,
          memoryTotalGb: 32,
          executor: 'omp',
        },
      }),
    });
    assert.equal(regRes.status, 201);
    const regData = (await regRes.json()) as { agent: Agent; token: string };
    assert.equal(regData.agent.specs.os, 'win32');
    assert.equal(regData.agent.specs.arch, 'x64');
    assert.equal(regData.agent.specs.cpus, 16);
    assert.equal(regData.agent.specs.memoryTotalGb, 32);
    assert.equal(regData.agent.specs.executor, 'omp');

    // 2. overview 接口可见 specs
    let ovRes = await app.request('/overview', { headers: H() });
    assert.equal(ovRes.status, 200);
    const ov = (await ovRes.json()) as { agents: { id: string; specs?: { cpus?: number; memoryTotalGb?: number } }[] };
    const beeOv = ov.agents.find((a) => a.id === 'omp-bee');
    assert.ok(beeOv, 'overview 中包含 omp-bee');
    assert.equal(beeOv.specs?.cpus, 16);
    assert.equal(beeOv.specs?.memoryTotalGb, 32);

    // 3. me/specs 自报更新
    let updateRes = await app.request('/agents/me/specs', {
      method: 'POST',
      headers: H(regData.token),
      body: JSON.stringify({
        specs: {
          os: 'win32',
          arch: 'x64',
          cpus: 16,
          memoryTotalGb: 64, // 扩容到 64G
          executor: 'omp',
          gpu: 'RTX 4090',
        },
      }),
    });
    assert.equal(updateRes.status, 200);
    const updated = (await updateRes.json()) as { agent: Agent };
    assert.equal(updated.agent.specs.memoryTotalGb, 64);
    assert.equal(updated.agent.specs.gpu, 'RTX 4090');

    // 检查事件台账
    const events = listEvents(rig.ctx);
    assert.ok(events.some((e) => e.type === 'agent.specs_reported'), 'agent.specs_reported 事件落账');

    // 4. 心跳携带 specs 顺便刷新
    let hbRes = await app.request('/agents/omp-bee/heartbeat', {
      method: 'POST',
      headers: H(regData.token),
      body: JSON.stringify({
        specs: {
          memoryTotalGb: 64,
          gpu: 'RTX 4090 (Driver updated)',
        },
      }),
    });
    assert.equal(hbRes.status, 200);
    const hbData = (await hbRes.json()) as { agent: Agent };
    assert.equal(hbData.agent.specs.gpu, 'RTX 4090 (Driver updated)');

    // 5. 校验边界：非法 cpus 或 非法载荷报 422
    let badRes = await app.request('/agents/me/specs', {
      method: 'POST',
      headers: H(regData.token),
      body: JSON.stringify({ specs: { cpus: -4 } }),
    });
    assert.equal(badRes.status, 422);

    // 6. 无效 token 报 401
    let badTokenRes = await app.request('/agents/me/specs', {
      method: 'POST',
      headers: H('invalid-token'),
      body: JSON.stringify({ specs: { cpus: 8 } }),
    });
    assert.equal(badTokenRes.status, 401);
  } finally {
    rig.cleanup();
  }
});
