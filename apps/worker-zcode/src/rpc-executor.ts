// OMP RPC 常驻执行内核（EXECUTOR_MODE=rpc 显式启用）。
// 协议依据 docs/research/asterhub-rpc/rpc-control.md；未验证的事件名/字段不使用。
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';

export interface RpcState {
  sessionId?: string;
  sessionFile?: string;
  contextPercent?: number; // contextUsage.percent；缺失 = 未知（不参与阈值决策）
  settled?: boolean;
}

export interface RpcPromptResult {
  status: 'completed' | 'error' | 'aborted';
  text: string;
}

/** 上下文阈值决策（纯函数，测试友好）。默认值与 AsterHub 阈值语义一致（0-100）。 */
export const DEFAULT_THRESHOLDS: CtxThresholds = { shake: 60, compact: 80, stop: 90, resume: 60 };

export type ContextAction = 'none' | 'shake' | 'compact' | 'stop';

/** 阈值分层（0-100）：STOP 优先，随后 COMPACT、SHAKE；未知占用不猜。 */
export function contextAction(percent: number | undefined, t: CtxThresholds): ContextAction {
  if (percent === undefined) return 'none';
  if (percent >= t.stop) return 'stop';
  if (percent >= t.compact) return 'compact';
  if (percent >= t.shake) return 'shake';
  return 'none';
}

export interface CtxThresholds {
  shake: number;
  compact: number;
  stop: number;
  resume: number;
}

export class OmpRpcSession {
  #proc: ChildProcess | null = null;
  #nextId = 0;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #resultWaiters = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #lastState: RpcState = {};
  #dead = false;
  #ready = false;
  #readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  #stderrTail: string[] = [];
  readonly modelId?: string;
  readonly sessionDir: string;
  private readonly opts: {
    ompBin: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    cwd: string;
    sessionDir: string;
    model?: string;
    timeoutMs: number;
    log: (s: string) => void;
  };

  constructor(opts: {
    ompBin: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    cwd: string;
    sessionDir: string;
    model?: string;
    timeoutMs: number;
    log: (s: string) => void;
  }) {
    this.opts = opts;
    this.modelId = opts.model;
    this.sessionDir = opts.sessionDir;
  }

  /** 上次会话文件（恢复本 session 私有目录中精确报告的文件） */
  get lastSessionFile(): string | undefined {
    return this.#lastState.sessionFile;
  }

  get alive(): boolean {
    return this.#proc !== null && !this.#dead && this.#proc.exitCode === null;
  }

