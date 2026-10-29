import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig, type TestRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { createBoard, createTask, getTask } from '../src/tasks.ts';
import { claimTask, nextTask, submitTask } from '../src/verbs.ts';
import { listEvents } from '../src/write.ts';

function H(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

interface Rig {
  rig: TestRig;
  app: ReturnType<typeof createApp>;
  bee1: { agent: Agent; token: string };
  bee2: { agent: Agent; token: string };
}

function mkRig2(): Rig {
  const rig = mkRig();
  const app = createApp(rig.ctx);
  const bee1 = registerAgent(rig.ctx, { id: 'bee1', name: '工蜂1', handle: 'bee1' });
  const bee2 = registerAgent(rig.ctx, { id: 'bee2', name: '工蜂2', handle: 'bee2' });
  return { rig, app, bee1, bee2 };
}

function is409(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: number }).status === 409;
}

function is422(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: number }).status === 422;
}

test('C: 同卡竞争——并发认领最终仅一人归属，重复认领 409 且状态不变', async () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-race', name: 'Race' });
    createTask(r.rig.ctx, 'b-race', { id: 'RACE-1', title: 'race', lane: 'Ready', assignee: 'bee1', files: ['src/a.ts'] });

    const [res1, res2] = await Promise.all([
      r.app.request('/tasks/RACE-1/claim', { method: 'POST', headers: H(r.bee1.token), body: '{}' }),
      r.app.request('/tasks/RACE-1/claim', { method: 'POST', headers: H(r.bee1.token), body: '{}' }),
    ]);
    assert.deepEqual([res1.status, res2.status].sort(), [200, 409], '同卡并发认领必须一成一败');

    const task = getTask(r.rig.ctx, 'RACE-1');
    assert.equal(task.lane, 'InProgress');
    assert.equal(task.assignee, 'bee1', '最终归属为成功方');
    assert.equal(task.attempt, 1, '重复认领不得自增代次');
    assert.equal(
      listEvents(r.rig.ctx, { type: 'task.claimed', limit: 10 }).filter((e) => e.payload.taskId === 'RACE-1').length,
      1,
      '仅一次认领事件落账',
    );

    const foreign = await r.app.request('/tasks/RACE-1/claim', { method: 'POST', headers: H(r.bee2.token), body: '{}' });
    assert.equal(foreign.status, 409, '他人不可冒领已认领任务');
    assert.equal(getTask(r.rig.ctx, 'RACE-1').assignee, 'bee1', '冒领失败不得改变归属');
  } finally {
    r.rig.cleanup();
  }
});

test('C: next 与 claim 竞争——同一任务只能被一方原子认领', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-nc', name: 'NC' });
    createTask(r.rig.ctx, 'b-nc', { id: 'NC-1', title: 't1', lane: 'Ready', assignee: 'bee1' });
    createTask(r.rig.ctx, 'b-nc', { id: 'NC-2', title: 't2', lane: 'Ready', assignee: 'bee2' });

    // bee1 用 next 领取 NC-1
    const n1 = nextTask(r.rig.ctx, r.bee1.agent, 'b-nc');
    assert.equal(n1.task?.id, 'NC-1');
    assert.equal(n1.task?.lane, 'InProgress');

    // bee2 直接 claim NC-1 → 409（他人任务）
    assert.throws(() => claimTask(r.rig.ctx, r.bee2.agent, 'NC-1'), is409, 'next 已认领的任务他人 claim 必须 409');

    // bee2 直接 claim NC-2 先领取，bee1 next 不得再领 NC-2
    const c2 = claimTask(r.rig.ctx, r.bee2.agent, 'NC-2');
    assert.equal(c2.assignee, 'bee2');
    const n2 = nextTask(r.rig.ctx, r.bee1.agent, 'b-nc');
    assert.equal(n2.task, null, '已被直接认领的任务 next 不得重复领取');
    assert.equal(getTask(r.rig.ctx, 'NC-2').assignee, 'bee2', '最终归属保持直接认领方');
  } finally {
    r.rig.cleanup();
  }
});

