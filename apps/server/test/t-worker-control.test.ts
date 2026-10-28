import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { createBoard, createTask, getTask } from '../src/tasks.ts';
import { claimTask } from '../src/verbs.ts';
import { listEvents } from '../src/write.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';
import {
  setWorkerControlDriverForTest,
  restoreWorkerControlDriver,
  type WorkerControlDriver,
  releaseStuckTask,
} from '../src/worker-control.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('Phase 6 工蜂受控诊断: probeWorker 探活与 HTTP 端点 (受控通道连通度、任务耗时、事件落账与权限)', async () => {
  const rig = mkRig();
  try {
    // 注入可控的 Mock 控制驱动
    let probeCalledWithHost = '';
    const mockDriver: WorkerControlDriver = {
      async probe(host: string) {
        probeCalledWithHost = host;
        return { reachable: true, diagnostic: `Mock 通道正常响应 host-${host}` };
      },
      async restart() {
        return { ok: true, message: 'Mock 重启成功' };
      },
    };
    setWorkerControlDriverForTest(mockDriver);

    createBoard(rig.ctx, { id: 'b-ctrl', name: 'Control Board' });
    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, {
      name: 'Omp Bee',
      handle: 'omp-bee',
      host: 'X5800',
      specs: { os: 'win32', cpus: 16, memoryTotalGb: 32 },
    });
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen',
      handle: 'queen-orch',
      role: 'orchestrator',
    });

    createTask(rig.ctx, 'b-ctrl', {
      id: 'STUCK-1',
      title: '正在执行的疑似卡死任务',
      lane: 'Ready',
      assignee: 'omp-bee',
    });
    claimTask(rig.ctx, worker, 'STUCK-1');

    const app = createApp(rig.ctx);

    // 1. 蜂后通过 HTTP 端点探测工蜂
    const res = await app.request(`/agents/${worker.id}/control/probe`, {
      method: 'POST',
      headers: H(queenToken),
    });
    assert.equal(res.status, 200);
    const probeData = (await res.json()) as {
      agentId: string;
      status: string;
      channelState: string;
      currentTask: { id: string };
      diagnosticSummary: string;
    };
    assert.equal(probeData.agentId, worker.id);
    assert.equal(probeData.status, 'working');
    assert.equal(probeData.channelState, 'reachable');
    assert.equal(probeData.currentTask.id, 'STUCK-1');
    assert.ok(probeData.diagnosticSummary.includes('Mock 通道正常响应 host-X5800'));
    assert.equal(probeCalledWithHost, 'X5800');

    // 检查事件台账
    const events = listEvents(rig.ctx);
    assert.ok(events.some((e) => e.type === 'worker.probed'), 'worker.probed 事件落账');

    // 2. 权限隔离：普通 worker 调用探测报 403
    const workerCall = await app.request(`/agents/${worker.id}/control/probe`, {
      method: 'POST',
      headers: H(workerToken),
    });
    assert.equal(workerCall.status, 403, 'worker 不能探测其他工蜂');

    // 3. 对非 worker 探测报 400
    const nonWorkerCall = await app.request(`/agents/${queen.id}/control/probe`, {
      method: 'POST',
      headers: H(queenToken),
    });
    assert.equal(nonWorkerCall.status, 400);
  } finally {
    restoreWorkerControlDriver();
    rig.cleanup();
  }
});

