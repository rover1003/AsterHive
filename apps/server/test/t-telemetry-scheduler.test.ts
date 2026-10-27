import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import {
  registerAgent,
  updateAgentProfile,
  getAgentTelemetry,
  getAgentTelemetryHistory,
  clearAgentTelemetry,
  type AgentTelemetry,
} from '../src/agents.ts';
import { createBoard, createTask, getTask } from '../src/tasks.ts';
import { matchTaskToWorkers } from '../src/scheduler.ts';
import { nextTask, claimTask } from '../src/verbs.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';
function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

interface HeartbeatPayload {
  agent: { telemetry?: AgentTelemetry | null };
  telemetry: AgentTelemetry;
}

interface FleetTelemetryResponse {
  totalNodes: number;
  reportingNodes: number;
  metrics: { avgCpuPercent: number | null };
  nodes: Array<{ agentId: string; telemetry: AgentTelemetry | null }>;
}

interface SingleTelemetryResponse {
  agentId: string;
  history: AgentTelemetry[];
}

interface RadarResponse {
  summary: {
    realtime?: {
      avgCpuPercent: number | null;
      totalMemoryFreeGb: number;
      reportingCount: number;
    };
  };
}

test('遥测数据管道: 心跳上报 telemetry、时序缓冲区与 SSE 瞬态推送', async () => {
  const rig = mkRig();
  clearAgentTelemetry(rig.ctx);
  try {
    const app = createApp(rig.ctx);
    const { agent: bee, token: beeToken } = registerAgent(rig.ctx, {
      name: '工蜂遥测测试',
      handle: 'bee-telemetry',
      specs: { os: 'linux', arch: 'x64', cpus: 16, memoryTotalGb: 64 },
    });

    // 监听总线上的 agent.telemetry 瞬态帧
    const events: Array<{ agentId: string; telemetry: AgentTelemetry }> = [];
    rig.ctx.bus.subscribe((type, payload) => {
      if (type === 'agent.telemetry') {
        events.push(payload as { agentId: string; telemetry: AgentTelemetry });
      }
    });

    // 1. 发送带 telemetry 的心跳
    const telem1 = {
      cpuPercent: 24.5,
      memoryUsedGb: 16.0,
      memoryTotalGb: 64.0,
      memoryFreeGb: 48.0,
      memoryPercent: 25.0,
      loadAvg: [1.2, 0.9, 0.5],
      uptimeSec: 3600,
      taskInProgress: null,
      timestamp: Date.now() - 2000,
    };

    const hbRes1 = await app.request(`/agents/${bee.id}/heartbeat`, {
      method: 'POST',
      headers: H(beeToken),
      body: JSON.stringify({ telemetry: telem1 }),
    });
    assert.equal(hbRes1.status, 200);
    const hbBody1 = (await hbRes1.json()) as HeartbeatPayload;
    assert.ok(hbBody1.telemetry);
    assert.equal(hbBody1.telemetry.cpuPercent, 24.5);

    // 验证 SSE 瞬态事件已广播
    assert.equal(events.length, 1);
    const firstEvent = events[0];
    assert.equal(firstEvent.agentId, bee.id);

    // 2. 发送第二帧遥测数据
    const telem2 = {
      cpuPercent: 30.0,
      memoryUsedGb: 18.0,
      memoryTotalGb: 64.0,
      memoryFreeGb: 46.0,
      memoryPercent: 28.1,
      loadAvg: [1.5, 1.0, 0.6],
      uptimeSec: 3605,
      taskInProgress: 'TASK-1',
      timestamp: Date.now(),
    };

    await app.request(`/agents/${bee.id}/heartbeat`, {
      method: 'POST',
      headers: H(beeToken),
      body: JSON.stringify({ telemetry: telem2 }),
    });

    // 验证内存时序缓冲区（保留最近历史供 Sparkline 计算）
    const latest = getAgentTelemetry(rig.ctx, bee.id);
    assert.ok(latest);
    assert.equal(latest.cpuPercent, 30.0);
    assert.equal(latest.taskInProgress, 'TASK-1');

    const history = getAgentTelemetryHistory(rig.ctx, bee.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].cpuPercent, 24.5);
    assert.equal(history[1].cpuPercent, 30.0);

    // 3. HTTP 端点验证：/api/fleet/telemetry 与 /api/fleet/telemetry/:id
    const fleetTelemRes = await app.request('/api/fleet/telemetry', {
      headers: H(beeToken),
    });
    assert.equal(fleetTelemRes.status, 200);
    const fleetTelem = (await fleetTelemRes.json()) as FleetTelemetryResponse;
    assert.ok(fleetTelem.reportingNodes >= 1);
    const foundNode = fleetTelem.nodes.find((n) => n.agentId === bee.id);
    assert.equal(foundNode?.telemetry !== null, true);

    const singleTelemRes = await app.request(`/api/fleet/telemetry/${bee.id}`, {
      headers: H(beeToken),
    });
    assert.equal(singleTelemRes.status, 200);
    const singleTelem = (await singleTelemRes.json()) as SingleTelemetryResponse;
    assert.equal(singleTelem.agentId, bee.id);
    assert.equal(singleTelem.history.length, 2);

    // 4. 舰队体检雷达 GET /api/fleet/radar 包含实时遥测水准
    const radarRes = await app.request('/api/fleet/radar', {
      headers: H(beeToken),
    });
    assert.equal(radarRes.status, 200);
    const radarBody = (await radarRes.json()) as RadarResponse;
    assert.ok(radarBody.summary.realtime);
    assert.equal(radarBody.summary.realtime.avgCpuPercent, 30.0);
  } finally {
    clearAgentTelemetry(rig.ctx);
    rig.cleanup();
  }
});

