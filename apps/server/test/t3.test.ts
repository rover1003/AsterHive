import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import type { Agent } from '../src/agents.ts';

// HTTP 级测试：走完整鉴权与路由栈（Hono app.request，无需监听端口）
function makeRigWithApp() {
  const rig = mkRig();
  const app = createApp(rig.ctx);
  return { rig, app };
}

function authedInit(token: string): { headers: Record<string, string> } {
  return { headers: { authorization: `Bearer ${token}` } };
}

test('T3: agent 注册——角色自由（worker/orchestrator/user 均无门槛）、句柄唯一、保留句柄拒绝', async () => {
  const { rig, app } = makeRigWithApp();
  try {
    let res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ZCode 工作机', handle: 'zcode' }),
    });
    assert.equal(res.status, 201);
    const worker = (await res.json()) as { agent: Agent; token: string };
    assert.equal(worker.agent.role, 'worker');
    assert.ok(worker.token.startsWith('ah_'));

    // 单用户模型：角色参数自由，无管理令牌门槛
    res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '主脑A', handle: 'brain-a', role: 'orchestrator' }),
    });
    assert.equal(res.status, 201, 'orchestrator 无门槛注册');
    res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '临时身份', handle: 'someone', role: 'user' }),
    });
    assert.equal(res.status, 201, 'user 角色同样无门槛（浏览器主人身份走 PUT /api/user）');

    res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '占保留句柄', handle: '主脑' }),
    });
    assert.equal(res.status, 422);

    res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '重复', handle: 'zcode' }),
    });
    assert.equal(res.status, 409);
  } finally {
    rig.cleanup();
  }
});

test('T3: 建板建卡全字段落库，非法 id/重复 id 拒绝', async () => {
  const { rig, app } = makeRigWithApp();
  try {
    const { token } = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const H = authedInit(token).headers;

    let res = await app.request('/boards', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({ id: 'demo', name: '演示板' }),
    });
    assert.equal(res.status, 201);

    res = await app.request('/boards/demo/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({
        id: 'T41',
        title: '搭脚手架',
        detail: '初始化工程',
        priority: 'P0',
        category: 'infra',
        acceptance: 'npm run dev 可启动',
        workspace: { repo: 'github.com/x/a', branch: 'main' },
        files: ['package.json', 'src/**'],
        protectedPaths: ['.env'],
      }),
    });
    assert.equal(res.status, 201);
    const { task } = (await res.json()) as { task: Record<string, unknown> };
    assert.equal(task.lane, 'Backlog');
    assert.deepEqual(task.files, ['package.json', 'src/**']);
    assert.deepEqual(task.workspace, { repo: 'github.com/x/a', branch: 'main' });

    res = await app.request('/boards/demo/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({ id: 'T41', title: '重复' }),
    });
    assert.equal(res.status, 409);

    res = await app.request('/boards/demo/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({ id: 'bad id!', title: '非法' }),
    });
    assert.equal(res.status, 422);
  } finally {
    rig.cleanup();
  }
});

test('T3: 依赖链——上游 Done 自动解锁下游；Ready 门槛', async () => {
  const { rig, app } = makeRigWithApp();
  try {
    const { token } = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const H = { 'content-type': 'application/json', ...authedInit(token).headers };
    await app.request('/boards', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ id: 'demo', name: '演示板' }),
    });
    await app.request('/boards/demo/tasks', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ id: 'T1', title: '上游' }),
    });
    await app.request('/boards/demo/tasks', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ id: 'T2', title: '下游', dependsOn: ['T1'] }),
    });

    // T2 有未完成依赖，不能进 Ready
    let res = await app.request('/tasks/T2', {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ lane: 'Ready' }),
    });
    assert.equal(res.status, 422);

    // T1 → Ready → InProgress → Review → Done（主脑角色可移动 Done）
    for (const lane of ['Ready', 'InProgress', 'Review', 'Done']) {
      res = await app.request('/tasks/T1', {
        method: 'PATCH',
        headers: H,
        body: JSON.stringify({ lane }),
      });
      assert.equal(res.status, 200, `T1 → ${lane}`);
    }
    res = await app.request('/tasks/T2', { headers: H });
    const t2 = ((await res.json()) as { task: { autoUnblockedAt: number | null; lane: string } }).task;
    assert.ok(t2.autoUnblockedAt, 'T1 Done 后 T2 记录 autoUnblockedAt');

    // 解锁后 T2 可进 Ready
    res = await app.request('/tasks/T2', {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ lane: 'Ready' }),
    });
    assert.equal(res.status, 200);
  } finally {
    rig.cleanup();
  }
});

