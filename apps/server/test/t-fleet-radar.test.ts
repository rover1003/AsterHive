import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { createBoard, createTask } from '../src/tasks.ts';
import { claimTask } from '../src/verbs.ts';
import { logEvent, withWrite } from '../src/write.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';
import { getFleetRadar, type FleetRadarReport } from '../src/fleet-radar.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('Phase 9 舰队体检雷达: 算力池聚合（CPU、内存、内核分布与模型去重）', () => {
  const rig = mkRig();
  try {
    // 注册工蜂 1：16核 32GB
    registerAgent(rig.ctx, {
      name: 'Bee 1',
      handle: 'bee-1',
      models: ['gemini-3.8-flash', 'gpt-5'],
      specs: { os: 'win32', arch: 'x64', cpus: 16, memoryTotalGb: 32, executor: 'omp' },
    });

    // 注册工蜂 2：32核 64GB
    registerAgent(rig.ctx, {
      name: 'Bee 2',
      handle: 'bee-2',
      models: ['gpt-5', 'claude-opus'],
      specs: { os: 'linux', arch: 'x64', cpus: 32, memoryTotalGb: 64, executor: 'zcode' },
    });

    const radar = getFleetRadar(rig.ctx);
    assert.equal(radar.summary.totalWorkers, 2);
    assert.equal(radar.summary.totalCpus, 48, '总核心数 16 + 32 = 48');
    assert.equal(radar.summary.totalMemoryGb, 96, '总内存 32 + 64 = 96');
    assert.equal(radar.summary.executors.omp, 1);
    assert.equal(radar.summary.executors.zcode, 1);
    // 模型去重聚合
    assert.deepEqual(radar.summary.uniqueModels, ['claude-opus', 'gemini-3.8-flash', 'gpt-5']);
  } finally {
    rig.cleanup();
  }
});

test('Phase 9 舰队体检雷达: 任务长时间执行且无进展的停滞预警 (Stagnation Alerts)', () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-alert', name: 'Alert Board' });
    const { agent: worker } = registerAgent(rig.ctx, {
      name: 'Bee Stagnant',
      handle: 'bee-stagnant',
    });

    createTask(rig.ctx, 'b-alert', {
      id: 'STALL-1',
      title: '复杂大模块改写',
      lane: 'Ready',
    });
    claimTask(rig.ctx, worker, 'STALL-1');

    // 模拟任务在 35 分钟前认领，且无任何后续 checkpoint（已静默 35 分钟）
    const now = Date.now();
    const thirtyFiveMinsAgo = now - 35 * 60 * 1000;
    rig.ctx.holder.db
      .prepare('UPDATE task SET claimed_at = ?, last_activity_at = ? WHERE id = ?')
      .run(thirtyFiveMinsAgo, thirtyFiveMinsAgo, 'STALL-1');

    const radar = getFleetRadar(rig.ctx);
    assert.equal(radar.alerts.length, 1, '触发一条停滞预警');
    const alert = radar.alerts[0];
    assert.equal(alert.taskId, 'STALL-1');
    assert.equal(alert.agentHandle, 'bee-stagnant');
    assert.ok(alert.elapsedMinutes >= 35);
    assert.equal(alert.severity, 'critical');
    assert.ok(alert.recommendation.includes('asterhive_worker_probe'));
  } finally {
    rig.cleanup();
  }
});

test('Phase 9 舰队体检雷达: HTTP 端点 GET /api/fleet/radar 与蜂后协议工具 asterhive_fleet_radar', async () => {
  const rig = mkRig();
  try {
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen',
      handle: 'queen-radar',
      role: 'orchestrator',
    });
    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, {
      name: 'Bee',
      handle: 'bee-radar',
      role: 'worker',
      specs: { os: 'linux', cpus: 8, memoryTotalGb: 16 },
    });

    // 记录一条受控干预事件
    withWrite(rig.ctx, 'worker.restart_requested', () => {
      logEvent(rig.ctx, 'worker.restart_requested', {
        agentId: worker.id,
        handle: worker.handle,
        reason: '停滞超时受控重启',
        ok: true,
        message: '服务已成功拉起',
      });
    });

    const app = createApp(rig.ctx);

    // 1. HTTP 端点测试
    const res = await app.request('/api/fleet/radar', { headers: H(queenToken) });
    assert.equal(res.status, 200);
    const report = (await res.json()) as FleetRadarReport;
    assert.equal(report.summary.totalWorkers, 1);
    assert.equal(report.summary.totalCpus, 8);
    assert.equal(report.recentInterventions.length, 1);
    assert.ok(report.recentInterventions[0].message.includes('停滞超时受控重启'));

    // 2. 蜂后协议工具调用测试
    const radarTool = TOOL_DEFS.find((t) => t.name === 'asterhive_fleet_radar');
    assert.ok(radarTool, 'asterhive_fleet_radar 工具已注册');

    const toolRes = (await radarTool.handle(rig.ctx, queen, {})) as FleetRadarReport;
    assert.equal(toolRes.summary.totalWorkers, 1);

    // 3. worker 调用报 403
    await assert.rejects(
      async () => radarTool.handle(rig.ctx, worker, {}),
      /workers cannot query fleet radar/,
      'worker 调用雷达报 403',
    );
  } finally {
    rig.cleanup();
  }
});
