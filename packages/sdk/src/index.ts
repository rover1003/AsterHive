// AsterHive Worker SDK（立项计划 §9.1 最小 Worker 协议）
// 任何能发 HTTP 的 runtime 都能当 worker；TS 侧用本库，Python 随后。
// 七个调用：register（一次性）/ next / claim / checkpoint / submit / release / heartbeat
// 附：inbox / postMessage（聊天室）、getTask 与 getBoards / getBoard（看板元数据，含 repo）。

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
  workspace: Record<string, string>;
  files: string[];
  evidence: { path: string; machine?: string; note?: string }[];
  protectedPaths: string[];
  claimedAt: number | null;
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
  async checkpoint(taskId: string, note: string): Promise<{ task: Task; pendingMessages: PendingMessage[] }> {
    return call(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/checkpoint`, { note });
  }

  async submit(taskId: string, summary: string, evidence?: Task['evidence']): Promise<Task> {
    const r = await call<{ task: Task }>(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/submit`, {
      summary,
      evidence,
    });
    return r.task;
  }

  async release(taskId: string, reason?: string): Promise<Task> {
    const r = await call<{ task: Task }>(this.#baseUrl, this.#token, 'POST', `/tasks/${taskId}/release`, { reason });
    return r.task;
  }

  async heartbeat(): Promise<void> {
    await call(this.#baseUrl, this.#token, 'POST', `/agents/${this.#agentId}/heartbeat`);
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

  async downloadTaskSnapshot(taskId: string): Promise<{ buffer: ArrayBuffer; baseCommit: string }> {
    const headers: Record<string, string> = {};
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const res = await fetch(`${this.#baseUrl}/tasks/${taskId}/repo-snapshot`, { headers });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new SdkError(res.status, err || `HTTP ${res.status}`);
    }
    const baseCommit = res.headers.get('x-base-commit') ?? '';
    const buffer = await res.arrayBuffer();
    return { buffer, baseCommit };
  }

  async uploadTaskResult(taskId: string, bundleBuffer: Uint8Array, sha256: string): Promise<{ taskRef: string; headCommit: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/vnd.git.bundle',
      'content-length': String(bundleBuffer.byteLength),
      'x-content-sha256': sha256,
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
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
}