test('C: 直接认领受 WIP 约束——与 next 同一容量判定', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-wip', name: 'WIP', wip: { InProgress: 2 } });
    for (const id of ['W1', 'W2', 'W3']) {
      createTask(r.rig.ctx, 'b-wip', { id, title: id, lane: 'Ready', assignee: 'bee1' });
    }
    assert.equal(claimTask(r.rig.ctx, r.bee1.agent, 'W1').lane, 'InProgress');
    assert.equal(claimTask(r.rig.ctx, r.bee1.agent, 'W2').lane, 'InProgress');
    assert.throws(
      () => claimTask(r.rig.ctx, r.bee1.agent, 'W3'),
      (e) => is409(e) && /WIP/i.test((e as { message: string }).message),
      '超 WIP 的直接认领必须 409',
    );
    const w3 = getTask(r.rig.ctx, 'W3');
    assert.equal(w3.lane, 'Ready', '超 WIP 认领失败，卡保持 Ready');
    assert.equal(w3.assignee, 'bee1');
    const n = nextTask(r.rig.ctx, r.bee1.agent, 'b-wip');
    assert.equal(n.task, null, 'next 同样被 WIP 背压');
  } finally {
    r.rig.cleanup();
  }
});

test('C: 文件互斥覆盖目录/后代与通配符', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-f', name: 'Files', wip: { InProgress: 10 } });
    createTask(r.rig.ctx, 'b-f', { id: 'F1', title: 'f1', lane: 'Ready', assignee: 'bee1', files: ['src/a.ts'] });
    claimTask(r.rig.ctx, r.bee1.agent, 'F1');

    // 祖先目录声明与子文件互斥
    createTask(r.rig.ctx, 'b-f', { id: 'F2', title: 'f2', lane: 'Ready', assignee: 'bee2', files: ['src'] });
    assert.throws(() => claimTask(r.rig.ctx, r.bee2.agent, 'F2'), is409, '目录声明与子文件互斥');

    // 文件的后代路径互斥
    createTask(r.rig.ctx, 'b-f', { id: 'F3', title: 'f3', lane: 'Ready', assignee: 'bee2', files: ['src/a.ts/b.ts'] });
    assert.throws(() => claimTask(r.rig.ctx, r.bee2.agent, 'F3'), is409, '文件的后代路径互斥');

    // 非后代（同名前缀文件）不冲突
    createTask(r.rig.ctx, 'b-f', { id: 'F4', title: 'f4', lane: 'Ready', assignee: 'bee2', files: ['src/a.ts.bak'] });
    assert.equal(claimTask(r.rig.ctx, r.bee2.agent, 'F4').lane, 'InProgress', '非后代文件放行');

    // 通配符目录与具体文件互斥
    createTask(r.rig.ctx, 'b-f', { id: 'F5', title: 'f5', lane: 'Ready', assignee: 'bee1', files: ['src/**'] });
    assert.throws(() => claimTask(r.rig.ctx, r.bee1.agent, 'F5'), is409, '通配符目录与具体文件互斥');

    // 通配符范围外不冲突
    createTask(r.rig.ctx, 'b-f', { id: 'F6', title: 'f6', lane: 'Ready', assignee: 'bee1', files: ['docs/**'] });
    assert.equal(claimTask(r.rig.ctx, r.bee1.agent, 'F6').lane, 'InProgress', '通配符范围外放行');
  } finally {
    r.rig.cleanup();
  }
});

test('C: 空写集保守互斥——未知写集阻塞同仓库已声明写任务，noCode 只读放行', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-e', name: 'Empty', wip: { InProgress: 10 } });
    createTask(r.rig.ctx, 'b-e', { id: 'E1', title: 'e1', lane: 'Ready', assignee: 'bee1' });
    claimTask(r.rig.ctx, r.bee1.agent, 'E1'); // 空写集（未知写范围）代码任务

    // 声明了具体文件的任务与未知写集任务互斥（未知写集可能写入该文件）
    createTask(r.rig.ctx, 'b-e', { id: 'E3', title: 'e3', lane: 'Ready', assignee: 'bee2', files: ['x.ts'] });
    assert.throws(() => claimTask(r.rig.ctx, r.bee2.agent, 'E3'), is409, '未知写集任务阻塞同仓库已声明写任务');

    // noCode 只读任务：空写集放行
    createTask(r.rig.ctx, 'b-e', { id: 'E4', title: 'e4', lane: 'Ready', assignee: 'bee2', workspace: { noCode: true } });
    assert.equal(claimTask(r.rig.ctx, r.bee2.agent, 'E4').lane, 'InProgress', 'noCode 只读任务不受空写集互斥限制');
  } finally {
    r.rig.cleanup();
  }
});

