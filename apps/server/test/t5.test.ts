import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { inboxFor, listMessages } from '../src/messages.ts';

function mkRoomRig() {
  const rig = mkRig();
  const app = createApp(rig.ctx);
  const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
  const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'zcode' });
  const other = registerAgent(rig.ctx, { name: '工蜂2', handle: 'bee2' });
  return { rig, app, orch, bee, other };
}

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function mkBoardWithTask(r: ReturnType<typeof mkRoomRig>) {
  await r.app.request('/boards', {
    method: 'POST',
    headers: H(r.orch.token),
    body: JSON.stringify({ id: 'b', name: '板' }),
  });
  await r.app.request('/boards/b/tasks', {
    method: 'POST',
    headers: H(r.orch.token),
    body: JSON.stringify({ id: 'T42', title: '演示任务' }),
  });
}

test('T5: 用户发言——@ 解析、taskRef 自动挂接、无效 token 拒绝', async () => {
  const r = mkRoomRig();
  try {
    await mkBoardWithTask(r);
    let res = await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@zcode 请领取 T42 任务，任务详情看板可见' }),
    });
    assert.equal(res.status, 201);
    let body = (await res.json()) as {
      message: { author: string; kind: string; mentions: string[]; taskRef: string | null };
    };
    assert.equal(body.message.author, 'user', '无 token 按 user');
    assert.equal(body.message.kind, 'intervention', '用户发言默认 intervention（最高优先级）');
    assert.deepEqual(body.message.mentions, ['zcode']);
    assert.equal(body.message.taskRef, 'T42', '任务号自动挂 taskRef');

    res = await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: H('ah-invalid-token'),
      body: JSON.stringify({ content: '坏 token' }),
    });
    assert.equal(res.status, 401, '带无效 token 严格拒绝，不静默降级');

    res = await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ content: '提到 T999 但不存在' }),
    });
    body = (await res.json()) as typeof body;
    assert.equal(body.message.taskRef, null, '不存在的任务号不挂');
  } finally {
    r.rig.cleanup();
  }
});

test('T5: 定向投递——@句柄 各达其主，@主脑 到 orchestrator，用户广播唤醒主脑', async () => {
  const r = mkRoomRig();
  try {
    await mkBoardWithTask(r);
    const J = H();
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ content: '@zcode 这条只给 zcode' }),
    });
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(r.bee.token),
      body: JSON.stringify({ content: '@主脑 D3 任务已完成，结论在 docs/x.md' }),
    });
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ content: '大家进度如何？' }),
    });

    assert.equal(inboxFor(r.rig.ctx, r.bee.agent, 0).length, 1, '@zcode 只进 zcode 收件箱');
    assert.equal(inboxFor(r.rig.ctx, r.other.agent, 0).length, 0, '无关 agent 收不到');
    const orchInbox = inboxFor(r.rig.ctx, r.orch.agent, 0);
    assert.equal(orchInbox.length, 2, '@主脑 + 用户广播都唤醒主脑');
    assert.ok(orchInbox.some((m) => m.mentions.includes('主脑')));
    assert.ok(orchInbox.some((m) => m.author === 'user' && m.mentions.length === 0));
  } finally {
    r.rig.cleanup();
  }
});

test('T5: submit 自动生成 @主脑 上交消息；checkpoint 按投递游标带回干预（含认领前）', async () => {
  const r = mkRoomRig();
  try {
    await mkBoardWithTask(r);
    await r.app.request('/tasks/T42', {
      method: 'PATCH',
      headers: H(r.orch.token),
      body: JSON.stringify({ lane: 'Ready' }),
    });
    // 认领前的干预（任务已 Ready、worker 未上工）
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ content: '@zcode 开工前先读 acceptance' }),
    });
    await r.app.request('/tasks/T42/claim', { method: 'POST', headers: H(r.bee.token), body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 认领后的干预
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ content: '@zcode 注意改用 pnpm' }),
    });
    let res = await r.app.request('/tasks/T42/checkpoint', {
      method: 'POST',
      headers: H(r.bee.token),
      body: JSON.stringify({ note: '两条干预都收到' }),
    });
    let body = (await res.json()) as { pendingMessages: { content: string }[] };
    assert.equal(body.pendingMessages.length, 2, '认领前后两条干预全部送达');
    assert.ok(body.pendingMessages.some((m) => m.content.includes('acceptance')));
    assert.ok(body.pendingMessages.some((m) => m.content.includes('pnpm')));

    // 游标已推进：再次 checkpoint 不重复投递
    res = await r.app.request('/tasks/T42/checkpoint', {
      method: 'POST',
      headers: H(r.bee.token),
      body: JSON.stringify({ note: '无新消息' }),
    });
    body = (await res.json()) as typeof body;
    assert.equal(body.pendingMessages.length, 0, '游标推进后不重复投递');

    res = await r.app.request('/tasks/T42/submit', {
      method: 'POST',
      headers: H(r.bee.token),
      body: JSON.stringify({ summary: '全部完成', evidence: [{ path: 'docs/x.md', machine: 'ws' }] }),
    });
    assert.equal(res.status, 200);
    const messages = listMessages(r.rig.ctx, 'b');
    const submitMsg = messages.find((m) => m.kind === 'submit');
    assert.ok(submitMsg, 'submit 自动生成聊天室消息');
    assert.ok(submitMsg.mentions.includes('主脑'));
    assert.equal(submitMsg.taskRef, 'T42');
    assert.match(submitMsg.content, /T42 已完成/);
  } finally {
    r.rig.cleanup();
  }
});

