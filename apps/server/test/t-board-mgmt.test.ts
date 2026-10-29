import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { listEvents } from '../src/write.ts';

// 看板=项目管理：元数据（名称/仓库/描述）+ 参与者开关 + 级联删除
interface Rig {
  rig: ReturnType<typeof mkRig>;
  app: ReturnType<typeof createApp>;
  orch: { agent: Agent; token: string };
  bee1: { agent: Agent; token: string };
  bee2: { agent: Agent; token: string };
}

function mkBoardRig(): Rig {
  const rig = mkRig();
  const app = createApp(rig.ctx);
  const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
  const bee1 = registerAgent(rig.ctx, { name: '工蜂1', handle: 'bee1' });
  const bee2 = registerAgent(rig.ctx, { name: '工蜂2', handle: 'bee2' });
  return { rig, app, orch, bee1, bee2 };
}

function H(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

const JSON_H = { 'content-type': 'application/json' };

// 匿名建板 + 三张 Ready 卡（零令牌即 user 全权限）
async function setupBoardWithTasks(r: Rig, n = 3): Promise<void> {
  const res = await r.app.request('/boards', {
    method: 'POST',
    headers: JSON_H,
    body: JSON.stringify({ id: 'b', name: '板' }),
  });
  assert.equal(res.status, 201);
  for (let i = 1; i <= n; i++) {
    const t = await r.app.request('/boards/b/tasks', {
      method: 'POST',
      headers: JSON_H,
      body: JSON.stringify({ id: `T${i}`, title: `卡${i}`, lane: 'Ready', files: [`task-${i}.ts`] }),
    });
    assert.equal(t.status, 201);
  }
}

test('看板仓库模式: 新建 managed 空仓状态，兼容旧 repo API 仍为 remote-legacy', async () => {
  const { rig, app } = mkBoardRig();
  try {
    const created = await app.request('/boards', {
      method: 'POST', headers: JSON_H,
      body: JSON.stringify({ id: 'empty-managed', name: '空仓', repoMode: 'managed', repoInit: 'empty' }),
    });
    assert.equal(created.status, 201);
    const payload = (await created.json()) as { board: { repoMode: string; repoStatus: string; repo: string } };
    assert.equal(payload.board.repoMode, 'managed');
    assert.ok(['empty', 'queued', 'running', 'ready'].includes(payload.board.repoStatus));
    assert.equal(payload.board.repo, '');
    const status = await app.request('/boards/empty-managed/repo');
    assert.equal(status.status, 200);
    const projection = (await status.json()) as { mode: string; status: string };
    assert.deepEqual(projection, { boardId: 'empty-managed', mode: 'managed', status: 'ready', head: '', error: '' });
  } finally {
    rig.cleanup();
  }
});


test('看板管理: PATCH 改名/repo/description 落库、匿名可改、事件落账', async () => {
  const { rig, app } = mkBoardRig();
  try {
    // 建板时直接带元数据
    let res = await app.request('/boards', {
      method: 'POST',
      headers: JSON_H,
      body: JSON.stringify({ id: 'demo', name: '旧名', repo: 'github.com/old/old', description: '旧描述' }),
    });
    assert.equal(res.status, 201);
    let body = (await res.json()) as { board: { repo: string; repoMode: string; repoStatus: string; description: string } };
    assert.equal(body.board.repo, 'github.com/old/old');
    assert.equal(body.board.repoMode, 'remote-legacy', '旧 API 传 repo URL 默认保留 worker clone 兼容模式');
    assert.equal(body.board.repoStatus, 'ready');
    assert.equal(body.board.description, '旧描述');

    // 匿名 PATCH（零令牌语义：无 Authorization 即 user，全权限）
    res = await app.request('/boards/demo', {
      method: 'PATCH',
      headers: JSON_H,
      body: JSON.stringify({ name: '新项目', repo: 'github.com/org/repo', description: '项目说明' }),
    });
    assert.equal(res.status, 200);
    body = (await res.json()) as typeof body;
    assert.equal(body.board.name, '新项目');
    assert.equal(body.board.repo, 'github.com/org/repo');
    assert.equal(body.board.description, '项目说明');

    // GET /boards 投影带出元数据
    res = await app.request('/boards');
    const boards = (await res.json()) as { boards: { id: string; name: string; repo: string }[] };
    const demo = boards.boards.find((b) => b.id === 'demo')!;
    assert.equal(demo.name, '新项目');
    assert.equal(demo.repo, 'github.com/org/repo');

    // 部分更新：只传 description 也行，其余字段不动
    res = await app.request('/boards/demo', {
      method: 'PATCH',
      headers: JSON_H,
      body: JSON.stringify({ description: '只改描述' }),
    });
    assert.equal(res.status, 200);
    body = (await res.json()) as typeof body;
    assert.equal(body.board.description, '只改描述');
    assert.equal(body.board.name, '新项目', '未传字段保持不变');

    // 事件台账：board.updated 记录变更字段
    assert.ok(
      listEvents(rig.ctx).some(
        (e) =>
          e.type === 'board.updated' &&
          e.payload.boardId === 'demo' &&
          JSON.stringify(e.payload.fields) === JSON.stringify(['description']),
      ),
      'board.updated 事件落账',
    );

    // 不存在的板 404；worker token 403（requireElevated 信任分层）
    res = await app.request('/boards/nope', { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ name: 'x' }) });
    assert.equal(res.status, 404);

    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'bee9' });
    res = await app.request('/boards/demo', {
      method: 'PATCH',
      headers: H(worker.token),
      body: JSON.stringify({ name: '越权' }),
    });
    assert.equal(res.status, 403, 'worker token 不可改看板元数据');
  } finally {
    rig.cleanup();
  }
});

