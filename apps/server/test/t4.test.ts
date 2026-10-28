import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig, type TestRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { listEvents } from '../src/write.ts';
import { releaseStuckTask } from '../src/worker-control.ts';
import { getTask } from '../src/tasks.ts';
interface Rig {
  rig: TestRig;
  app: ReturnType<typeof createApp>;
  orch: { agent: Agent; token: string };
  bee1: { agent: Agent; token: string };
  bee2: { agent: Agent; token: string };
  user: { agent: Agent; token: string };
}

function mkBoardRig(ttlMinutes = 15): Rig {
  const rig = mkRig(ttlMinutes);
  const app = createApp(rig.ctx);
  const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
  const bee1 = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1' });
  const bee2 = registerAgent(rig.ctx, { name: '工蜂2', handle: 'bee2' });
  const user = registerAgent(rig.ctx, { name: '老板', handle: 'boss', role: 'user' });
  return { rig, app, orch, bee1, bee2, user };
}

function H(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

async function setupBoard(
  r: Rig,
  tasks: { id: string; title?: string; lane?: string; priority?: string; files?: string[]; assignee?: string }[],
) {
  await r.app.request('/boards', {
    method: 'POST',
    headers: H(r.orch.token),
    body: JSON.stringify({ id: 'b', name: '板' }),
  });
  for (const t of tasks) {
    await r.app.request('/boards/b/tasks', {
      method: 'POST',
      headers: H(r.orch.token),
      body: JSON.stringify({
        id: t.id,
        title: t.title ?? t.id,
        lane: t.lane,
        priority: t.priority,
        files: t.files,
        assignee: t.assignee,
      }),
    });
  }
}

test('T4: next 按优先级原子认领，取完返回 null', async () => {
  const r = mkBoardRig();
  try {
    await setupBoard(r, [
      { id: 'T1', title: '普通', lane: 'Ready', assignee: 'bee1' },
      { id: 'T2', title: '紧急', lane: 'Ready', priority: 'P0', assignee: 'bee1' },
    ]);
    let res = await r.app.request('/boards/b/next', { method: 'POST', headers: H(r.bee1.token) });
    let body = (await res.json()) as { task: { id: string; lane: string; assignee: string } | null };
    assert.equal(body.task?.id, 'T2', 'P0 优先被领取');
    assert.equal(body.task.lane, 'InProgress');
    assert.equal(body.task.assignee, 'bee1');

    res = await r.app.request('/boards/b/next', { method: 'POST', headers: H(r.bee1.token) });
    body = (await res.json()) as { task: { id: string } | null };
    assert.equal(body.task?.id, 'T1');

    res = await r.app.request('/boards/b/next', { method: 'POST', headers: H(r.bee1.token) });
    body = (await res.json()) as { task: unknown | null };
    assert.equal(body.task, null, '无卡可领返回 null');

    // 主脑不得领取（只分派不执行）
    res = await r.app.request('/boards/b/next', { method: 'POST', headers: H(r.orch.token) });
    assert.equal(res.status, 403);
  } finally {
    r.rig.cleanup();
  }
});

test('T4: 文件清单互斥——重叠拒绝，不重叠放行', async () => {
  const r = mkBoardRig();
  try {
    await setupBoard(r, [
      { id: 'T1', lane: 'Ready', files: ['src/a.ts', 'README.md'], assignee: 'bee1' },
      { id: 'T2', lane: 'Ready', assignee: 'bee2' },
    ]);
    let res = await r.app.request('/tasks/T1/claim', {
      method: 'POST',
      headers: H(r.bee1.token),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, 'bee1 认领 T1（用卡上文件清单）');

    res = await r.app.request('/tasks/T2/claim', {
      method: 'POST',
      headers: H(r.bee2.token),
      body: JSON.stringify({ files: ['readme.md'] }),
    });
    assert.equal(res.status, 409, '大小写归一化后与 T1 的 README.md 冲突');
    const err = (await res.json()) as { error: string };
    assert.match(err.error, /T1/);

    res = await r.app.request('/tasks/T2/claim', {
      method: 'POST',
      headers: H(r.bee2.token),
      body: JSON.stringify({ files: ['src/b.ts'] }),
    });
    assert.equal(res.status, 200, '无重叠文件放行');
  } finally {
    r.rig.cleanup();
  }
});

test('T4: checkpoint 权限——非本任务 worker 拒绝，主脑可干预；submit 进 Review 带证据', async () => {
  const r = mkBoardRig();
  try {
    await setupBoard(r, [{ id: 'T1', lane: 'Ready', assignee: 'bee1' }]);
    await r.app.request('/tasks/T1/claim', { method: 'POST', headers: H(r.bee1.token), body: '{}' });

    let res = await r.app.request('/tasks/T1/checkpoint', {
      method: 'POST',
      headers: H(r.bee2.token),
      body: JSON.stringify({ note: '我是路人' }),
    });
    assert.equal(res.status, 403, '无关 worker 不能 checkpoint');

    res = await r.app.request('/tasks/T1/checkpoint', {
      method: 'POST',
      headers: H(r.bee1.token),
      body: JSON.stringify({ note: '进行到一半' }),
    });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { task: { lastActivityAt: number }; pendingMessages: unknown[] };
    assert.ok(body.task.lastActivityAt);
    assert.deepEqual(body.pendingMessages, [], 'T5 前为空占位');

    res = await r.app.request('/tasks/T1/checkpoint', {
      method: 'POST',
      headers: H(r.orch.token),
      body: JSON.stringify({ note: '主脑干预注入' }),
    });
    assert.equal(res.status, 200, '主脑干预可 checkpoint');

    res = await r.app.request('/tasks/T1/submit', {
      method: 'POST',
      headers: H(r.bee1.token),
      body: JSON.stringify({
        summary: '完成脚手架',
        evidence: [{ path: 'docs/report.md', machine: 'workstation', note: '结果文档' }],
      }),
    });
    assert.equal(res.status, 200);
    body = (await res.json()) as typeof body & { task: { lane: string; evidence: { path: string }[] } };
    assert.equal(body.task.lane, 'Review');
    assert.equal(body.task.evidence[0].path, 'docs/report.md');
  } finally {
    r.rig.cleanup();
  }
});

test('T4: 失联任务不自动释放；物理停止确认后受控解绑可被他人接管', async () => {
  const r = mkBoardRig(0.0005); // ~30ms TTL
  try {
    await setupBoard(r, [{ id: 'T1', lane: 'Ready', assignee: 'bee1' }]);

    let res = await r.app.request('/tasks/T1/claim', { method: 'POST', headers: H(r.bee1.token), body: '{}' });
    assert.equal(res.status, 200);

    // 验证自愿 release 已被禁用以防物理执行未终止时的写冲突（必须走物理停止确认门禁）
    res = await r.app.request('/tasks/T1/release', {
      method: 'POST',
      headers: H(r.bee1.token),
      body: JSON.stringify({ reason: '暂时让出' }),
    });
    assert.equal(res.status, 403, '自愿 release 必须报 403 阻断');

    // 任务依然保留在 InProgress 且归属 bee1，绝不自动释放
    const taskStillInProgress = getTask(r.rig.ctx, 'T1');
    assert.equal(taskStillInProgress.lane, 'InProgress');
    assert.equal(taskStillInProgress.assignee, 'bee1');

    // 等待 TTL 过期
    const { promise: p1, resolve: r1 } = Promise.withResolvers<void>();
    setTimeout(r1, 120);
    await p1;
    // bee2 调用 next 触发扫掠，失联任务安全保留 InProgress 与所有权，不被盲抢
    res = await r.app.request('/boards/b/next', { method: 'POST', headers: H(r.bee2.token) });
    let body = (await res.json()) as { task: { id: string; assignee: string } | null; swept: string[] };
    assert.deepEqual(body.swept, [], '失联任务不自动释放，保留 InProgress 与所有权');
    assert.equal(body.task, null, '未释放的任务不得被盲领');
    assert.ok(
      listEvents(r.rig.ctx).some((e) => e.type === 'task.stale_detected'),
      'stale_detected 事件落账',
    );

    // 主脑尝试解绑报 403（蜂后不可代用户确认物理停止）
    await assert.rejects(
      async () => releaseStuckTask(r.rig.ctx, r.orch.agent, 'bee1', 'T1', '主脑尝试解绑', { confirmedStopped: true }),
      /only user role may confirm worker stopped/i,
    );

    // 真实用户确认物理停止后受控解绑，建立代次栅栏
    await releaseStuckTask(r.rig.ctx, r.user.agent, 'bee1', 'T1', '用户确认失联后受控解绑', { confirmedStopped: true });
    // 主脑将解绑后的 Ready 卡真实重新分派给 bee2
    await r.app.request('/tasks/T1/dispatch', {
      method: 'POST',
      headers: H(r.orch.token),
      body: JSON.stringify({ assignee: 'bee2', content: '@bee2 接管' }),
    });

    // bee2 再次 next，成功原子认领属于自己的定向任务
    res = await r.app.request('/boards/b/next', { method: 'POST', headers: H(r.bee2.token) });
    body = (await res.json()) as { task: { id: string; assignee: string } | null };
    assert.equal(body.task?.id, 'T1');
    assert.equal(body.task.assignee, 'bee2', '他人接管成功');

    // 旧工蜂 bee1 迟到提交被阻断 (403/409)
    const lateRes = await r.app.request('/tasks/T1/submit', {
      method: 'POST',
      headers: H(r.bee1.token),
      body: JSON.stringify({ summary: '旧工蜂迟到提交' }),
    });
    assert.equal(lateRes.status, 403, '非当前指派人工蜂迟到提交必须被拒绝');
  } finally {
    r.rig.cleanup();
  }
});

test('T4: dispatch 预指派的卡——指派对象可领取，他人不可抢', async () => {
  const r = mkBoardRig();
  try {
    await setupBoard(r, [{ id: 'T1', lane: 'Ready' }]);
    const res = await r.app.request('/tasks/T1/dispatch', {
      method: 'POST',
      headers: H(r.orch.token),
      body: JSON.stringify({ assignee: 'bee1', content: '@bee1 请领取 T1' }),
    });
    assert.equal(res.status, 201);

    let claim = await r.app.request('/tasks/T1/claim', { method: 'POST', headers: H(r.bee2.token), body: '{}' });
    assert.equal(claim.status, 409, '他人不可抢指派卡');

    claim = await r.app.request('/tasks/T1/claim', { method: 'POST', headers: H(r.bee1.token), body: '{}' });
    assert.equal(claim.status, 200, '指派对象本人领取放行');
    const body = (await claim.json()) as { task: { lane: string; assignee: string } };
    assert.equal(body.task.lane, 'InProgress');
    assert.equal(body.task.assignee, 'bee1');
  } finally {
    r.rig.cleanup();
  }
});

test('T4: WIP 满 next 返回 null（背压）', async () => {
  const r = mkBoardRig();
  try {
    await setupBoard(r, [
      { id: 'T1', lane: 'Ready', assignee: 'bee1' },
      { id: 'T2', lane: 'Ready', assignee: 'bee1' },
      { id: 'T3', lane: 'Ready', assignee: 'bee1' },
      { id: 'T4', lane: 'Ready', assignee: 'bee1' },
    ]);
    const orchH = H(r.orch.token);
    for (const id of ['T1', 'T2', 'T3']) {
      await r.app.request(`/tasks/${id}/claim`, { method: 'POST', headers: H(r.bee1.token), body: '{}' });
    }
    void orchH;
    const res = await r.app.request('/boards/b/next', { method: 'POST', headers: H(r.bee1.token) });
    const body = (await res.json()) as { task: unknown | null };
    assert.equal(body.task, null, 'InProgress WIP=3 已满，next 背压返回 null');
  } finally {
    r.rig.cleanup();
  }
});