test('Phase 6 工蜂受控干预: restartWorkerService 服务级受控重启 (白名单、审计与权限)', async () => {
  const rig = mkRig();
  try {
    let restartCalledWith = { host: '', reason: '' };
    const mockDriver: WorkerControlDriver = {
      async probe() {
        return { reachable: true };
      },
      async restart(host: string, _agent: Agent, reason: string) {
        restartCalledWith = { host, reason };
        return { ok: true, message: `已成功通过服务控制器重启工蜂@${host}` };
      },
    };
    setWorkerControlDriverForTest(mockDriver);

    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, {
      name: 'Omp Bee',
      handle: 'omp-bee',
      host: 'X5800',
    });
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen',
      handle: 'queen-orch',
      role: 'orchestrator',
    });

    const app = createApp(rig.ctx);

    // 1. 蜂后下发受控重启指令
    const res = await app.request(`/agents/${worker.id}/control/restart`, {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ reason: '任务已卡住 20 分钟无心跳，服务重启恢复' }),
    });
    assert.equal(res.status, 200);
    const result = (await res.json()) as { ok: boolean; action: string; message: string };
    assert.equal(result.ok, true);
    assert.equal(result.action, 'restart');
    assert.ok(result.message.includes('已成功通过服务控制器重启工蜂@X5800'));
    assert.equal(restartCalledWith.host, 'X5800');
    assert.equal(restartCalledWith.reason, '任务已卡住 20 分钟无心跳，服务重启恢复');

    // 检查事件台账记录
    const events = listEvents(rig.ctx);
    const restartEvent = events.find((e) => e.type === 'worker.restart_requested');
    assert.ok(restartEvent, 'worker.restart_requested 入审计台账');
    assert.equal((restartEvent.payload as { handle: string }).handle, 'omp-bee');

    // 2. 权限隔离：普通 worker 下发重启报 403
    const workerDenied = await app.request(`/agents/${worker.id}/control/restart`, {
      method: 'POST',
      headers: H(workerToken),
      body: JSON.stringify({ reason: '越权重启' }),
    });
    assert.equal(workerDenied.status, 403);

    // 3. 缺少 reason 报 422
    const noReason = await app.request(`/agents/${worker.id}/control/restart`, {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ reason: '' }),
    });
    assert.equal(noReason.status, 422);
  } finally {
    restoreWorkerControlDriver();
    rig.cleanup();
  }
});

test('Phase 6 工蜂受控干预: releaseStuckTask 强制解绑卡死任务并回退 Ready', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-release', name: 'Release Board' });
    const { agent: workerA } = registerAgent(rig.ctx, { name: 'Bee A', handle: 'bee-a' });
    const { agent: workerB, token: tokenB } = registerAgent(rig.ctx, { name: 'Bee B', handle: 'bee-b' });
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen',
      handle: 'queen-orch',
      role: 'orchestrator',
    });
    const adminToken = 'A'.repeat(48);
    rig.ctx.cfg.adminRecoveryToken = adminToken;
    createTask(rig.ctx, 'b-release', {
      id: 'HANG-1',
      title: '被挂起的测试任务',
      lane: 'Ready',
      assignee: 'bee-a',
    });
    claimTask(rig.ctx, workerA, 'HANG-1');
    assert.equal(getTask(rig.ctx, 'HANG-1').lane, 'InProgress');
    assert.equal(getTask(rig.ctx, 'HANG-1').assignee, workerA.id);

    const app = createApp(rig.ctx);

    // 1. 蜂后不可代替用户确认物理停止，解绑报 403
    const queenRes = await app.request(`/agents/${workerA.id}/control/release-task`, {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ taskId: 'HANG-1', reason: '蜂后尝试强行解绑', confirmedStopped: true }),
    });
    assert.equal(queenRes.status, 403, '蜂后尝试伪造或确认物理停止必须报 403 拒绝');

    // 2. 用户解绑未传 confirmedStopped: true 时，报 409 拒绝（网络断连不等于物理停止）
    const unconfirmedRes = await app.request(`/agents/${workerA.id}/control/release-task`, {
      method: 'POST',
      headers: H(adminToken),
      body: JSON.stringify({ taskId: 'HANG-1', reason: '未确认停止' }),
    });
    assert.equal(unconfirmedRes.status, 409, '未经用户明确确认物理停止必须报 409 拒绝');

    // 3. 用户明确提供 confirmedStopped: true 后受控解绑成功
    const res = await app.request(`/agents/${workerA.id}/control/release-task`, {
      method: 'POST',
      headers: H(adminToken),
      body: JSON.stringify({ taskId: 'HANG-1', reason: '用户核实已物理停机', confirmedStopped: true }),
    });
    assert.equal(res.status, 200);
    const updated = (await res.json()) as { task: { lane: string; assignee: string } };
    assert.equal(updated.task.lane, 'Ready');
    assert.equal(updated.task.assignee, 'unassigned');
    // 数据库状态同步
    const onDisk = getTask(rig.ctx, 'HANG-1');
    assert.equal(onDisk.lane, 'Ready');
    assert.equal(onDisk.assignee, 'unassigned');

    // 检查事件台账
    const events = listEvents(rig.ctx);
    assert.ok(events.some((e) => e.type === 'task.force_released'), 'task.force_released 事件落账');

    // 2. 权限隔离：其他 worker 尝试解绑报 403
    const reassigned = await app.request('/tasks/HANG-1/dispatch', {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ assignee: 'bee-a', content: '@bee-a 继续处理任务' }),
    });
    assert.equal(reassigned.status, 201, '蜂后将释放回 Ready 的任务重新指派给原 worker');
    claimTask(rig.ctx, workerA, 'HANG-1');
    const workerBAttempt = await app.request(`/agents/${workerA.id}/control/release-task`, {
      method: 'POST',
      headers: H(tokenB),
      body: JSON.stringify({ taskId: 'HANG-1' }),
    });
    assert.equal(workerBAttempt.status, 403);
  } finally {
    rig.cleanup();
  }
});

