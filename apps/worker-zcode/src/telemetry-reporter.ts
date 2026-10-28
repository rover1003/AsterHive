import { Worker, sampleDeviceTelemetry, type AgentSpecs, type DeviceTelemetry } from './sdk.ts';

export interface TelemetryReporterOptions {
  worker: Worker;
  specs?: AgentSpecs;
  intervalMs?: number;
  log?: (...args: unknown[]) => void;
}

/**
 * 工蜂端实时硬件性能遥测上报器
 * 支持定时心跳与取活循环中的即时采样上报，在任务执行中自动携带 taskInProgress
 */
export class TelemetryReporter {
  #worker: Worker;
  #specs?: AgentSpecs;
  #intervalMs: number;
  #log: (...args: unknown[]) => void;
  #taskInProgress: string | null | undefined = undefined;
  #timer: NodeJS.Timeout | null = null;
  #reporting = false;

  constructor(options: TelemetryReporterOptions) {
    this.#worker = options.worker;
    this.#specs = options.specs;
    this.#intervalMs = options.intervalMs ?? 10_000;
    this.#log = options.log ?? ((...args) => console.log('[telemetry]', ...args));
  }

  setTaskInProgress(taskId: string | null | undefined): void {
    this.#taskInProgress = taskId;
  }

  async reportOnce(): Promise<DeviceTelemetry | null> {
    if (this.#reporting) return null;
    this.#reporting = true;
    try {
      const telemetry = sampleDeviceTelemetry(this.#taskInProgress);
      await this.#worker.heartbeat(this.#specs, telemetry);
      return telemetry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log(`遥测心跳上报失败（非致命）：${msg}`);
      return null;
    } finally {
      this.#reporting = false;
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.reportOnce();
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  isRunning(): boolean {
    return this.#timer !== null;
  }
}