test('Nomad 调度升级: 两阶段动态调度（过载/内存容量硬过滤 + 四维加权打分 0~100）', async () => {
  const rig = mkRig();
  clearAgentTelemetry(rig.ctx);
  try {
    const app = createApp(rig.ctx);
    createBoard(rig.ctx, { id: 'b-nomad', name: 'Nomad Board' });
    // 节点 1：大算力高空闲（32核、64GB内存、CPU仅10%、空闲内存50GB、首选模型匹配、空闲）
    const { agent: nodePower, token: tPower } = registerAgent(rig.ctx, {
      name: 'Power Compute Node',
      handle: 'node-power',
      models: ['claude-3-7-sonnet', 'gpt-5'],
      specs: { os: 'linux', arch: 'x64', cpus: 32, memoryTotalGb: 64, executor: 'omp' },
    });
    updateAgentProfile(rig.ctx, nodePower.id, { preferredModel: 'claude-3-7-sonnet' });
    await app.request(`/agents/${nodePower.id}/heartbeat`, {
      method: 'POST',
      headers: H(tPower),
      body: JSON.stringify({
        telemetry: {
          cpuPercent: 10.0,
          memoryUsedGb: 14.0,
          memoryTotalGb: 64.0,
          memoryFreeGb: 50.0,
          memoryPercent: 21.8,
        },
      }),
    });

    // 节点 2：CPU过载节点（CPU 95% > 任务声明的 maxCpuPercent 85%，硬拦截）
    const { agent: nodeOverloaded, token: tOverloaded } = registerAgent(rig.ctx, {
      name: 'Overloaded Node',
      handle: 'node-overloaded',
      models: ['claude-3-7-sonnet'],
      specs: { os: 'linux', arch: 'x64', cpus: 16, memoryTotalGb: 32, executor: 'omp' },
    });
    await app.request(`/agents/${nodeOverloaded.id}/heartbeat`, {
      method: 'POST',
      headers: H(tOverloaded),
      body: JSON.stringify({
        telemetry: {
          cpuPercent: 95.0,
          memoryUsedGb: 30.0,
          memoryTotalGb: 32.0,
          memoryFreeGb: 2.0,
          memoryPercent: 93.7,
        },
      }),
    });

    // 节点 3：总物理内存不足节点（总内存仅 2GB，但任务要求 4GB，硬拦截）
    const { agent: nodeLowMem, token: tLowMem } = registerAgent(rig.ctx, {
      name: 'Low Memory Node',
      handle: 'node-low-mem',
      models: ['claude-3-7-sonnet'],
      specs: { os: 'linux', arch: 'x64', cpus: 16, memoryTotalGb: 2, executor: 'omp' },
    });
    await app.request(`/agents/${nodeLowMem.id}/heartbeat`, {
      method: 'POST',
      headers: H(tLowMem),
      body: JSON.stringify({
        telemetry: {
          cpuPercent: 20.0,
          memoryUsedGb: 1.0,
          memoryTotalGb: 2.0,
          memoryFreeGb: 1.0,
          memoryPercent: 50.0,
        },
      }),
    });

    // 节点 6：未上报动态 CPU 负载的节点（任务有 maxCpuPercent 限制时无法确认，硬拦截）
    const { agent: nodeNoTelem, token: tNoTelem } = registerAgent(rig.ctx, {
      name: 'No Telemetry Node',
      handle: 'node-no-telem',
      models: ['claude-3-7-sonnet'],
      specs: { os: 'linux', arch: 'x64', cpus: 16, memoryTotalGb: 32, executor: 'omp' },
    });
    await app.request(`/agents/${nodeNoTelem.id}/heartbeat`, {
      method: 'POST',
      headers: H(tNoTelem),
      body: JSON.stringify({}),
    });
    // 节点 4：轻量可用节点（4核、8GB内存、CPU 40%、空闲内存 5GB）
    const { agent: nodeLite, token: tLite } = registerAgent(rig.ctx, {
      name: 'Lite Node',
      handle: 'node-lite',
      models: ['claude-3-7-sonnet'],
      specs: { os: 'linux', arch: 'x64', cpus: 4, memoryTotalGb: 8, executor: 'omp' },
    });
    await app.request(`/agents/${nodeLite.id}/heartbeat`, {
      method: 'POST',
      headers: H(tLite),
      body: JSON.stringify({
        telemetry: {
          cpuPercent: 40.0,
          memoryUsedGb: 3.0,
          memoryTotalGb: 8.0,
          memoryFreeGb: 5.0,
          memoryPercent: 37.5,
        },
      }),
    });

    // 节点 5：失联节点（stale，硬拦截）
    const { agent: nodeStale } = registerAgent(rig.ctx, {
      name: 'Stale Node',
      handle: 'node-stale',
      models: ['claude-3-7-sonnet'],
      specs: { os: 'linux', arch: 'x64', cpus: 8, memoryTotalGb: 16, executor: 'omp' },
    });
    // 模拟过期心跳（必须超过 test rig 配置的 ttlMinutes 才会触发 stale 状态）
    const staleTime = Date.now() - (rig.ctx.cfg.ttlMinutes + 1) * 60_000;
    rig.ctx.holder.db
      .prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?')
      .run(staleTime, nodeStale.id);
    // 创建测试任务：要求 linux、最低 4GB 内存、最大 CPU 85%、模型 claude-3-7-sonnet
    createTask(rig.ctx, 'b-nomad', {
      id: 'HEAVY-1',
      title: '高吞吐分布式编译任务',
      requirements: {
        os: 'linux',
        minMemoryGb: 4,
        maxCpuPercent: 85,
        requiredModel: 'claude-3-7-sonnet',
      },
    });

    // 预先给 nodeLite 塞一条已完成的任务以建立历史参与亲和度
    createTask(rig.ctx, 'b-nomad', {
      id: 'PREV-1',
      title: '历史任务',
      assignee: nodeLite.id,
      lane: 'Done',
    });

    const match = matchTaskToWorkers(rig.ctx, 'HEAVY-1');
    // 1. 验证硬拦截 (Feasibility Filtering)
    // nodeOverloaded (CPU 95% > 85%) 必须被拦截
    const overInel = match.ineligible.find((i) => i.agentId === nodeOverloaded.id);
    assert.ok(overInel, 'CPU 过载节点必须被硬拦截');
    assert.ok(overInel.reasons.some((r) => r.includes('CPU') || r.includes('超限')));

    // nodeLowMem (总物理内存 2GB < 4GB) 必须被拦截
    const lowMemInel = match.ineligible.find((i) => i.agentId === nodeLowMem.id);
    assert.ok(lowMemInel, '物理总内存不足节点必须被硬拦截');
    assert.ok(lowMemInel.reasons.some((r) => r.includes('总内存不足') || r.includes('内存不足')));

    // nodeNoTelem (未上报动态 CPU 负载，无法确认 maxCpuPercent 限制) 必须被拦截
    const noTelemInel = match.ineligible.find((i) => i.agentId === nodeNoTelem.id);
    assert.ok(noTelemInel, '未上报实时CPU的节点必须被硬拦截（无法确认实时CPU限制）');
    assert.ok(noTelemInel.reasons.some((r) => r.includes('无法确认实时CPU限制')));

    // nodeStale 必须被拦截
    const staleInel = match.ineligible.find((i) => i.agentId === nodeStale.id);
    assert.ok(staleInel, '心跳超时节点必须被硬拦截');
    assert.ok(staleInel.reasons.some((r) => r.includes('失联') || r.includes('超时') || r.includes('stale')));
    // 2. 验证多维评分 (Scoring 0~100)
    assert.equal(match.eligibleCount, 2, '仅 nodePower 与 nodeLite 合格');
    const [first, second] = match.recommendations;
    assert.equal(first.agentId, nodePower.id, '大算力高空闲节点必须高居榜首');
    assert.equal(second.agentId, nodeLite.id);

    // nodePower 满分级别评分：
    // 算力富余度 (CPU 10% -> 18分, 内存 50/64 -> 15.6分 => 33.6分)
    // 模型亲和度 (+30分)
    // 负载均衡 (+20分)
    // 总分 > 80
    assert.ok(first.score >= 80, `nodePower 得分 ${first.score} 应当 >= 80`);
    assert.ok(first.score <= 100);

    // 验证 nodeLite 获得了项目历史参与分 (+10分)
    assert.ok(second.reasons.some((r) => r.includes('项目历史参与') && r.includes('+10分')));
  } finally {
    clearAgentTelemetry(rig.ctx);
    rig.cleanup();
  }
});

