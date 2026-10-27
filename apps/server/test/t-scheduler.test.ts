import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, setAgentEnabled, updateAgentProfile, reportAgentSpecs, heartbeat, type Agent } from '../src/agents.ts';
import { createBoard, createTask, setParticipants } from '../src/tasks.ts';
import { matchTaskToWorkers } from '../src/scheduler.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('Phase 5 Nomad 调度: 任务硬性条件过滤（OS、核心数、内存、执行器、模型及参与者门禁）', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b1', name: 'Board 1' });

    // 1. 注册多只不同规格与环境的工蜂
    // 工蜂 A：Windows、16核、32GB内存、omp 内核、带 gemini 模型（活跃在线）
    const { agent: beeWin } = registerAgent(rig.ctx, {
      name: 'Bee Win',
      handle: 'bee-win',
      host: 'X5800',
      models: ['Gemini/gemini-3.8-flash-tiered', 'deepseek-v3'],
      specs: {
        os: 'win32',
        arch: 'x64',
        cpus: 16,
        memoryTotalGb: 32,
        executor: 'omp',
      },
    });
    updateAgentProfile(rig.ctx, beeWin.id, { preferredModel: 'Gemini/gemini-3.8-flash-tiered' });
    heartbeat(rig.ctx, beeWin.id);

    // 工蜂 B：Mac、8核、16GB内存、zcode 内核、带 opus 模型（活跃在线）
    const { agent: beeMac } = registerAgent(rig.ctx, {
      name: 'Bee Mac',
      handle: 'bee-mac',
      host: 'iMac',
      models: ['claude-opus-4', 'claude-sonnet-4'],
      specs: {
        os: 'darwin',
        arch: 'arm64',
        cpus: 8,
        memoryTotalGb: 16,
        executor: 'zcode',
      },
    });
    heartbeat(rig.ctx, beeMac.id);

    // 工蜂 C：Linux、停用状态
    const { agent: beeLinux } = registerAgent(rig.ctx, {
      name: 'Bee Linux Disabled',
      handle: 'bee-linux',
      host: 'linux-box',
      models: ['gpt-5'],
      specs: {
        os: 'linux',
        arch: 'x64',
        cpus: 32,
        memoryTotalGb: 64,
        executor: 'omp',
      },
    });
    setAgentEnabled(rig.ctx, beeLinux.id, false);

    // 工蜂 D：注册后从未发送过心跳（不可用节点）
    const { agent: beeNever } = registerAgent(rig.ctx, {
      name: 'Bee Never Heartbeat',
      handle: 'bee-never',
      specs: { os: 'win32', arch: 'x64', cpus: 16, memoryTotalGb: 32 },
    });

    // 2. 任务 1：要求 win32 + 最低 12 核心 + 最低 24GB 内存 + 模型含 gemini
    createTask(rig.ctx, 'b1', {
      id: 'WIN-101',
      title: 'Windows 专有构建与大型测试',
      requirements: {
        os: 'win32',
        arch: 'x64',
        minCpus: 12,
        minMemoryGb: 24,
        requiredModel: 'gemini',
        executor: 'omp',
      },
    });

    const match1 = matchTaskToWorkers(rig.ctx, 'WIN-101');
    assert.equal(match1.eligibleCount, 1, '只有 bee-win 满足所有硬性条件');
    assert.equal(match1.recommendations[0].agentId, beeWin.id);
    assert.ok(match1.recommendations[0].score > 0);

    // 检查不符合项列表及可解释原因
    const macIneligible = match1.ineligible.find((i) => i.agentId === beeMac.id);
    assert.ok(macIneligible, 'bee-mac 应当进入 ineligible');
    assert.ok(macIneligible.reasons.some((r) => r.includes('操作系统不匹配')));
    assert.ok(macIneligible.reasons.some((r) => r.includes('CPU 核心不足')));
    assert.ok(macIneligible.reasons.some((r) => r.includes('模型能力不匹配')));

    const linuxIneligible = match1.ineligible.find((i) => i.agentId === beeLinux.id);
    assert.ok(linuxIneligible, 'bee-linux 应当进入 ineligible');
    assert.ok(linuxIneligible.reasons.some((r) => r.includes('停用状态')));

    const neverIneligible = match1.ineligible.find((i) => i.agentId === beeNever.id);
    assert.ok(neverIneligible, '未上报心跳节点必须进入 ineligible');
    assert.ok(neverIneligible.reasons.some((r) => r.includes('从未上报心跳')));

    // 3. 参与者门禁测试：限制看板只允许 beeMac 参与
    setParticipants(rig.ctx, 'b1', [beeMac.id]);
    const matchRestricted = matchTaskToWorkers(rig.ctx, 'WIN-101');
    assert.equal(matchRestricted.eligibleCount, 0, '受看板参与者限制，无候选工蜂');
    const winRestricted = matchRestricted.ineligible.find((i) => i.agentId === beeWin.id);
    assert.ok(winRestricted, 'bee-win 因非看板参与者被过滤');
    assert.ok(winRestricted.reasons.some((r) => r.includes('参与者列表')));
  } finally {
    rig.cleanup();
  }
});

