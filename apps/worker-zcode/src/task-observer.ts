import type { Worker, ExecutionActivity, SessionObservationEvent } from './sdk.ts';
import type { PiActivity } from './pi-executor.ts';

type Packet = { channel: 'activity'; event: ExecutionActivity; bytes: number } | { channel: 'session'; event: SessionObservationEvent; bytes: number };

/** One concrete, bounded outbox for this task's activity and opted-in Pi observation. */
export class TaskObserver {
  #worker: Worker;
  #taskId: string;
  #attempt: number;
  #log: (...args: unknown[]) => void;
  #onCancel: () => void;
  #activitySequence: number;
  #sessionSequence = 0;
  #queue: Packet[] = [];
  #queuedBytes = 0;
  #upload: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #configTimer: ReturnType<typeof setInterval> | undefined;
  #configLoading = false;
  #closing = false;
  #controller = new AbortController();
  #enabled = false;
  #cancelRequested = false;
  #lostActivity = false;
  #lostSession = false;

  constructor(options: { worker: Worker; taskId: string; attempt: number; lastActivitySequence: number; log: (...args: unknown[]) => void; onCancel: () => void }) {
    this.#worker = options.worker;
    this.#taskId = options.taskId;
    this.#attempt = options.attempt;
    this.#activitySequence = options.lastActivitySequence;
    this.#log = options.log;
    this.#onCancel = options.onCancel;
  }

  get sessionEnabled(): boolean { return this.#enabled; }
  get cancelRequested(): boolean { return this.#cancelRequested; }

  async start(baseCommit: string | undefined, executor: string): Promise<void> {
    await this.#worker.reportExecutionActivity(this.#taskId, this.#attempt, { sequence: ++this.#activitySequence, kind: 'started', baseCommit: baseCommit ?? null, executor });
    await this.#refreshConsent();
    this.#configTimer = setInterval(() => { void this.#refreshConsent(); }, 5000);
  }

  async #refreshConsent(): Promise<void> {
    if (this.#configLoading || this.#closing) return;
    this.#configLoading = true;
    try {
      const consent = await this.#worker.getSessionObservation(this.#taskId);
      if (this.#closing) return;
      this.#enabled = consent.enabled;
      if (!consent.enabled) {
        this.#queue = this.#queue.filter(packet => packet.channel !== 'session');
        this.#queuedBytes = this.#queue.reduce((sum, packet) => sum + packet.bytes, 0);
      }
      if (consent.cancelRequested && !this.#cancelRequested) {
        this.#cancelRequested = true;
        this.#push({ channel: 'activity', event: { sequence: ++this.#activitySequence, kind: 'cancel_requested' }, bytes: 0 });
        this.#onCancel();
      }
    } catch (error) {
      this.#enabled = false;
      this.#log('会话观察授权读取失败，暂停共享：', error instanceof Error ? error.message : error);
    } finally { this.#configLoading = false; }
  }

  activity(activity: PiActivity): void {
    const event: ExecutionActivity = activity.waitingFor === 'abort_settle'
      ? { sequence: ++this.#activitySequence, kind: 'cancel_requested' }
      : { sequence: ++this.#activitySequence, kind: activity.kind, phase: activity.phase,
        callId: activity.callId,
        toolName: activity.kind === 'tool' ? (['read', 'write', 'edit', 'bash', 'powershell', 'hive_checkpoint'].includes(activity.toolName ?? '') ? activity.toolName : 'unknown') : undefined };
    this.#push({ channel: 'activity', event, bytes: 0 });
  }

  session(event: Omit<SessionObservationEvent, 'sequence'>): void {
    if (!this.#enabled || this.#closing) return;
    this.#push({ channel: 'session', event: { ...event, sequence: ++this.#sessionSequence }, bytes: 0 });
  }

  #push(packet: Packet): void {
    if (this.#controller.signal.aborted) return;
    packet.bytes = Buffer.byteLength(JSON.stringify(packet.event));
    if (this.#queue.length >= 64 || this.#queuedBytes + packet.bytes > 131072) {
      this.#lostActivity = true;
      this.#lostSession ||= this.#queue.some(item => item.channel === 'session') || packet.channel === 'session';
      this.#queue = [];
      this.#queuedBytes = 0;
    }
    this.#queue.push(packet);
    this.#queuedBytes += packet.bytes;
    if (!this.#timer && !this.#upload) this.#timer = setTimeout(() => { this.#timer = undefined; void this.#flush(); }, 100);
  }

  async #flush(): Promise<void> {
    if (this.#upload) return this.#upload;
    this.#upload = (async () => {
      while (this.#queue.length && !this.#controller.signal.aborted) {
        const packet = this.#queue.shift()!;
        this.#queuedBytes -= packet.bytes;
        const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(15_000)]);
        try {
          if (packet.channel === 'activity') {
            await this.#worker.reportExecutionActivity(this.#taskId, this.#attempt, packet.event, signal);
          } else if (this.#enabled) {
            const events = [packet.event];
            let bytes = packet.bytes;
            while (this.#queue[0]?.channel === 'session' && events.length < 16 && bytes + this.#queue[0].bytes < 12000) {
              const next = this.#queue.shift()!;
              if (next.channel !== 'session') break;
              this.#queuedBytes -= next.bytes;
              bytes += next.bytes;
              events.push(next.event);
            }
            await this.#worker.reportSessionEvents(this.#taskId, this.#attempt, events, signal);
          }
        } catch (error) {
          this.#lostActivity ||= packet.channel === 'activity';
          this.#lostSession ||= packet.channel === 'session';
          this.#log('任务观察上传暂不可用：', error instanceof Error ? error.message : error);
        }
      }
    })().finally(() => { this.#upload = null; });
    return this.#upload;
  }

  async confirmCancelled(): Promise<void> {
    await this.#worker.reportExecutionActivity(this.#taskId, this.#attempt, { sequence: ++this.#activitySequence, kind: 'cancelled' });
  }

  async finish(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    clearInterval(this.#configTimer);
    clearTimeout(this.#timer);
    const deadline = setTimeout(() => this.#controller.abort(), 5000);
    await this.#flush();
    clearTimeout(deadline);
    if (this.#queue.length) {
      this.#lostActivity = true;
      this.#lostSession ||= this.#queue.some(packet => packet.channel === 'session');
      this.#queue = [];
      this.#queuedBytes = 0;
    }
    const gapReports: Promise<unknown>[] = [];
    if (this.#lostActivity) gapReports.push(this.#worker.reportExecutionActivity(this.#taskId, this.#attempt, { sequence: ++this.#activitySequence, kind: 'gap' }, AbortSignal.timeout(3000)));
    if (this.#lostSession && this.#enabled) gapReports.push(this.#worker.reportSessionEvents(this.#taskId, this.#attempt, [{ sequence: ++this.#sessionSequence, kind: 'gap' }], AbortSignal.timeout(3000)));
    await Promise.all(gapReports.map(report => report.catch(error => this.#log('观察缺口通知失败：', error instanceof Error ? error.message : error))));
  }
}