test('参与者: PUT/GET 全量覆盖、未知 agent 拒绝、非法载荷 422', async () => {
  const r = mkBoardRig();
  const { rig, app, bee1, bee2 } = r;
  try {
    await setupBoardWithTasks(r, 0);

    // 设置两个参与者
    let res = await app.request('/boards/b/participants', {
      method: 'PUT',
      headers: JSON_H,
      body: JSON.stringify({ agentIds: [bee1.agent.id, bee2.agent.id] }),
    });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { agentIds: string[] };
    assert.deepEqual([...body.agentIds].sort(), [bee1.agent.id, bee2.agent.id].sort());

    // GET 读回一致
    res = await app.request('/boards/b/participants');
    body = (await res.json()) as typeof body;
    assert.deepEqual([...body.agentIds].sort(), [bee1.agent.id, bee2.agent.id].sort());

    // 全量覆盖：只留 bee1
    res = await app.request('/boards/b/participants', {
      method: 'PUT',
      headers: JSON_H,
      body: JSON.stringify({ agentIds: [bee1.agent.id] }),
    });
    assert.equal(res.status, 200);
    res = await app.request('/boards/b/participants');
    body = (await res.json()) as typeof body;
    assert.deepEqual(body.agentIds, [bee1.agent.id], '全量覆盖生效');

    // 未知 agent 404；非法载荷 422
    res = await app.request('/boards/b/participants', {
      method: 'PUT',
      headers: JSON_H,
      body: JSON.stringify({ agentIds: ['ghost'] }),
    });
    assert.equal(res.status, 404);

    res = await app.request('/boards/b/participants', {
      method: 'PUT',
      headers: JSON_H,
      body: JSON.stringify({ agentIds: 'bee1' }),
    });
    assert.equal(res.status, 422);

    // 事件台账
    assert.ok(listEvents(rig.ctx).some((e) => e.type === 'board.participants_set'), 'participants_set 事件落账');
  } finally {
    rig.cleanup();
  }
});