  /** 启动 RPC 子进程。参数数组直传（协议纪律：禁 shell 拼接）。 */
  async start(): Promise<void> {
    if (this.alive) return;
    mkdirSync(this.opts.sessionDir, { recursive: true });
    const args = [
      ...(this.opts.args ?? []),
      '--mode', 'rpc',
      '--cwd', this.opts.cwd,
      '--session-dir', this.opts.sessionDir,
      '--no-extensions', '--no-title',
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    const proc = spawn(this.opts.ompBin, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env }, // 默认继承 HOME/PATH/认证；仅测试可覆盖场景变量
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#proc = proc;
    this.#dead = false;
    proc.on('error', (err) => {
      this.#dead = true;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.#pending.clear();
      for (const p of this.#resultWaiters.values()) {
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.#resultWaiters.clear();
      for (const waiter of this.#readyWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    proc.on('exit', () => {
      this.#dead = true;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('RPC 进程已退出'));
      }
      this.#pending.clear();
      for (const p of this.#resultWaiters.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('RPC 进程已退出'));
      }
      this.#resultWaiters.clear();
      for (const waiter of this.#readyWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('OMP RPC 进程已退出'));
      }
    });
    if (proc.stderr) {
      const rl = createInterface({ input: proc.stderr });
      rl.on('line', (l: string) => {
        this.#stderrTail.push(l);
        if (this.#stderrTail.length > 50) this.#stderrTail.shift(); // 只留内存尾部，可能含源码/秘密，绝不落盘或上报
      });
    }
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line: string) => {
        if (Buffer.byteLength(line, 'utf8') > 1_048_576) {
          this.#dead = true;
          this.#logLocal('OMP RPC JSONL 帧超过协议 1MiB 限额；关闭该会话');
          proc.kill('SIGKILL');
          return;
        }
        this.#onLine(line);
      });
    }
    try {
      // JSONL ready 握手是 RPC channel 可用的边界；ready 前 stdout 可能先发能力/配置通知，
      // 忽略即可（有界内存），不能在 ready 前发送 get_state。
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve: () => { clearTimeout(waiter.timer); resolve(); },
          reject,
          timer: setTimeout(() => {
            this.#readyWaiters = this.#readyWaiters.filter((w) => w !== waiter);
            reject(new Error('等待 OMP RPC ready 超时'));
          }, 15_000),
        };
        this.#readyWaiters.push(waiter);
        if (this.#dead) {
          this.#readyWaiters = this.#readyWaiters.filter((w) => w !== waiter);
          clearTimeout(waiter.timer);
          reject(new Error('OMP RPC 启动即退出'));
        }
      });
      await this.getState(); // 探活：进程启动不等于 RPC 命令面可用
    } catch (err) {
      await this.#terminate();
      throw err;
    }
  }

  #onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 非 JSON 行（版本横幅等）忽略
    }
    if (msg.type === 'ready') {
      this.#ready = true;
      for (const waiter of this.#readyWaiters.splice(0)) waiter.resolve();
      return;
    }
    // ready 前的能力/通知帧忽略，不缓存；事件只交给已注册 waiter。
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    // 协议真实响应：{type:'response', id, command, success, data:{…}}。
    if (msg.type === 'response' && id && this.#pending.has(id)) {
      const waiter = this.#pending.get(id)!;
      this.#pending.delete(id);
      clearTimeout(waiter.timer);
      if (msg.success === false) waiter.reject(new Error(`RPC ${String(msg.command ?? '')} 失败：${String(msg.error ?? 'request failed')}`));
      else waiter.resolve(msg);
      return;
    }
    if (msg.type === 'prompt_result' && id && this.#resultWaiters.has(id)) {
      const waiter = this.#resultWaiters.get(id)!;
      this.#resultWaiters.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  #send(type: string, extra: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const proc = this.#proc;
    if (!proc?.stdin || this.#dead) return Promise.reject(new Error('RPC 会话不可用'));
    const id = `r${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC 请求超时：${type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin!.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });
  }

  /** get_state：宽松解析，字段缺失不构成失败（协议：窗口/扩展字段缺失≠连接失败） */
  async getState(): Promise<RpcState> {
    const res = await this.#send('get_state');
    if (res.success === false) throw new Error(`get_state 失败：${String(res.error ?? 'request failed')}`);
    const data = (res.data ?? {}) as Record<string, unknown>;
    this.#lastState = {
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
      sessionFile: typeof data.sessionFile === 'string' ? data.sessionFile : undefined,
      contextPercent:
        typeof (data.contextUsage as Record<string, unknown> | undefined)?.percent === 'number'
          ? ((data.contextUsage as Record<string, unknown>).percent as number)
          : undefined,
      settled: typeof data.isSettled === 'boolean' ? data.isSettled : undefined,
    };
    return this.#lastState;
  }

  /**
   * 派发任务并按协议门禁收结果：
   * 受理（同 id response）→ prompt_result（completed/error/aborted）→ settled 确认 →
   * completed 才 get_last_assistant_text（禁止拿上一轮文字冒充）。
   */
  async runPrompt(message: string): Promise<RpcPromptResult> {
    const proc = this.#proc;
    if (!proc?.stdin || this.#dead || !this.#ready) throw new Error('RPC 会话不可用');
    const id = `p${++this.#nextId}`;
    // 先注册 prompt_result waiter 再发请求，避免极快完成时丢失结果帧。
    const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#resultWaiters.delete(id);
        reject(new Error('RPC 任务执行超时'));
      }, this.opts.timeoutMs);
      this.#resultWaiters.set(id, { resolve, reject, timer });
    });
    let accepted: Record<string, unknown>;
    try {
      accepted = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error('RPC 派发受理超时'));
        }, 30_000);
        this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        proc.stdin!.write(`${JSON.stringify({ id, type: 'prompt', message })}\n`);
      });
    } catch (err) {
      const waiter = this.#resultWaiters.get(id);
      if (waiter) clearTimeout(waiter.timer);
      this.#resultWaiters.delete(id);
      throw err;
    }
    if (accepted.success === false) {
      const waiter = this.#resultWaiters.get(id);
      if (waiter) clearTimeout(waiter.timer);
      this.#resultWaiters.delete(id);
      throw new Error(`RPC 派发被拒：${String(accepted.error ?? 'request failed').slice(0, 120)}`);
    }
    const result = await resultPromise;
    const status = String(result.status ?? 'error') as RpcPromptResult['status'];
    if (status !== 'completed') return { status, text: String(result.error ?? '') };

    // prompt_result 后用 OMP response.data.isSettled 作为最终门禁；此字段已通过本机真实 get_state 探针确认。
    const state = await this.getState();
    if (state.settled !== true) {
      throw new Error(`RPC prompt_result 已到但 isSettled=${String(state.settled)}；拒绝读取旧结果`);
    }
    const textRes = await this.#send('get_last_assistant_text');
    const data = (textRes.data ?? {}) as Record<string, unknown>;
    const text = data.text ?? data.lastAssistantText;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('RPC completed 但 get_last_assistant_text 无文本；拒绝把空文本当成功');
    }
    return { status: 'completed', text: `（${hostname()} RPC 会话执行）\n${text}` };
  }

  async compact(instructions: string): Promise<boolean> {
    const res = await this.#send('compact', { customInstructions: instructions });
    return res.success !== false;
  }

  async abort(): Promise<void> {
    try {
      await this.#send('abort');
    } catch {
      /* abort 响应缺失不阻塞——kill 兜底 */
    }
  }

  async #terminate(): Promise<void> {
    const proc = this.#proc;
    this.#dead = true;
    this.#proc = null;
    if (!proc || proc.exitCode !== null) return;
    proc.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 3_000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 关闭并等待退出，超时强杀；调用方在任务 settled/失败边界 await。 */
  async kill(): Promise<void> {
    await this.#terminate();
  }

  get stderrTail(): string {
    return this.#stderrTail.join('\n');
  }

  #logLocal(message: string): void {
    this.opts.log(message); // 仅固定摘要；不输出原始 stderr/frame（可能含秘密）
  }
}
