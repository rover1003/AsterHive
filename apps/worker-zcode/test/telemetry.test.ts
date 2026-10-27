import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker, type AgentSpecs, type DeviceTelemetry } from '../src/sdk.ts';
import { TelemetryReporter } from '../src/telemetry-reporter.ts';

interface CapturedCall {
  specs?: AgentSpecs;
  telemetry?: DeviceTelemetry;
}

function createMockWorker(): {
  worker: Worker;
  calls: CapturedCall[];
  throwError: boolean;
} {
  const calls: CapturedCall[] = [];
  const mockState = { throwError: false };
  const worker = {
    agentId: 'worker-node-1',
    heartbeat: async (specs?: AgentSpecs, telemetry?: DeviceTelemetry) => {
      if (mockState.throwError) {
        throw new Error('Network timeout');
      }
      calls.push({ specs, telemetry });
    },
  } as unknown as Worker;

  return {
    worker,
    calls,
    get throwError() { return mockState.throwError; },
    set throwError(v) { mockState.throwError = v; },
  };
}

test('TelemetryReporter: 手动发送一次心跳遥测', async () => {
  const { worker, calls } = createMockWorker();
  const specs: AgentSpecs = { os: 'win32', cpus: 16 };
  const reporter = new TelemetryReporter({
    worker,
    specs,
  });

  // 1. 空闲态采样上报
  await reporter.reportOnce();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].specs, specs);
  assert.ok(calls[0].telemetry?.cpuPercent === null || typeof calls[0].telemetry?.cpuPercent === 'number');
  assert.equal(typeof calls[0].telemetry?.memoryTotalGb, 'number');
  assert.equal(calls[0].telemetry?.taskInProgress, undefined);

  // 2. 设置进行中任务后再上报
  reporter.setTaskInProgress('T-888');
  await reporter.reportOnce();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].telemetry?.taskInProgress, 'T-888');

  // 3. 清理任务状态恢复空闲
  reporter.setTaskInProgress(null);
  await reporter.reportOnce();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].telemetry?.taskInProgress, null);
});

test('TelemetryReporter: 网络故障时不抛出异常（容错）', async () => {
  const mock = createMockWorker();
  mock.throwError = true;
  const logs: string[] = [];
  const reporter = new TelemetryReporter({
    worker: mock.worker,
    log: (msg) => logs.push(msg),
  });

  // 不应抛出异常
  await reporter.reportOnce();
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('Network timeout'));
});

test('TelemetryReporter: 定时心跳按周期触发并能优雅关闭', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { worker, calls } = createMockWorker();
  const reporter = new TelemetryReporter({
    worker,
    intervalMs: 5000,
  });

  reporter.start();
  assert.ok(reporter.isRunning());

  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(calls.length, 1);

  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(calls.length, 2);

  reporter.stop();
  assert.ok(!reporter.isRunning());

  t.mock.timers.tick(10000);
  await Promise.resolve();
  assert.equal(calls.length, 2);
});