test('T5: 分派双通道——一次调用完成指派 + 房间 @ 消息', async () => {
  const r = mkRoomRig();
  try {
    await mkBoardWithTask(r);
    const res = await r.app.request('/tasks/T42/dispatch', {
      method: 'POST',
      headers: H(r.orch.token),
      body: JSON.stringify({ assignee: 'zcode', content: '@zcode 请领取 T42 任务，验收标准见卡片' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      task: { assignee: string };
      message: { kind: string; mentions: string[]; taskRef: string | null };
    };
    assert.equal(body.task.assignee, 'zcode', '指派落卡');
    assert.equal(body.message.kind, 'dispatch');
    assert.deepEqual(body.message.mentions, ['zcode']);
    assert.equal(body.message.taskRef, 'T42');

    // worker 不能用分派工具
    const denied = await r.app.request('/tasks/T42/dispatch', {
      method: 'POST',
      headers: H(r.bee.token),
      body: JSON.stringify({ content: '@bee2 干活' }),
    });
    assert.equal(denied.status, 403);
  } finally {
    r.rig.cleanup();
  }
});

test('T5: 消息事件经总线实时发布（SSE 数据源）', async () => {
  const r = mkRoomRig();
  try {
    await mkBoardWithTask(r);
    const seen: string[] = [];
    const unsub = r.rig.ctx.bus.subscribe((type) => seen.push(type));
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ content: '@zcode 总线验证 T42' }),
    });
    unsub();
    assert.ok(seen.includes('message.created'), 'message.created 实时进总线（SSE 下发）');
  } finally {
    r.rig.cleanup();
  }
});

test('Phase 3: 蜂群别名路由——@Queen/@蜂后到主脑，@Bee/@工蜂广播到全体worker', async () => {
  const r = mkRoomRig();
  try {
    await mkBoardWithTask(r);
    const J = H();
    // 1. @Queen 发言
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ content: '@Queen 请启动阶段 3 规划' }),
    });
    // 2. @蜂后 发言
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(r.bee.token),
      body: JSON.stringify({ content: '@蜂后 T42 任务已准备妥当' }),
    });
    // 3. @Bee 广播给工蜂
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ content: '@Bee 全体工蜂统一使用临时工作区' }),
    });
    // 4. @工蜂 广播
    await r.app.request('/boards/b/messages', {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ content: '@工蜂 留意代码提交证据' }),
    });

    const orchInbox = inboxFor(r.rig.ctx, r.orch.agent, 0);
    // 主脑收到：@Queen + @蜂后（注意两人的消息都指明了主脑别名）
    assert.ok(orchInbox.some((m) => m.content.includes('@Queen')), '主脑收到 @Queen');
    assert.ok(orchInbox.some((m) => m.content.includes('@蜂后')), '主脑收到 @蜂后');
    assert.ok(!orchInbox.some((m) => m.content.includes('@Bee')), '主脑不应收到纯 @Bee 广播');

    const beeInbox = inboxFor(r.rig.ctx, r.bee.agent, 0);
    const otherInbox = inboxFor(r.rig.ctx, r.other.agent, 0);
    // 全体 worker 都收到 @Bee 与 @工蜂
    assert.ok(beeInbox.some((m) => m.content.includes('@Bee')), '工蜂 1 收到 @Bee');
    assert.ok(beeInbox.some((m) => m.content.includes('@工蜂')), '工蜂 1 收到 @工蜂');
    assert.ok(otherInbox.some((m) => m.content.includes('@Bee')), '工蜂 2 收到 @Bee');
    assert.ok(otherInbox.some((m) => m.content.includes('@工蜂')), '工蜂 2 收到 @工蜂');
    assert.ok(!beeInbox.some((m) => m.content.includes('@Queen')), '工蜂不应收到纯 @Queen');
  } finally {
    r.rig.cleanup();
  }
});