test('Phase 6 协议工具: 蜂后调用 asterhive_worker_probe / restart / release_stuck_task', async () => {
  const rig = mkRig();
  try {
    const mockDriver: WorkerControlDriver = {
      async probe() {
        return { reachable: true, diagnostic: 'Probe OK' };
      },
      async restart() {
        return { ok: true, message: 'Restart OK' };
      },
    };
    setWorkerControlDriverForTest(mockDriver);

    createBoard(rig.ctx, { id: 'b-tool', name: 'Tool Board' });
    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, { name: 'Bee', handle: 'bee' });
    const { agent: queen } = registerAgent(rig.ctx, { name: 'Queen', handle: 'queen-orch', role: 'orchestrator' });
    createTask(rig.ctx, 'b-tool', { id: 'TOOL-1', title: 'Tool task', lane: 'Ready', assignee: 'bee' });
    claimTask(rig.ctx, worker, 'TOOL-1');

    const probeTool = TOOL_DEFS.find((t) => t.name === 'asterhive_worker_probe');
    const restartTool = TOOL_DEFS.find((t) => t.name === 'asterhive_worker_restart');
    const releaseTool = TOOL_DEFS.find((t) => t.name === 'asterhive_worker_release_stuck_task');

    assert.ok(probeTool && restartTool && releaseTool, '3 个工蜂控制工具均已注册');

    // 1. 蜂后调用 probeTool
    const probeRes = (await probeTool.handle(rig.ctx, queen, { agentId: worker.id })) as { channelState: string };
    assert.equal(probeRes.channelState, 'local');

    // 2. 蜂后调用 restartTool
    const restartRes = (await restartTool.handle(rig.ctx, queen, {
      agentId: worker.id,
      reason: '蜂后受控恢复',
    })) as { ok: boolean };
    assert.equal(restartRes.ok, true);

    // 3. 蜂后不可代替用户确认物理停止调用 releaseTool（报 403）
    await assert.rejects(
      async () => releaseTool.handle(rig.ctx, queen, {
        agentId: worker.id,
        taskId: 'TOOL-1',
        reason: '蜂后尝试解绑',
      }),
      /only user role may confirm worker stopped/i,
    );

    // 4. 用户显式确认物理停止后受控解绑
    const { agent: userAgent } = registerAgent(rig.ctx, { name: 'Boss User', handle: 'boss-user', role: 'user' });
    const releaseRes = await releaseStuckTask(rig.ctx, userAgent, worker.id, 'TOOL-1', '用户确认停止', { confirmedStopped: true });
    assert.equal(releaseRes.lane, 'Ready');
    assert.equal(releaseRes.assignee, 'unassigned');
    // 4. worker 角色调用均报 403
    await assert.rejects(async () => probeTool.handle(rig.ctx, worker, { agentId: worker.id }), /workers cannot probe/);
    await assert.rejects(async () => restartTool.handle(rig.ctx, worker, { agentId: worker.id, reason: 'x' }), /workers cannot restart/);
    await assert.rejects(async () => releaseTool.handle(rig.ctx, worker, { agentId: worker.id, taskId: 'TOOL-1' }), /workers cannot force release/);
  } finally {
    restoreWorkerControlDriver();
    rig.cleanup();
  }
});