test('T3: 信任分层——worker 不能把卡移进/移出 Done', async () => {
  const { rig, app } = makeRigWithApp();
  try {
    const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const worker = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1' });
    const OH = { 'content-type': 'application/json', ...authedInit(orch.token).headers };
    const WH = { 'content-type': 'application/json', ...authedInit(worker.token).headers };

    await app.request('/boards', { method: 'POST', headers: OH, body: JSON.stringify({ id: 'b', name: '板' }) });
    await app.request('/boards/b/tasks', { method: 'POST', headers: OH, body: JSON.stringify({ id: 'T9', title: '卡' }) });
    await app.request('/tasks/T9', { method: 'PATCH', headers: OH, body: JSON.stringify({ lane: 'Review' }) });

    let res = await app.request('/tasks/T9', {
      method: 'PATCH',
      headers: WH,
      body: JSON.stringify({ lane: 'Done' }),
    });
    assert.equal(res.status, 403, 'worker 移入 Done 被拒');

    res = await app.request('/tasks/T9', {
      method: 'PATCH',
      headers: OH,
      body: JSON.stringify({ lane: 'Done' }),
    });
    assert.equal(res.status, 200, '主脑移入 Done 放行');

    res = await app.request('/tasks/T9', {
      method: 'PATCH',
      headers: WH,
      body: JSON.stringify({ lane: 'InProgress' }),
    });
    assert.equal(res.status, 403, 'worker 移出 Done 被拒');
  } finally {
    rig.cleanup();
  }
});

test('T3: WIP 限制——InProgress 默认上限 3，超限 409', async () => {
  const { rig, app } = makeRigWithApp();
  try {
    const { token } = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const H = { 'content-type': 'application/json', ...authedInit(token).headers };
    await app.request('/boards', { method: 'POST', headers: H, body: JSON.stringify({ id: 'b', name: '板' }) });
    for (let i = 1; i <= 4; i++) {
      const res = await app.request('/boards/b/tasks', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ id: `T${i}`, title: `卡${i}`, lane: 'InProgress' }),
      });
      assert.equal(res.status, i <= 3 ? 201 : 409, `第 ${i} 张 InProgress 卡`);
    }
  } finally {
    rig.cleanup();
  }
});

test('T3: 补依赖回退——Ready 卡补未完成依赖退回 Backlog；吊销 token 后写操作 401', async () => {
  const { rig, app } = makeRigWithApp();
  try {
    const { token } = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const H = { 'content-type': 'application/json', ...authedInit(token).headers };
    await app.request('/boards', { method: 'POST', headers: H, body: JSON.stringify({ id: 'b', name: '板' }) });
    await app.request('/boards/b/tasks', { method: 'POST', headers: H, body: JSON.stringify({ id: 'T1', title: '新上游', lane: 'Backlog' }) });
    await app.request('/boards/b/tasks', { method: 'POST', headers: H, body: JSON.stringify({ id: 'T2', title: '就绪卡', lane: 'Ready' }) });

    const res = await app.request('/tasks/T2/depends', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ on: ['T1'] }),
    });
    assert.equal(res.status, 200);
    const { task } = (await res.json()) as { task: { lane: string; dependsOn: string[] } };
    assert.equal(task.lane, 'Backlog', '补未完成依赖后退回 Backlog');
    assert.deepEqual(task.dependsOn, ['T1']);

    // 启停闸门：user/orchestrator 身份即可吊销（requireElevated）
    await app.request('/agents/brain-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authedInit(token).headers },
      body: JSON.stringify({ enabled: false }),
    });
    const denied = await app.request('/boards', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ id: 'b2', name: 'x' }),
    });
    assert.equal(denied.status, 401, '吊销 token 后写操作被拒');
  } finally {
    rig.cleanup();
  }
});