test('C: noCode 只读任务不阻塞他人写任务', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-e2', name: 'Empty2', wip: { InProgress: 10 } });
    createTask(r.rig.ctx, 'b-e2', { id: 'N1', title: 'n1', lane: 'Ready', assignee: 'bee1', workspace: { noCode: true } });
    claimTask(r.rig.ctx, r.bee1.agent, 'N1');
    createTask(r.rig.ctx, 'b-e2', { id: 'N2', title: 'n2', lane: 'Ready', assignee: 'bee2', files: ['y.ts'] });
    assert.equal(claimTask(r.rig.ctx, r.bee2.agent, 'N2').lane, 'InProgress', 'noCode 任务不阻塞他人写任务');
  } finally {
    r.rig.cleanup();
  }
});

test('C: 非法文件路径拒绝——绝对路径、..、盘符、空段；Windows 语义归一化', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-p', name: 'Paths', wip: { InProgress: 10 } });
    createTask(r.rig.ctx, 'b-p', { id: 'P1', title: 'p1', lane: 'Ready', assignee: 'bee1' });
    for (const bad of ['/etc/passwd', '../secret', 'C:\\Windows\\x', 'C:/x', 'src//a.ts', 'src/.', 'a/../b']) {
      assert.throws(() => claimTask(r.rig.ctx, r.bee1.agent, 'P1', [bad]), is422, `非法路径应 422: ${bad}`);
    }
    assert.equal(getTask(r.rig.ctx, 'P1').lane, 'Ready', '非法认领不得改变状态');

    // 创建任务时同样拒绝非法 files
    assert.throws(
      () => createTask(r.rig.ctx, 'b-p', { id: 'P2', title: 'p2', lane: 'Ready', files: ['../x'] }),
      is422,
      '创建任务时非法 files 应 422',
    );

    // Windows 分隔符与大小写归一化后互斥
    createTask(r.rig.ctx, 'b-p', { id: 'P3', title: 'p3', lane: 'Ready', assignee: 'bee1', files: ['src\\A.ts'] });
    const c3 = claimTask(r.rig.ctx, r.bee1.agent, 'P3');
    assert.deepEqual(c3.files, ['src/a.ts'], 'Windows 分隔符与大小写归一化存储');
    createTask(r.rig.ctx, 'b-p', { id: 'P4', title: 'p4', lane: 'Ready', assignee: 'bee2', files: ['src/a.ts'] });
    assert.throws(() => claimTask(r.rig.ctx, r.bee2.agent, 'P4'), is409, '归一化后同路径互斥');
  } finally {
    r.rig.cleanup();
  }
});

test('C: 跨看板共享仓库互斥，不同仓库放行', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-s1', name: 'S1', repo: 'https://github.com/x/shared.git' });
    createBoard(r.rig.ctx, { id: 'b-s2', name: 'S2', repo: 'https://github.com/x/shared.git' });
    createBoard(r.rig.ctx, { id: 'b-o', name: 'Other', repo: 'https://github.com/x/other.git' });

    createTask(r.rig.ctx, 'b-s1', { id: 'S1-1', title: 's1', lane: 'Ready', assignee: 'bee1', files: ['src/a.ts'] });
    claimTask(r.rig.ctx, r.bee1.agent, 'S1-1');

    // 同 repo 另一看板：同路径互斥
    createTask(r.rig.ctx, 'b-s2', { id: 'S2-1', title: 's2', lane: 'Ready', assignee: 'bee2', files: ['src/a.ts'] });
    assert.throws(() => claimTask(r.rig.ctx, r.bee2.agent, 'S2-1'), is409, '共享仓库跨看板同路径互斥');

    // 同 repo 不同路径放行
    createTask(r.rig.ctx, 'b-s2', { id: 'S2-2', title: 's2b', lane: 'Ready', assignee: 'bee2', files: ['src/b.ts'] });
    assert.equal(claimTask(r.rig.ctx, r.bee2.agent, 'S2-2').lane, 'InProgress');

    // 不同仓库：同路径放行
    createTask(r.rig.ctx, 'b-o', { id: 'O-1', title: 'o', lane: 'Ready', assignee: 'bee2', files: ['src/a.ts'] });
    assert.equal(claimTask(r.rig.ctx, r.bee2.agent, 'O-1').lane, 'InProgress', '不同仓库同路径不互斥');
  } finally {
    r.rig.cleanup();
  }
});