test('定向指派与领活强化: 仅认领明确指派给当前工蜂的任务卡，杜绝公池抢活与绕过', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-dispatch', name: 'Dispatch Board' });
    const { agent: beeA } = registerAgent(rig.ctx, { name: '工蜂A', handle: 'bee-a' });
    const { agent: beeB } = registerAgent(rig.ctx, { name: '工蜂B', handle: 'bee-b' });

    // 1. 创建三张卡：
    // DIR-1: 定向派发给 bee-a
    createTask(rig.ctx, 'b-dispatch', {
      id: 'DIR-1',
      title: '定向给 A 的任务',
      lane: 'Ready',
      assignee: beeA.id,
    });

    // DIR-2: 定向派发给 bee-b
    createTask(rig.ctx, 'b-dispatch', {
      id: 'DIR-2',
      title: '定向给 B 的任务',
      lane: 'Ready',
      assignee: beeB.id,
    });

    // UNASSIGN-1: 蜂后尚未决策派工的未指派任务
    createTask(rig.ctx, 'b-dispatch', {
      id: 'UNASSIGN-1',
      title: '未指派任务',
      lane: 'Ready',
    });

    // 2. bee-b 调用 nextTask：
    // - 应当认领指派给自己的 DIR-2
    // - 绝不能抢到 DIR-1（定向给 beeA）
    // - 绝不能抢到 UNASSIGN-1（未指派）
    const nextB1 = nextTask(rig.ctx, beeB, 'b-dispatch');
    assert.ok(nextB1.task, 'bee-b 应当成功领到定向指派任务');
    assert.equal(nextB1.task?.id, 'DIR-2');
    assert.equal(nextB1.task?.assignee, beeB.id);

    // bee-b 再次尝试 nextTask：
    // 此时仅剩 DIR-1 与 UNASSIGN-1，无属于 bee-b 的任务，安全返回 null
    const nextB2 = nextTask(rig.ctx, beeB, 'b-dispatch');
    assert.equal(nextB2.task, null, '无属于自己的任务时安全返回 null');

    // 3. claimTask 严格限制权限：他人指派卡与未指派卡禁止 claim（均报 409 Conflict）
    assert.throws(
      () => claimTask(rig.ctx, beeA, 'DIR-2'),
      (err: unknown) => typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 409,
      '不可冒领已在执行或非自身指派的任务（返回 409）',
    );
    assert.throws(
      () => claimTask(rig.ctx, beeA, 'UNASSIGN-1'),
      (err: unknown) => typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 409,
      '未指派卡必须先由蜂后定向派发，工蜂不可直接 claim（返回 409）',
    );

    // 验证他人任务与未指派任务状态保持不变，未被非法篡改
    const dir2 = getTask(rig.ctx, 'DIR-2');
    assert.equal(dir2.lane, 'InProgress');
    assert.equal(dir2.assignee, beeB.id);

    const unassigned = getTask(rig.ctx, 'UNASSIGN-1');
    assert.equal(unassigned.lane, 'Ready');
    assert.equal(unassigned.assignee, 'unassigned');

    // 4. bee-a 正常认领自己的任务
    const claimedA = claimTask(rig.ctx, beeA, 'DIR-1');
    assert.equal(claimedA.id, 'DIR-1');
    assert.equal(claimedA.assignee, beeA.id);
  } finally {
    rig.cleanup();
  }
});

