// AsterHive Worker SDK（立项计划 §9.1 最小 Worker 协议）
// 任何能发 HTTP 的 runtime 都能当 worker；TS 侧用本库，Python 随后。
// 七个调用：register（一次性）/ next / claim / checkpoint / submit / release / heartbeat
// 附：inbox / postMessage（聊天室）、getTask 与 getBoards / getBoard（看板元数据，含 repo）。

import { createHash } from 'node:crypto';
import { platform, arch, cpus, totalmem, freemem, loadavg, uptime } from 'node:os';

/** 工蜂设备硬件能力规格（Phase 4：隐私最小化，仅上报调度相关指标） */
export interface AgentSpecs {
  os?: string; // 如 'win32' | 'darwin' | 'linux'
  arch?: string; // 如 'x64' | 'arm64'
  cpus?: number; // CPU 逻辑核心数
  memoryTotalGb?: number; // 物理总内存（GB，四舍五入）
  executor?: string; // 运行内核，如 'omp' | 'zcode' | 'shell'
  gpu?: string; // 可选 GPU 标识
}

/** 自动采样本机硬件能力（零配置、零外部依赖） */
export function detectDeviceSpecs(executor?: string): AgentSpecs {
  try {
    return {
      os: platform(),
      arch: arch(),
      cpus: cpus().length,
      memoryTotalGb: Math.round((totalmem() / 1073741824) * 10) / 10,
      executor: executor || undefined,
    };
  } catch {
    return {};
  }
}

/** 工蜂设备实时硬件性能遥测指标 */
export interface DeviceTelemetry {
  cpuPercent: number | null; // 0-100（当前 CPU 实际利用率百分比，首样本/无间隔/系统调用失败为 null）
  memoryUsedGb: number | null; // 已用物理内存（GB，采集失败为 null）
  memoryTotalGb: number | null; // 总物理内存（GB，采集失败为 null）
  memoryFreeGb: number | null; // 剩余可用物理内存（GB，采集失败为 null）
  memoryPercent: number | null; // 0-100（内存使用率百分比，采集失败为 null）
  loadAvg: number[] | null; // 系统负载走势 [1m, 5m, 15m]，Windows 或不可用平台为 null
  uptimeSec: number | null; // 运行时长（秒，采集失败为 null）
  taskInProgress?: string | null; // 当前正在执行的任务 ID，空闲为 null/undefined
}

let globalLastCpuSnapshot: { idle: number; total: number } | null = null;