test('C: Review 并发提交撞 WIP——提交与 WIP 判定同一事务', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-r', name: 'Review', wip: { Review: 2 } });
    for (const id of ['R1', 'R2', 'R3']) {
      createTask(r.rig.ctx, 'b-r', { id, title: id, lane: 'Ready', assignee: 'bee1' });
      claimTask(r.rig.ctx, r.bee1.agent, id);
    }
    submitTask(r.rig.ctx, r.bee1.agent, 'R1', { summary: 'done1', attempt: 1 });
    submitTask(r.rig.ctx, r.bee1.agent, 'R2', { summary: 'done2', attempt: 1 });
    assert.throws(
      () => submitTask(r.rig.ctx, r.bee1.agent, 'R3', { summary: 'done3', attempt: 1 }),
      (e) => is409(e) && /WIP/i.test((e as { message: string }).message),
      '超 Review WIP 的提交必须 409',
    );
    assert.equal(getTask(r.rig.ctx, 'R3').lane, 'InProgress', '超 Review WIP 的提交被拒，任务保持 InProgress');
  } finally {
    r.rig.cleanup();
  }
});

test('C: next 跳过文件冲突卡，领取下一张可执行卡', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-nx', name: 'NX', wip: { InProgress: 10 } });
    createTask(r.rig.ctx, 'b-nx', { id: 'NX-1', title: 'nx1', lane: 'Ready', assignee: 'bee1', files: ['src/a.ts'] });
    claimTask(r.rig.ctx, r.bee1.agent, 'NX-1');

    // bee2 有两张卡：NX-2 与 NX-1 文件冲突（更高优先级），NX-3 不冲突
    createTask(r.rig.ctx, 'b-nx', { id: 'NX-2', title: 'nx2', lane: 'Ready', priority: 'P0', assignee: 'bee2', files: ['src/a.ts'] });
    createTask(r.rig.ctx, 'b-nx', { id: 'NX-3', title: 'nx3', lane: 'Ready', assignee: 'bee2', files: ['src/b.ts'] });

    const n = nextTask(r.rig.ctx, r.bee2.agent, 'b-nx');
    assert.equal(n.task?.id, 'NX-3', '冲突卡跳过，领取下一张');
    assert.equal(getTask(r.rig.ctx, 'NX-2').lane, 'Ready', '冲突卡保持 Ready 等待');
    assert.equal(getTask(r.rig.ctx, 'NX-3').lane, 'InProgress');
  } finally {
    r.rig.cleanup();
  }
});

test('C: claim 提供的文件清单覆盖任务声明并参与互斥', () => {
  const r = mkRig2();
  try {
    createBoard(r.rig.ctx, { id: 'b-o2', name: 'Override', wip: { InProgress: 10 } });
    createTask(r.rig.ctx, 'b-o2', { id: 'O2-1', title: 'o1', lane: 'Ready', assignee: 'bee1', files: ['a.ts'] });
    const c1 = claimTask(r.rig.ctx, r.bee1.agent, 'O2-1', ['b.ts']);
    assert.deepEqual(c1.files, ['b.ts'], 'claim 文件清单覆盖任务声明');

    createTask(r.rig.ctx, 'b-o2', { id: 'O2-2', title: 'o2', lane: 'Ready', assignee: 'bee2', files: ['b.ts'] });
    assert.throws(() => claimTask(r.rig.ctx, r.bee2.agent, 'O2-2'), is409, 'claim 清单参与互斥');

    createTask(r.rig.ctx, 'b-o2', { id: 'O2-3', title: 'o3', lane: 'Ready', assignee: 'bee2', files: ['a.ts'] });
    assert.equal(claimTask(r.rig.ctx, r.bee2.agent, 'O2-3').lane, 'InProgress', '未被 claim 覆盖的声明路径不参与互斥');
  } finally {
    r.rig.cleanup();
  }
});
