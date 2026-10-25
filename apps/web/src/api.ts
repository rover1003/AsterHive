// 类型化 API 客户端：浏览器身份 token 存 localStorage（单用户模型——token 属于服务器唯一用户）
const TOKEN_KEY = 'asterhive.token';
const HANDLE_KEY = 'asterhive.handle';
const USER_NAME_KEY = 'asterhive.userName'; // displayAuthor 缓存：从 GET /api/user 拉取后存一份

export interface Board {
  id: string;
  name: string;
  /** GitHub 仓库地址（项目元数据，可空） */
  repo: string;
  /** 项目描述（可空） */
  description: string;
  wip: Record<string, number>;
  createdAt: number;
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
  lastActivityAt: number | null;
  autoUnblockedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface Message {
  id: number;
  boardId: string;
  author: string;
  kind: string;
  mentions: string[];
  taskRef: string | null;
  content: string;
  createdAt: number;
}
export interface Agent {
  id: string;
  name: string;
  handle: string;
  role: string;
  enabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** agent 自报的可用模型清单（CLI worker 经 WORKER_MODELS / me/models 上报） */
  models: string[];
  /** 用户为其设置的首选模型（null = 未设置，worker 用本地配置） */
  preferredModel: string | null;
  /** 备注 */
  note: string;
  /** 接入设备名（注册时自报，空 = 手动预创建的身份壳） */
  host: string;
}
export interface AgentOverview {
  id: string;
  name: string;
  handle: string;
  host: string;
  role: string;
  enabled: boolean;
  lastSeenAt: number | null;
  status: 'working' | 'idle' | 'stale' | 'disabled';
  currentTask: {
    id: string;
    title: string;
    boardId: string;
    claimedAt: number;
    elapsedMs: number;
    lastCheckpoint: { note: string; time: number } | null;
  } | null;
  doneCount: number;
}
export interface Overview {
  agents: AgentOverview[];
  aggregates: {
    working: number;
    idle: number;
    stale: number;
    disabled: number;
    lanes: Record<string, { count: number; limit: number | null }>;
  };
  generatedAt: number;
}
export interface AuditEntry {
  time: number;
  label: string;
  result: string;
  detail?: string;
}
export interface OrchestratorSettings {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKeySet?: boolean;
  /** 内置主脑总开关（T14，默认关） */
  enabled?: boolean;
  wakeOn?: Record<string, boolean>;
}
/** Pi 运行时状态（T14：GET /settings/runtime） */
export interface RuntimeStatus {
  current: string | null;
  source: 'volume' | 'baseline';
  latest: string | null;
  updating: { from: string; to: string; startedAt: number } | null;
  extensionsDir: string;
}
/** GET /api/user：单用户身份状态 */
export interface UserStatus {
  handle: string | null;
  configured: boolean;
}
/** PUT /api/user：幂等 upsert，每次都轮换签发新 token（旧 token 立即失效） */
export interface UserUpsertResult {
  agent: Agent;
  token: string;
  created: boolean;
  /** 首次创建身份时一并停用的旧 user 角色 agent（保留历史） */
  migrated?: { id: string; handle: string; name: string }[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function clearIdentity(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(HANDLE_KEY);
}

/** displayAuthor 用的用户名缓存（同步读取） */
export function cachedUserName(): string | null {
  return localStorage.getItem(USER_NAME_KEY);
}
export function setCachedUserName(name: string | null): void {
  if (name === null) localStorage.removeItem(USER_NAME_KEY);
  else localStorage.setItem(USER_NAME_KEY, name);
}

// 拉取并缓存单用户用户名（应用启动与设置页保存后调用）；失败静默——离线时沿用旧缓存
export async function refreshUserCache(): Promise<void> {
  try {
    const u = await api.get<UserStatus>('/api/user');
    setCachedUserName(u.handle);
  } catch {
    /* 离线/旧服务器：保留旧缓存 */
  }
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // 零令牌（2026-10-25 用户终裁）：浏览器请求不携带任何凭据，服务器视为唯一用户
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(json.error ?? res.statusText));
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => req<T>('GET', path),
  post: <T>(path: string, body?: unknown) => req<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => req<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => req<T>('PUT', path, body),
  del: <T>(path: string) => req<T>('DELETE', path),
};