test('参与限制: 空列表开放、列表外 worker 403、列表内正常、user/orchestrator 豁免、dispatch 422', async () => {
  const r = mkBoardRig();
  const { rig, app, orch, bee1, bee2 } = r;
  try {
    await setupBoardWithTasks(r, 3);

    // 空列表 = 开放给全部（向后兼容）：派给 bee2 的卡，列表外的 bee2 也能 next
    await r.app.request('/tasks/T1/dispatch', {
      method: 'POST',
      headers: H(orch.token),
      body: JSON.stringify({ content: '@bee2 请处理 T1', assignee: bee2.agent.id }),
    });
    let res = await app.request('/boards/b/next', { method: 'POST', headers: H(bee2.token) });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { task: { id: string } | null };
    assert.equal(body.task?.id, 'T1', '空参与者列表不限制');

    // 设置参与者：仅 bee1
    res = await app.request('/boards/b/participants', {
      method: 'PUT',
      headers: JSON_H,
      body: JSON.stringify({ agentIds: [bee1.agent.id] }),
    });
    assert.equal(res.status, 200);

    // 列表外 worker：next 与 claim 都 403
    res = await app.request('/boards/b/next', { method: 'POST', headers: H(bee2.token) });
    assert.equal(res.status, 403, '列表外 worker next 被拒');
    let err = (await res.json()) as { error: string };
    assert.match(err.error, /not a participant/);

    res = await app.request('/tasks/T2/claim', { method: 'POST', headers: H(bee2.token), body: '{}' });
    assert.equal(res.status, 403, '列表外 worker claim 被拒');

    // 派给 bee1：列表内 worker 正常
    await r.app.request('/tasks/T2/dispatch', {
      method: 'POST',
      headers: H(orch.token),
      body: JSON.stringify({ content: '@bee1 请处理 T2', assignee: bee1.agent.id }),
    });
    res = await app.request('/boards/b/next', { method: 'POST', headers: H(bee1.token) });
    assert.equal(res.status, 200);
    body = (await res.json()) as typeof body;
    assert.equal(body.task?.id, 'T2', '列表内 worker 正常领取');

    // user 豁免（匿名即 user）
    await r.app.request('/tasks/T3/dispatch', {
      method: 'POST',
      headers: H(orch.token),
      body: JSON.stringify({ content: '@user 请处理 T3', assignee: 'user' }),
    });
    res = await app.request('/boards/b/next', { method: 'POST', headers: JSON_H });
    assert.equal(res.status, 200, 'user 角色豁免参与限制');
    body = (await res.json()) as typeof body;
    assert.equal(body.task?.id, 'T3');
    // 新建 T4 留在 Ready，用于后续参与限制与角色豁免验证（活跃 InProgress 卡一律不可改派，不能拿 T1 验证豁免）
    res = await app.request('/boards/b/tasks', {
      method: 'POST',
      headers: JSON_H,
      body: JSON.stringify({ id: 'T4', title: '卡4', lane: 'Ready' }),
    });
    assert.equal(res.status, 201);
    // orchestrator 豁免：作为被派者（非 worker）不受列表约束
    res = await app.request('/tasks/T4/dispatch', {
      method: 'POST',
      headers: H(orch.token),
      body: JSON.stringify({ assignee: orch.agent.id, content: '@brain-a 主脑自留' }),
    });
    assert.equal(res.status, 201, 'orchestrator 被派不受参与限制');

    // dispatch 给列表外 worker → 422
    res = await app.request('/tasks/T4/dispatch', {
      method: 'POST',
      headers: H(orch.token),
      body: JSON.stringify({ assignee: 'bee2', content: '@bee2 请领取 T4' }),
    });
    assert.equal(res.status, 422, 'dispatch 给列表外 worker 被拒');
    err = (await res.json()) as { error: string };
    assert.match(err.error, /assignee not a participant/);

    // dispatch 给列表内 worker → 201
    res = await app.request('/tasks/T4/dispatch', {
      method: 'POST',
      headers: H(orch.token),
      body: JSON.stringify({ assignee: 'bee1', content: '@bee1 请领取 T4' }),
    });
    assert.equal(res.status, 201, 'dispatch 给列表内 worker 放行');
    // T4 已验证 orchestrator 豁免、列表外 422、列表内 201；T1 保持 InProgress 由活跃锁保护，不再改派
  } finally {
    rig.cleanup();
  }
});