test('Phase 5 Nomad 调度: 评分排序（在线状态、首选模型贴合度、硬件富余度与完工活跃度）', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b2', name: 'Board 2' });

    // 注册两只都满足基本条件的工蜂
    // 工蜂 1：空闲、16核、32GB内存、首选模型完全匹配
    const { agent: bee1 } = registerAgent(rig.ctx, {
      name: 'Bee 1 Heavy',
      handle: 'bee-1',
      models: ['openai/gpt-5.2', 'gemini-flash'],
      specs: { os: 'linux', arch: 'x64', cpus: 16, memoryTotalGb: 32, executor: 'omp' },
    });
    updateAgentProfile(rig.ctx, bee1.id, { preferredModel: 'openai/gpt-5.2' });
    heartbeat(rig.ctx, bee1.id);

    // 工蜂 2：空闲、4核、8GB内存、可用模型包含但非首选
    const { agent: bee2 } = registerAgent(rig.ctx, {
      name: 'Bee 2 Lite',
      handle: 'bee-2',
      models: ['openai/gpt-5.2'],
      specs: { os: 'linux', arch: 'x64', cpus: 4, memoryTotalGb: 8, executor: 'omp' },
    });
    heartbeat(rig.ctx, bee2.id);

    createTask(rig.ctx, 'b2', {
      id: 'MODEL-102',
      title: '高智能复杂规划任务',
      requirements: {
        os: 'linux',
        requiredModel: 'gpt-5.2',
      },
    });

    const result = matchTaskToWorkers(rig.ctx, 'MODEL-102');
    assert.equal(result.eligibleCount, 2);
    // bee-1 得分必须显著高于 bee-2（因为首选模型吻合 + 硬件富余度更高）
    assert.equal(result.recommendations[0].agentId, bee1.id, 'bee-1 排序第一');
    assert.equal(result.recommendations[1].agentId, bee2.id, 'bee-2 排序第二');
    assert.ok(result.recommendations[0].score > result.recommendations[1].score);
    assert.ok(result.recommendations[0].reasons.some((r) => r.includes('+30分')));
  } finally {
    rig.cleanup();
  }
});

test('Phase 5 Nomad 调度: HTTP API GET /tasks/:id/match 与蜂后协议工具 asterhive_match_task', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b3', name: 'Board 3' });
    const { agent: workerBee, token: workerToken } = registerAgent(rig.ctx, {
      name: 'Bee Worker',
      handle: 'bee-worker',
      specs: { os: 'win32', cpus: 8, memoryTotalGb: 16 },
    });
    heartbeat(rig.ctx, workerBee.id);

    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen Brain',
      handle: 'queen-brain',
      role: 'orchestrator',
    });

    createTask(rig.ctx, 'b3', {
      id: 'MATCH-103',
      title: '测试匹配端点',
      requirements: { minCpus: 4 },
    });

    const app = createApp(rig.ctx);

    // 1. HTTP 端点测试
    const res = await app.request('/tasks/MATCH-103/match', { headers: H(queenToken) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { taskId: string; eligibleCount: number; recommendations: unknown[] };
    assert.equal(body.taskId, 'MATCH-103');
    assert.equal(body.eligibleCount, 1);
    assert.equal(body.recommendations.length, 1);

    // worker 角色无权调用 match（仅 orchestrator / user 开放）
    const forbiddenRes = await app.request('/tasks/MATCH-103/match', { headers: H(workerToken) });
    assert.equal(forbiddenRes.status, 403);

    // 2. 蜂后协议工具 asterhive_match_task 测试
    const matchTool = TOOL_DEFS.find((t) => t.name === 'asterhive_match_task');
    assert.ok(matchTool, '应当注册 asterhive_match_task 工具');
    const toolResult = matchTool.handle(rig.ctx, queen, { taskId: 'MATCH-103' }) as { eligibleCount: number };
    assert.equal(toolResult.eligibleCount, 1);
  } finally {
    rig.cleanup();
  }
});