test('安全阻断: 心跳端点身份鉴权与跨工蜂伪造拦截', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const { agent: beeA, token: tokenA } = registerAgent(rig.ctx, { name: '工蜂A', handle: 'bee-a' });
    const { agent: beeB, token: tokenB } = registerAgent(rig.ctx, { name: '工蜂B', handle: 'bee-b' });
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: '蜂后',
      handle: 'queen-admin',
      role: 'orchestrator',
    });

    // 1. 匿名无 token 请求心跳 -> 401
    const anonRes = await app.request(`/agents/${beeA.id}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetry: { cpuPercent: 10 } }),
    });
    assert.equal(anonRes.status, 401, '无凭据请求应当 401');

    // 2. 伪造他人身份：工蜂 A 拿自己的 token 试图修改工蜂 B 的遥测心跳 -> 403
    const spoofRes = await app.request(`/agents/${beeB.id}/heartbeat`, {
      method: 'POST',
      headers: H(tokenA),
      body: JSON.stringify({ telemetry: { cpuPercent: 99 } }),
    });
    assert.equal(spoofRes.status, 403, '工蜂不得跨身份向其他工蜂端点发送心跳与遥测');

    // 3. 正常携自身合法 token 上报 -> 200
    const okRes = await app.request(`/agents/${beeA.id}/heartbeat`, {
      method: 'POST',
      headers: H(tokenA),
      body: JSON.stringify({ telemetry: { cpuPercent: 15 } }),
    });
    assert.equal(okRes.status, 200, '合法自身心跳应当成功');

    // 4. 管理员/蜂后具备提权维护通道 -> 200
    const queenRes = await app.request(`/agents/${beeB.id}/heartbeat`, {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ telemetry: { cpuPercent: 20 } }),
    });
    assert.equal(queenRes.status, 200, '主脑/管理员可协助更新工蜂状态');
  } finally {
    rig.cleanup();
  }
});

test('任务硬件要求端到端透传: HTTP 与蜂后工具创建/更新均完整保留 requirements 与 /match', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    createBoard(rig.ctx, { id: 'b-req', name: 'Requirements Board' });
    const { token: queenToken, agent: queen } = registerAgent(rig.ctx, {
      name: '蜂后',
      handle: 'queen-admin',
      role: 'orchestrator',
    });

    // 1. HTTP POST /boards/:b/tasks 创建携带 requirements
    const createRes = await app.request('/boards/b-req/tasks', {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({
        id: 'REQ-1',
        title: '硬件密集任务',
        lane: 'Ready',
        requirements: {
          minCpus: 2,
          minMemoryGb: 4,
          os: 'linux',
        },
      }),
    });
    assert.equal(createRes.status, 201);
    const createdBody = (await createRes.json()) as { task: { requirements?: { minCpus?: number; minMemoryGb?: number; os?: string } } };
    assert.ok(createdBody.task.requirements);
    assert.equal(createdBody.task.requirements.minCpus, 2);
    assert.equal(createdBody.task.requirements.minMemoryGb, 4);
    assert.equal(createdBody.task.requirements.os, 'linux');

    // 验证 GET /tasks/:id 返回包含 requirements
    const getRes = await app.request('/tasks/REQ-1', { headers: H(queenToken) });
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { task: { requirements?: { minCpus?: number } } };
    assert.equal(getBody.task.requirements?.minCpus, 2);

    // 验证 GET /tasks/:id/match 包含 requirements 并在调度中生效
    const matchRes = await app.request('/tasks/REQ-1/match', { headers: H(queenToken) });
    assert.equal(matchRes.status, 200);
    const matchBody = (await matchRes.json()) as { requirements?: { minCpus?: number; minMemoryGb?: number } };
    assert.equal(matchBody.requirements?.minCpus, 2);
    assert.equal(matchBody.requirements?.minMemoryGb, 4);

    // 2. 蜂后工具 asterhive_create_task 创建带 requirements
    const createTool = TOOL_DEFS.find((t) => t.name === 'asterhive_create_task');
    assert.ok(createTool, '应当注册 asterhive_create_task 工具');
    const toolTask = createTool.handle(rig.ctx, queen, {
      boardId: 'b-req',
      id: 'REQ-2',
      title: '工具创建的任务',
      lane: 'Ready',
      requirements: {
        minCpus: 8,
        minMemoryGb: 16,
      },
    }) as { requirements?: { minCpus?: number; minMemoryGb?: number } };
    assert.ok(toolTask.requirements);
    assert.equal(toolTask.requirements.minCpus, 8);
    assert.equal(toolTask.requirements.minMemoryGb, 16);

    // 3. HTTP PATCH /tasks/:id 局部更新 requirements
    const patchRes = await app.request('/tasks/REQ-1', {
      method: 'PATCH',
      headers: H(queenToken),
      body: JSON.stringify({
        requirements: {
          minCpus: 16,
          minMemoryGb: 32,
        },
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = (await patchRes.json()) as { task: { requirements?: { minCpus?: number; minMemoryGb?: number } } };
    assert.equal(patchBody.task.requirements?.minCpus, 16);
    assert.equal(patchBody.task.requirements?.minMemoryGb, 32);
  } finally {
    rig.cleanup();
  }
});