test('活跃执行不可改派: InProgress 卡对任何被派者（worker/orchestrator/user/未知）一律 409，指派/代次/消息不变', async () => {
  const r = mkBoardRig();
  const { rig, app, orch, bee1, bee2 } = r;
  try {
    await setupBoardWithTasks(r, 1);
    // 两个工蜂都入参与者列表，确保 409 只可能来自 InProgress 活跃锁而非参与限制
    let res = await app.request('/boards/b/participants', {
      method: 'PUT',
      headers: JSON_H,
      body: JSON.stringify({ agentIds: [bee1.agent.id, bee2.agent.id] }),
    });
    assert.equal(res.status, 200);

    // 派给 bee1 并认领 → InProgress（attempt 1）
    res = await app.request('/tasks/T1/dispatch', {
      method: 'POST',
      headers: H(orch.token),
      body: JSON.stringify({ assignee: bee1.agent.id, content: '@bee1 请处理 T1' }),
    });
    assert.equal(res.status, 201);
    res = await app.request('/tasks/T1/claim', { method: 'POST', headers: H(bee1.token), body: '{}' });
    assert.equal(res.status, 200);
    const claimBody = (await res.json()) as { task: { lane: string; assignee: string; attempt: number } };
    const task = claimBody.task;
    assert.equal(task.lane, 'InProgress');
    assert.equal(task.assignee, bee1.agent.id);
    assert.equal(task.attempt, 1);

    const dispatchMessages = async (): Promise<number> => {
      const response = await app.request('/boards/b/messages');
      const msgBody = (await response.json()) as {
        messages: { kind: string; taskRef: string | null }[];
      };
      return msgBody.messages.filter((msg) => msg.kind === 'dispatch' && msg.taskRef === 'T1').length;
    };
    const before = await dispatchMessages();
    assert.equal(before, 1, '认领前那次预指派产生 1 条 dispatch 消息');

    // 四种被派者变体全部必须 409，且不得改变指派/代次、不得新增 dispatch 消息
    const variants: { label: string; assignee: string }[] = [
      { label: 'worker', assignee: bee2.agent.id },
      { label: 'orchestrator', assignee: orch.agent.id },
      { label: 'user', assignee: 'user' },
      { label: 'unknown', assignee: 'ghost' },
    ];
    for (const v of variants) {
      res = await app.request('/tasks/T1/dispatch', {
        method: 'POST',
        headers: H(orch.token),
        body: JSON.stringify({ assignee: v.assignee, content: `@${v.assignee} 接管 T1` }),
      });
      assert.equal(res.status, 409, `InProgress 卡改派给 ${v.label} 必须 409`);
      const taskResponse = await app.request('/tasks/T1');
      const tBody = (await taskResponse.json()) as {
        task: { lane: string; assignee: string; attempt: number };
      };
      const t = tBody.task;
      assert.equal(t.lane, 'InProgress', `${v.label} 改派后 lane 不变`);
      assert.equal(t.assignee, bee1.agent.id, `${v.label} 改派后 assignee 不变`);
      assert.equal(t.attempt, 1, `${v.label} 改派后 attempt 不变`);
      assert.equal(await dispatchMessages(), before, `${v.label} 改派不产生 dispatch 消息`);
    }
  } finally {
    rig.cleanup();
  }
});

test('删除: 级联清空任务/消息/参与者、事件台账保留、再删 404', async () => {
  const r = mkBoardRig();
  const { rig, app, bee1 } = r;
  try {
    await setupBoardWithTasks(r, 2);
    // 发一条消息、设置一个参与者
    let res = await app.request('/boards/b/messages', {
      method: 'POST',
      headers: JSON_H,
      body: JSON.stringify({ content: '开工前留痕' }),
    });
    assert.equal(res.status, 201);
    res = await app.request('/boards/b/participants', {
      method: 'PUT',
      headers: JSON_H,
      body: JSON.stringify({ agentIds: [bee1.agent.id] }),
    });
    assert.equal(res.status, 200);

    const eventsBefore = listEvents(rig.ctx).length;
    assert.ok(eventsBefore > 0);

    // 删除（匿名即 user）
    res = await app.request('/boards/b', { method: 'DELETE', headers: JSON_H });
    assert.equal(res.status, 200);
    const delBody = (await res.json()) as { ok: boolean; taskCount: number };
    assert.equal(delBody.ok, true);
    assert.equal(delBody.taskCount, 2, '事件负载报出级联删除的任务数');

    // 板没了
    res = await app.request('/boards');
    const boards = (await res.json()) as { boards: { id: string }[] };
    assert.equal(boards.boards.some((b) => b.id === 'b'), false);

    // 任务跟着消失（getBoard 404 路径）
    res = await app.request('/boards/b/tasks');
    assert.equal(res.status, 404);

    // 直查库：任务/消息/参与者全清，板行删除
    const db = rig.ctx.holder.db;
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM task WHERE board_id = 'b'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM message WHERE board_id = 'b'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM board_participant WHERE board_id = 'b'").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM board WHERE id = 'b'").get() as { n: number }).n, 0);

    // 事件台账是追加式历史：只增不减，board.deleted 落账
    const eventsAfter = listEvents(rig.ctx);
    assert.ok(eventsAfter.length > eventsBefore, '事件台账只增不减');
    const deleted = eventsAfter.find((e) => e.type === 'board.deleted');
    assert.ok(deleted, 'board.deleted 事件落账');
    assert.equal(deleted!.payload.boardId, 'b');
    assert.equal(deleted!.payload.taskCount, 2);
    assert.ok(
      eventsAfter.some((e) => e.type === 'board.created' && e.payload.boardId === 'b'),
      '历史 board.created 事件保留',
    );

    // 再删 404
    res = await app.request('/boards/b', { method: 'DELETE', headers: JSON_H });
    assert.equal(res.status, 404);
  } finally {
    rig.cleanup();
  }
});