export function computeCpuPercent(
  prev: { idle: number; total: number } | null | undefined,
  curr: { idle: number; total: number } | null | undefined,
): number | null {
  if (!prev || !curr) {
    // 首样本没有间隔，或当前采样失败，标记未知 (null)
    return null;
  }
  const deltaTotal = curr.total - prev.total;
  const deltaIdle = curr.idle - prev.idle;
  if (deltaTotal <= 0) {
    // 计算周期为 0（无时间差）或出现时钟跳变，无法计算真实利用率，标记为 null，不得伪报 0%
    return null;
  }
  const deltaBusy = Math.max(0, deltaTotal - deltaIdle);
  const pct = (deltaBusy / deltaTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

export interface SampleDeviceTelemetryOptions {
  taskInProgress?: string | null;
  /** 可选注入上一次 CPU 采样基准（测试用；显式传 null 可模拟首样本） */
  previousCpuSnapshot?: { idle: number; total: number } | null;
  osProvider?: {
    platform?: typeof platform;
    cpus?: typeof cpus;
    totalmem?: typeof totalmem;
    freemem?: typeof freemem;
    loadavg?: typeof loadavg;
    uptime?: typeof uptime;
  };
}

/** 毫秒级采样本机实时硬件性能遥测指标（零外部依赖、极低开销） */
export function sampleDeviceTelemetry(
  taskOrOptions?: string | null | SampleDeviceTelemetryOptions,
): DeviceTelemetry {
  const options: SampleDeviceTelemetryOptions =
    typeof taskOrOptions === 'string' || taskOrOptions === null
      ? { taskInProgress: taskOrOptions }
      : taskOrOptions ?? {};

  const platformFn = options.osProvider?.platform ?? platform;
  const cpusFn = options.osProvider?.cpus ?? cpus;
  const totalmemFn = options.osProvider?.totalmem ?? totalmem;
  const freememFn = options.osProvider?.freemem ?? freemem;
  const loadavgFn = options.osProvider?.loadavg ?? loadavg;
  const uptimeFn = options.osProvider?.uptime ?? uptime;

  // CPU 采样
  let currentTicks: { idle: number; total: number } | null = null;
  try {
    const cpuList = cpusFn();
    if (Array.isArray(cpuList) && cpuList.length > 0) {
      let idle = 0;
      let total = 0;
      for (const cpu of cpuList) {
        const t = cpu.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
      }
      if (total > 0) {
        currentTicks = { idle, total };
      }
    }
  } catch {
    currentTicks = null;
  }

  const baseline =
    options.previousCpuSnapshot !== undefined
      ? options.previousCpuSnapshot
      : globalLastCpuSnapshot;
  const cpuPercent = computeCpuPercent(baseline, currentTicks);
  if (currentTicks) {
    globalLastCpuSnapshot = currentTicks;
  }

  // 内存采样（失败保持 null，不得伪报 0）
  let memoryTotalGb: number | null = null;
  let memoryFreeGb: number | null = null;
  let memoryUsedGb: number | null = null;
  let memoryPercent: number | null = null;
  try {
    const totalBytes = totalmemFn();
    const freeBytes = freememFn();
    if (typeof totalBytes === 'number' && totalBytes > 0 && typeof freeBytes === 'number' && freeBytes >= 0) {
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      memoryTotalGb = Math.round((totalBytes / 1073741824) * 100) / 100;
      memoryFreeGb = Math.round((freeBytes / 1073741824) * 100) / 100;
      memoryUsedGb = Math.round((usedBytes / 1073741824) * 100) / 100;
      memoryPercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10;
    }
  } catch {
    // 采集失败保持 null，不得伪报 0
  }

  // 负载走势采样（Windows os.loadavg() 始终为 [0, 0, 0]，标记为不可用 null）
  let loadAvg: number[] | null = null;
  let currentPlatform = 'unknown';
  try {
    currentPlatform = platformFn();
  } catch {
    // 忽略
  }

  if (currentPlatform !== 'win32') {
    try {
      const raw = loadavgFn();
      if (Array.isArray(raw) && raw.length === 3 && raw.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        loadAvg = raw.map((n) => Math.round(n * 100) / 100);
      }
    } catch {
      loadAvg = null;
    }
  }

  // 运行时间采样
  let uptimeSec: number | null = null;
  try {
    const up = uptimeFn();
    if (typeof up === 'number' && Number.isFinite(up) && up >= 0) {
      uptimeSec = Math.round(up);
    }
  } catch {
    uptimeSec = null;
  }

  const telemetry: DeviceTelemetry = {
    cpuPercent,
    memoryUsedGb,
    memoryTotalGb,
    memoryFreeGb,
    memoryPercent,
    loadAvg,
    uptimeSec,
  };

  if (options.taskInProgress !== undefined) {
    telemetry.taskInProgress = options.taskInProgress;
  }

  return telemetry;
}

export interface Board {
  id: string;
  name: string;
  /** GitHub 仓库地址（项目元数据，可空——空则 worker 对该板用一次性任务目录） */
  repo: string;
  description: string;
  repoMode?: 'managed' | 'remote-legacy';
  repoStatus?: 'empty' | 'queued' | 'running' | 'ready' | 'failed';
  repoHead?: string;
  repoError?: string;
  wip: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export interface TaskProgress {
  lastActivityAt: number | null;
  lastActivityKind: string | null;
  lastProgressAt: number | null;
  workerLastSeenAt: number | null;
  status: 'active' | 'no_recent_activity' | 'offline' | 'unknown';
}

export interface Task {
  id: string;
  boardId: string;
  title: string;
  detail: string;
  lane: string;
  assignee: string;
  dependsOn: string[];
  priority: string;
  category: string;
  acceptance: string;
  workspace: Record<string, unknown>;
  files: string[];
  evidence: { path: string; machine?: string; note?: string }[];
  protectedPaths: string[];
  claimedAt: number | null;
  lastActivityAt?: number | null;
  lastProgressAt?: number | null;
  lastActivityKind?: string | null;
  progress?: TaskProgress | null;
  reviewStatus?: string;
  reviewAttempts?: number;
  reviewReworks?: number;
  reviewSummary?: string;
  submitSummary?: string;
  attempt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PendingMessage {
  id: number;
  author: string;
  mentions: string[];
  taskRef: string | null;
  content: string;
  createdAt: number;
}

export class SdkError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(
  baseUrl: string,
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new SdkError(res.status, String(json.error ?? res.statusText));
  return json as T;
}

// ---- 接入极简化（默认身份 + 注册冲突自愈）----

/** 注册入参（Worker.register 与 registerWithRetry 共用） */
export interface RegisterOptions {
  id?: string;
  name: string;
  handle: string;
  role?: 'worker' | 'orchestrator' | 'user';
  models?: string[];
  host?: string;
  specs?: AgentSpecs;
}

export interface RegisterResult {
  agentId: string;
  handle: string;
  token: string;
}

/** 由接入设备名推导默认 worker 身份（接入极简化：用户只给服务器地址，其余自动）。
 *  handle = "worker-" + host 小写、去非 [a-z0-9] 字符后的前 8 位（剥完为空则用 "node"）；
 *  name = "Worker@" + host（截 32 字符）。 */
export function defaultWorkerIdentity(host: string): { name: string; handle: string } {
  const slug = host.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'node';
  return { name: `Worker@${host.slice(0, 32)}`, handle: `worker-${slug}` };
}

/** 带冲突自愈的注册：服务器对重复 id/handle 返回 409，此时给 handle 追加 -2、-3…
 *  （连原号最多共试 5 次）再注册，成功即用。用户显式指定的 handle 撞名也走同一重试
 *  （自动后缀比直接报错友好）。返回最终生效的 handle——与传入不同即发生了自动改名，
 *  调用方可据此提示用户。 */
export async function registerWithRetry(w: Worker, input: RegisterOptions): Promise<RegisterResult> {
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const handle = attempt === 1 ? input.handle : `${input.handle}-${attempt}`;
    try {
      return await w.register({ ...input, handle });
    } catch (err) {
      if (err instanceof SdkError && err.status === 409) {
        lastErr = err;
        continue;
      }
      throw err; // 非 409（网络/422 等）原样上抛，不掩盖真实故障
    }
  }
  throw new Error(
    `注册失败：handle "${input.handle}" 连同后缀 -2…-${MAX_ATTEMPTS} 均已被占用` +
      (lastErr instanceof SdkError ? `（最后一次：${lastErr.status}: ${lastErr.message}）` : ''),
  );
}

export class Worker {
  #baseUrl: string;
  #token?: string;
  #agentId: string;

  constructor(baseUrl: string, token?: string, agentId = 'unregistered') {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#token = token;
    this.#agentId = agentId;
  }

  get agentId(): string {
    return this.#agentId;
  }

  get token(): string | undefined {
    return this.#token;
  }

  /** 一次性注册；token 仅返回这一次，调用方自行持久化。
   *  单用户模型下角色自由（worker/orchestrator/user 均可，无管理令牌门槛），
   *  但"用户"身份通常应走 PUT /api/user（设置页），这里主要供 worker/主脑注册。
   *  models：注册时自报本机可用模型清单（后续可用 reportModels 全量覆盖）。
   *  host：注册时自报接入设备名（CLI 默认填 os.hostname()；注册后不再变更）。
   *  需要撞名自愈请直接用 registerWithRetry。 */
  async register(
    input: RegisterOptions,
  ): Promise<RegisterResult> {
    const r = await call<{ agent: { id: string; handle: string }; token: string }>(
      this.#baseUrl,
      this.#token,
      'POST',
      '/agents/register',
      input,
    );
    this.#token = r.token;
    this.#agentId = r.agent.id;
    return { agentId: r.agent.id, handle: r.agent.handle, token: r.token };
  }

  /** 自报/更新自己的模型清单（全量覆盖；token 即身份，只能改自己） */
  async reportModels(models: string[]): Promise<string[]> {
    const r = await call<{ agent: { models: string[] } }>(
      this.#baseUrl,
      this.#token,
      'POST',
      '/agents/me/models',
      { models },
    );
    return r.agent.models;
  }

  /** 自报/更新工蜂设备硬件能力规格（OS/架构/CPU/内存等） */
  async reportSpecs(specs: AgentSpecs): Promise<AgentSpecs> {
    const r = await call<{ agent: { specs: AgentSpecs } }>(
      this.#baseUrl,
      this.#token,
      'POST',
      '/agents/me/specs',
      { specs },
    );
    return r.agent.specs;
  }

  /** 拉自己的档案速览：自报模型 + 用户在设置页为本 agent 选的首选模型 */
  async getMyProfile(): Promise<{ agentId: string; models: string[]; preferredModel: string | null }> {
    return call(this.#baseUrl, this.#token, 'GET', '/agents/me/profile');
  }

  /** 看板列表（含 repo 等项目元数据；worker 据此决定持久项目工作区还是一次性目录） */
  async getBoards(): Promise<Board[]> {
    const r = await call<{ boards: Board[] }>(this.#baseUrl, this.#token, 'GET', '/boards');
    return r.boards;
  }

  /** 读单个看板（服务器无单板端点，从列表本地过滤；不存在抛 SdkError 404） */
  async getBoard(boardId: string): Promise<Board> {
    const boards = await this.getBoards();
    const board = boards.find((b) => b.id === boardId);
    if (!board) throw new SdkError(404, `board not found: ${boardId}`);
    return board;
  }

  /** 动态拉取：未认领 + 已解锁 + 按优先级；原子认领（含 TTL 扫掠） */
  async next(boardId: string): Promise<Task | null> {
    const r = await call<{ task: Task | null; swept: string[] }>(this.#baseUrl, this.#token, 'POST', `/boards/${boardId}/next`);
    return r.task;
  }

  async claim(taskId: string, files?: string[]): Promise<Task> {
    const r = await call<{ task: Task }>(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/claim`, files ? { files } : {});
    return r.task;
  }

  /** 双向同步点：返回自上次以来 @ 到本 worker 的消息（干预直达） */
  async checkpoint(
    taskId: string,
    noteOrOptions: string | { note: string; kind?: string; isKeepalive?: boolean; attempt?: number },
  ): Promise<{ task: Task; pendingMessages: PendingMessage[] }> {
    const body = typeof noteOrOptions === 'string' ? { note: noteOrOptions } : noteOrOptions;
    return call(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/checkpoint`, body);
  }

  /** 将 Review 状态任务受控退回指定工蜂重做 */
  async returnReviewTask(taskId: string, reason?: string, assignee?: string): Promise<Task> {
    const r = await call<{ task: Task }>(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/review/return`, {
      reason,
      assignee,
    });
    return r.task;
  }

  async submit(taskId: string, summary: string, evidence?: Task['evidence'], options?: { noCode?: boolean; attempt?: number }): Promise<Task> {
    const r = await call<{ task: Task }>(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/submit`, {
      summary,
      evidence,
      noCode: options?.noCode,
      attempt: options?.attempt,
    });
    return r.task;
  }

  async release(taskId: string, reason?: string): Promise<Task> {
    const r = await call<{ task: Task }>(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/release`, { reason });
    return r.task;
  }

  async heartbeat(specs?: AgentSpecs, telemetry?: DeviceTelemetry): Promise<void> {
    const body: { specs?: AgentSpecs; telemetry?: DeviceTelemetry } = {};
    if (specs !== undefined) body.specs = specs;
    if (telemetry !== undefined) body.telemetry = telemetry;
    await call(
      this.#baseUrl,
      this.#token,
      'POST',
      `/agents/${this.#agentId}/heartbeat`,
      Object.keys(body).length > 0 ? body : undefined,
    );
  }

  async inbox(since = 0): Promise<PendingMessage[]> {
    const r = await call<{ messages: PendingMessage[] }>(
      this.#baseUrl,
      this.#token,
      'GET',
      `/agents/me/inbox?since=${since}`,
    );
    return r.messages;
  }

  async postMessage(boardId: string, content: string, kind?: string): Promise<void> {
    await call(this.#baseUrl, this.#token, 'POST', `/boards/${boardId}/messages`, { content, kind });
  }

  async getTask(taskId: string): Promise<Task> {
    const r = await call<{ task: Task }>(this.#baseUrl, this.#token, 'GET', `/tasks/${taskId}`);
    return r.task;
  }

  async downloadTaskSnapshot(taskId: string, attempt?: number): Promise<{ buffer: ArrayBuffer; baseCommit: string; reworkCommit?: string; reworkBranch?: string }> {
    const headers: Record<string, string> = {};
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (attempt !== undefined) headers['x-task-attempt'] = String(attempt);
    const res = await fetch(`${this.#baseUrl}/tasks/${taskId}/repo-snapshot`, { headers });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new SdkError(res.status, err || `HTTP ${res.status}`);
    }
    const baseCommit = res.headers.get('x-base-commit') ?? '';
    const reworkCommit = res.headers.get('x-rework-commit') ?? undefined;
    const reworkBranch = res.headers.get('x-rework-branch') ?? undefined;
    const buffer = await res.arrayBuffer();
    return { buffer, baseCommit, reworkCommit, reworkBranch };
  }

  async uploadTaskResult(taskId: string, bundleBuffer: Uint8Array, sha256: string, attempt?: number): Promise<{ taskRef: string; headCommit: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/vnd.git.bundle',
      'content-length': String(bundleBuffer.byteLength),
      'x-content-sha256': sha256,
      ...(attempt !== undefined ? { 'x-task-attempt': String(attempt) } : {}),
    };
    const res = await fetch(`${this.#baseUrl}/tasks/${taskId}/repo-result`, {
      method: 'POST',
      headers,
      body: bundleBuffer,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new SdkError(res.status, err || `HTTP ${res.status}`);
    }
    return (await res.json()) as { taskRef: string; headCommit: string };
  }

  /** 上传证据文件（小文件入库、大文件登记校验和；<= 50MiB） */
  async uploadEvidence(taskId: string, filename: string, content: Uint8Array, note = ''): Promise<EvidenceFileInfo> {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(content.byteLength),
      'x-filename': encodeURIComponent(filename),
      'x-content-sha256': createHash('sha256').update(content).digest('hex'),
    };
    if (note) headers['x-note'] = encodeURIComponent(note);
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const res = await fetch(`${this.#baseUrl}/tasks/${taskId}/evidence`, {
      method: 'POST',
      headers,
      body: content,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new SdkError(res.status, err || `HTTP ${res.status}`);
    }
    const r = (await res.json()) as { file: EvidenceFileInfo };
    return r.file;
  }

  /** 列出任务的证据文件元数据（不含内容） */
  async listEvidence(taskId: string): Promise<EvidenceFileInfo[]> {
    const r = await call<{ files: EvidenceFileInfo[] }>(this.#baseUrl, this.#token, 'GET', `/tasks/${taskId}/evidence`);
    return r.files;
  }

  /** 下载证据文件内容并校验 SHA-256 */
  async downloadEvidence(taskId: string, fileId: number): Promise<{ file: EvidenceFileInfo; content: Uint8Array }> {
    const res = await fetch(`${this.#baseUrl}/tasks/${taskId}/evidence/${fileId}`, {
      headers: this.#token ? { authorization: `Bearer ${this.#token}` } : undefined,
    });
    if (!res.ok) throw new SdkError(res.status, await res.text().catch(() => `HTTP ${res.status}`));
    const buf = new Uint8Array(await res.arrayBuffer());
    const file = {
      id: fileId,
      taskId,
      filename: decodeURIComponent(res.headers.get('content-disposition')?.split("''")[1] ?? `file-${fileId}`),
      size: buf.byteLength,
      sha256: res.headers.get('x-content-sha256') ?? '',
    } as EvidenceFileInfo;
    return { file, content: buf };
  }
}

export interface EvidenceFileInfo {
  id: number;
  taskId: string;
  boardId?: string;
  filename: string;
  size: number;
  sha256: string;
  storage?: 'db' | 'disk';
  note?: string;
  uploadedBy?: string;
  createdAt?: number;
}
