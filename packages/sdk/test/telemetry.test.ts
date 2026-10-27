import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Worker,
  sampleDeviceTelemetry,
  computeCpuPercent,
  type DeviceTelemetry,
  type AgentSpecs,
} from '../src/index.ts';

// ---- fetch stub 工具 ----
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(responseBody: unknown = { ok: true }): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responseBody,
    };
  }) as unknown as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test('sampleDeviceTelemetry: 首样本无历史基准时 CPU 标记为 null', () => {
  const telemetry = sampleDeviceTelemetry({
    previousCpuSnapshot: null, // 显式指示首样本
  });
  assert.equal(telemetry.cpuPercent, null);

  assert.equal(typeof telemetry.memoryTotalGb, 'number');
  assert.ok((telemetry.memoryTotalGb ?? 0) > 0);

  assert.equal(typeof telemetry.memoryFreeGb, 'number');
  assert.ok((telemetry.memoryFreeGb ?? -1) >= 0);

  assert.equal(typeof telemetry.memoryUsedGb, 'number');
  assert.ok((telemetry.memoryUsedGb ?? -1) >= 0);

  assert.equal(typeof telemetry.memoryPercent, 'number');
  assert.ok((telemetry.memoryPercent ?? -1) >= 0 && (telemetry.memoryPercent ?? 101) <= 100);

  // 本机 Windows 下 loadAvg 必须标记为 null；非 Windows 下为长度为 3 的数组
  if (process.platform === 'win32') {
    assert.equal(telemetry.loadAvg, null);
  } else {
    assert.ok(Array.isArray(telemetry.loadAvg));
  }

  assert.equal(typeof telemetry.uptimeSec, 'number');
  assert.ok((telemetry.uptimeSec ?? -1) >= 0);
});

test('sampleDeviceTelemetry: 支持传入进行中的任务 ID 或空闲状态', () => {
  const busyTelemetry = sampleDeviceTelemetry('task-abc');
  assert.equal(busyTelemetry.taskInProgress, 'task-abc');

  const idleTelemetry = sampleDeviceTelemetry(null);
  assert.equal(idleTelemetry.taskInProgress, null);

  const optionsTelemetry = sampleDeviceTelemetry({ taskInProgress: 'task-def' });
  assert.equal(optionsTelemetry.taskInProgress, 'task-def');
});

test('sampleDeviceTelemetry: 平台与负载走势（Windows 标记为 null，Linux 正常采集）', () => {
  const GB = 1024 * 1024 * 1024;
  // Windows 平台模拟：loadavg 返回 [0, 0, 0]，必须标记为 null
  const winTelemetry = sampleDeviceTelemetry({
    osProvider: {
      platform: () => 'win32',
      totalmem: () => 16 * GB,
      freemem: () => 4 * GB,
      loadavg: () => [0, 0, 0],
      uptime: () => 3600,
      cpus: () => [
        { model: 'test', speed: 2000, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      ],
    },
  });
  assert.equal(winTelemetry.loadAvg, null);
  assert.equal(winTelemetry.memoryTotalGb, 16);
  assert.equal(winTelemetry.memoryFreeGb, 4);
  assert.equal(winTelemetry.memoryUsedGb, 12);
  assert.equal(winTelemetry.memoryPercent, 75);

  // Linux 平台模拟：正常保留负载数组
  const linuxTelemetry = sampleDeviceTelemetry({
    osProvider: {
      platform: () => 'linux',
      totalmem: () => 16 * GB,
      freemem: () => 8 * GB,
      loadavg: () => [1.25, 0.95, 0.55],
      uptime: () => 7200,
      cpus: () => [
        { model: 'test', speed: 2000, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      ],
    },
  });
  assert.deepEqual(linuxTelemetry.loadAvg, [1.25, 0.95, 0.55]);
});

test('sampleDeviceTelemetry: 内存采集失败不得伪报 0，应标记为 null', () => {
  const failedMemTelemetry = sampleDeviceTelemetry({
    osProvider: {
      totalmem: () => { throw new Error('memory access denied'); },
      freemem: () => 0,
      loadavg: () => [0, 0, 0],
      uptime: () => 100,
      cpus: () => [],
    },
  });
  assert.equal(failedMemTelemetry.memoryTotalGb, null);
  assert.equal(failedMemTelemetry.memoryFreeGb, null);
  assert.equal(failedMemTelemetry.memoryUsedGb, null);
  assert.equal(failedMemTelemetry.memoryPercent, null);
});

test('computeCpuPercent: 无基准/周期为0不得伪报0%，有差值精确计算', () => {
  // 首样本无上一基线时标记为 null
  assert.equal(computeCpuPercent(null, { idle: 800, total: 1000 }), null);
  assert.equal(computeCpuPercent(undefined, { idle: 800, total: 1000 }), null);

  // 连续采样计算差值
  const prev = { idle: 800, total: 1000 };
  const curr = { idle: 900, total: 1200 }; // delta total = 200, delta idle = 100 -> 50%
  const deltaPercent = computeCpuPercent(prev, curr);
  assert.equal(deltaPercent, 50);

  // 边缘情况：0 delta（周期为 0）不得伪报 0%，必须标记为 null
  assert.equal(computeCpuPercent(curr, curr), null);

  // 采集失败（缺失 current）标记为 null
  assert.equal(computeCpuPercent(prev, null), null);
});

test('Worker.heartbeat: 支持上报 specs 与含可空字段的 telemetry', async () => {
  const { requests, restore } = stubFetch({ ok: true });
  try {
    const worker = new Worker('http://127.0.0.1:8067', 'test-token', 'worker-test');

    const specs: AgentSpecs = { os: 'win32', cpus: 8, memoryTotalGb: 32 };
    const telemetry: DeviceTelemetry = {
      cpuPercent: null, // 首样本
      memoryUsedGb: 8.2,
      memoryTotalGb: 32,
      memoryFreeGb: 23.8,
      memoryPercent: 25.6,
      loadAvg: null, // Windows 下不可用
      uptimeSec: 7200,
      taskInProgress: 'T-101',
    };

    // 1. 同时上报 specs 和 telemetry
    await worker.heartbeat(specs, telemetry);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'http://127.0.0.1:8067/agents/worker-test/heartbeat');
    assert.deepEqual(requests[0].body, { specs, telemetry });

    // 2. 仅上报 telemetry
    await worker.heartbeat(undefined, telemetry);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, { telemetry });

    // 3. 无参心跳保活（向后兼容）
    await worker.heartbeat();
    assert.equal(requests.length, 3);
    assert.equal(requests[2].body, undefined);
  } finally {
    restore();
  }
});
