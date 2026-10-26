import { createHash, randomBytes } from 'node:crypto';
import type { Ctx } from './types.ts';
import { HttpError, assertNoMojibake } from './types.ts';
import { withWrite, logEvent } from './write.ts';

export type AgentRole = 'worker' | 'orchestrator' | 'user';

/** 工蜂设备硬件能力规格（Phase 4：隐私最小化，仅上报调度相关指标） */
export interface AgentSpecs {
  os?: string; // 如 'win32' | 'darwin' | 'linux'
  arch?: string; // 如 'x64' | 'arm64'
  cpus?: number; // CPU 逻辑核心数
  memoryTotalGb?: number; // 物理总内存（GB，四舍五入）
  executor?: string; // 运行内核，如 'omp' | 'zcode' | 'shell'
  gpu?: string; // 可选 GPU 标识
}

export interface Agent {
  id: string;
  name: string;
  handle: string;
  role: AgentRole;
  enabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** 自报可用模型清单（CLI worker 经 WORKER_MODELS / me/models 上报） */
  models: string[];
  /** 用户为其设置的首选模型（null = 未设置，worker 用本地配置） */
  preferredModel: string | null;
  /** 备注（设备主人可自由填写） */
  note: string;
  /** 接入设备名（注册时自报，如 os.hostname()；注册后不再变更，空 = 手动预创建的身份壳） */
  host: string;
  /** 设备能力规格（操作系统、架构、CPU、内存等） */
  specs: AgentSpecs;
}

// 蜂群主脑保留句柄，不允许普通注册占用
const RESERVED_HANDLES = new Set([
  '主脑',
  'orchestrator',
  'brain',
  '蜂后',
  'queen',
  'Queen',
]);

export type AgentRow = {
  id: string;
  name: string;
  handle: string;
  role: AgentRole;
  enabled: number;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  models: string;
  preferred_model: string | null;
  note: string;
  host: string;
  specs?: string;
};

function parseModels(raw: string | undefined | null): string[] {
  // 坏数据兜底：非数组 JSON 一律回退空清单，不让脏库打穿 API
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is string => typeof m === 'string');
  } catch {
    return [];
  }
}

function parseSpecs(raw: string | undefined | null): AgentSpecs {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const specs: AgentSpecs = {};
    if (typeof obj.os === 'string') specs.os = obj.os.trim().slice(0, 32);
    if (typeof obj.arch === 'string') specs.arch = obj.arch.trim().slice(0, 32);
    if (typeof obj.cpus === 'number' && Number.isSafeInteger(obj.cpus) && obj.cpus > 0) specs.cpus = obj.cpus;
    if (typeof obj.memoryTotalGb === 'number' && obj.memoryTotalGb > 0) specs.memoryTotalGb = Math.round(obj.memoryTotalGb * 10) / 10;
    if (typeof obj.executor === 'string') specs.executor = obj.executor.trim().slice(0, 32);
    if (typeof obj.gpu === 'string') specs.gpu = obj.gpu.trim().slice(0, 64);
    return specs;
  } catch {
    return {};
  }
}

export function normalizeSpecs(raw: unknown): AgentSpecs {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(422, 'specs: object required');
  const obj = raw as Record<string, unknown>;
  const out: AgentSpecs = {};
  if (obj.os !== undefined) {
    if (typeof obj.os !== 'string') throw new HttpError(422, 'specs.os: string required');
    out.os = obj.os.trim().slice(0, 32);
  }
  if (obj.arch !== undefined) {
    if (typeof obj.arch !== 'string') throw new HttpError(422, 'specs.arch: string required');
    out.arch = obj.arch.trim().slice(0, 32);
  }
  if (obj.cpus !== undefined) {
    if (typeof obj.cpus !== 'number' || !Number.isSafeInteger(obj.cpus) || obj.cpus <= 0) {
      throw new HttpError(422, 'specs.cpus: positive integer required');
    }
    out.cpus = obj.cpus;
  }
  if (obj.memoryTotalGb !== undefined) {
    if (typeof obj.memoryTotalGb !== 'number' || obj.memoryTotalGb <= 0) {
      throw new HttpError(422, 'specs.memoryTotalGb: positive number required');
    }
    out.memoryTotalGb = Math.round(obj.memoryTotalGb * 10) / 10;
  }
  if (obj.executor !== undefined) {
    if (typeof obj.executor !== 'string') throw new HttpError(422, 'specs.executor: string required');
    out.executor = obj.executor.trim().slice(0, 32);
  }
  if (obj.gpu !== undefined) {
    if (typeof obj.gpu !== 'string') throw new HttpError(422, 'specs.gpu: string required');
    out.gpu = obj.gpu.trim().slice(0, 64);
  }
  return out;
}

function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    name: r.name,
    handle: r.handle,
    role: r.role,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    models: parseModels(r.models),
    preferredModel: r.preferred_model,
    note: r.note ?? '',
    host: r.host ?? '',
    specs: parseSpecs(r.specs),
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RegisterInput {
  id?: string;
  name: string;
  handle: string;
  role?: AgentRole;
  /** 注册时自报可用模型清单（可选；后续可用 me/models 更新） */
  models?: string[];
  /** 注册时自报接入设备名（可选，通常由 CLI 填 os.hostname()；注册后不再变更） */
  host?: string;
  /** 注册时自报设备硬件能力（可选，如 OS/架构/CPU/内存） */
  specs?: AgentSpecs;
}

// 模型清单归一：去空白、去空项、去重；每项过乱码校验（注册自报与 me/models 共用）。
function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) throw new HttpError(422, 'models: string[] required');
  const out: string[] = [];
  for (const m of models) {
    if (typeof m !== 'string') throw new HttpError(422, 'models: string[] required');
    const v = m.trim();
    if (!v) continue;
    assertNoMojibake(v, 'models');
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// 句柄合法性统一校验：非空、非保留句柄、无乱码（注册与单用户设置共用）。
export function assertValidHandle(handle: string): string {
  const h = handle.trim();
  if (!h || RESERVED_HANDLES.has(h)) {
    throw new HttpError(422, `invalid or reserved handle: ${h}`);
  }
  assertNoMojibake(h, 'handle');
  return h;
}

// 注册自由化（单用户模型，2026-10-25 决策）：内网（WireGuard）即信任边界，
// 管理令牌已移除——worker/orchestrator/user 均可无门槛自助注册（外部主脑 A 会话、
// worker 设备都走这里）；"用户"身份由 PUT /api/user 单独维护。
export function registerAgent(ctx: Ctx, input: RegisterInput): { agent: Agent; token: string } {
  const role = input.role ?? 'worker';
  if (!['worker', 'orchestrator', 'user'].includes(role)) {
    throw new HttpError(422, `invalid role: ${role}`);
  }
  const handle = assertValidHandle(input.handle);
  assertNoMojibake(input.name, 'name');
  const models = normalizeModels(input.models ?? []);
  // host 归一：trim + 截断 64 字符；非空才过乱码校验（手动预创建的身份壳 host 为空串）
  const host = String(input.host ?? '').trim().slice(0, 64);
  if (host) assertNoMojibake(host, 'host');
  const specs = normalizeSpecs(input.specs);
  const id = (input.id ?? handle).trim();
  const token = 'ah_' + randomBytes(24).toString('base64url');
  try {
    withWrite(ctx, 'agent.register', () => {
      ctx.holder.db
        .prepare(
          'INSERT INTO agent (id, name, handle, role, token_hash, enabled, created_at, models, host, specs) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
        )
        .run(id, input.name, handle, role, hashToken(token), Date.now(), JSON.stringify(models), host, JSON.stringify(specs));
      logEvent(ctx, 'agent.registered', { agentId: id, handle, role, host, specs });
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new HttpError(409, `agent id or handle already exists: ${id}/${handle}`);
    }
    throw err;
  }
  return { agent: getAgent(ctx, id), token };
}

// ---- 系统内部注册（T14 内置主脑）----

// 内置主脑的固定 id / 句柄。'主脑' 在 RESERVED_HANDLES 里被保留给"当前主脑"概念
// （@主脑 定向投递映射到全部 orchestrator），系统 agent 本尊复用该句柄是唯一合法路径。
export const BRAIN_AGENT_ID = 'asterhive-brain';

// 仅供服务器进程自身调用（内置主脑身份）：绕过 RESERVED_HANDLES 与管理令牌校验。
// token 为随机占位且永不返回——主脑以进程内 actor 直调领域函数，不持有可用凭据；
// 即使库被拖走也无法用该哈希反推可用 token。事件台账记 brain.registered。
export function registerSystemAgent(
  ctx: Ctx,
  input: { id: string; name: string; handle: string; role: AgentRole },
): Agent {
  const token = 'ah_system_' + randomBytes(24).toString('base64url');
  try {
    withWrite(ctx, 'agent.registerSystem', () => {
      ctx.holder.db
        .prepare(
          'INSERT INTO agent (id, name, handle, role, token_hash, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        )
        .run(input.id, input.name, input.handle, input.role, hashToken(token), Date.now());
      logEvent(ctx, 'brain.registered', { agentId: input.id, handle: input.handle, role: input.role });
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      // 已注册过（幂等）：直接返回现有身份
      return getAgent(ctx, input.id);
    }
    throw err;
  }
  return getAgent(ctx, input.id);
}

// 取内置主脑身份；不存在则自动创建（首次启动主脑时）。返回值直接作为工具调用的 actor。
export function ensureBrainAgent(ctx: Ctx): Agent {
  const row = ctx.holder.db.prepare('SELECT * FROM agent WHERE id = ?').get(BRAIN_AGENT_ID) as
    | AgentRow
    | undefined;
  if (row) return rowToAgent(row);
  return registerSystemAgent(ctx, {
    id: BRAIN_AGENT_ID,
    name: '内置主脑',
    handle: '主脑',
    role: 'orchestrator',
  });
}

export function getAgent(ctx: Ctx, id: string): Agent {
  const row = ctx.holder.db.prepare('SELECT * FROM agent WHERE id = ?').get(id) as AgentRow | undefined;
  if (!row) throw new HttpError(404, `agent not found: ${id}`);
  return rowToAgent(row);
}

// 按 id 查找，不存在返回 null（与 getAgent 的 404 语义互补；单用户模块探测用）。
export function findAgent(ctx: Ctx, id: string): Agent | null {
  const row = ctx.holder.db.prepare('SELECT * FROM agent WHERE id = ?').get(id) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function listAgents(ctx: Ctx): Agent[] {
  const rows = ctx.holder.db.prepare('SELECT * FROM agent ORDER BY created_at').all() as AgentRow[];
  return rows.map(rowToAgent);
}

// 启停 agent（领域层只管落库与事件；HTTP 层用 requireElevated 做 user/orchestrator 角色闸门）。
export function setAgentEnabled(ctx: Ctx, id: string, enabled: boolean): Agent {
  getAgent(ctx, id); // 404 if missing
  withWrite(ctx, 'agent.setEnabled', () => {
    ctx.holder.db.prepare('UPDATE agent SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    logEvent(ctx, enabled ? 'agent.enabled' : 'agent.disabled', { agentId: id });
  });
  return getAgent(ctx, id);
}

// ---- Agent 档案：模型自报 + 用户侧设置 ----

// 自报/更新自己的模型清单。token 即身份（worker token 即可），天然只能改自己；
// 幂等覆盖语义——每次上报都是全量清单（设备主人改了本机可用模型就整包重发）。
export function reportAgentModels(ctx: Ctx, id: string, models: unknown): Agent {
  const list = normalizeModels(models);
  getAgent(ctx, id); // 404 if missing
  withWrite(ctx, 'agent.modelsReported', () => {
    ctx.holder.db.prepare('UPDATE agent SET models = ? WHERE id = ?').run(JSON.stringify(list), id);
    logEvent(ctx, 'agent.models_reported', { agentId: id, models: list });
  });
  return getAgent(ctx, id);
}

// 自报/更新设备能力规格（操作系统、架构、CPU、内存等）
export function reportAgentSpecs(ctx: Ctx, id: string, rawSpecs: unknown): Agent {
  const specs = normalizeSpecs(rawSpecs);
  getAgent(ctx, id); // 404 if missing
  withWrite(ctx, 'agent.specsReported', () => {
    ctx.holder.db.prepare('UPDATE agent SET specs = ? WHERE id = ?').run(JSON.stringify(specs), id);
    logEvent(ctx, 'agent.specs_reported', { agentId: id, specs });
  });
  return getAgent(ctx, id);
}

export interface AgentProfilePatch {
  name?: string;
  note?: string;
  /** 空串 = 清空首选（worker 回退本地配置） */
  preferredModel?: string;
}

// 改档案（显示名/备注/首选模型）：HTTP 层 requireElevated；id='user' 也允许（用户改自己的备注）。
// preferredModel 不校验是否在自报清单内——UI 下拉来自清单，但自由填写是明确需求（模型名先于人存在）。
export function updateAgentProfile(
  ctx: Ctx,
  id: string,
  patch: AgentProfilePatch,
): { agent: Agent; fields: string[] } {
  getAgent(ctx, id); // 404 if missing
  const fields: string[] = [];
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new HttpError(422, 'name cannot be empty');
    assertNoMojibake(name, 'name');
    sets.push('name = ?');
    vals.push(name);
    fields.push('name');
  }
  if (patch.note !== undefined) {
    assertNoMojibake(patch.note, 'note');
    sets.push('note = ?');
    vals.push(patch.note);
    fields.push('note');
  }
  if (patch.preferredModel !== undefined) {
    const pm = patch.preferredModel.trim();
    if (pm) assertNoMojibake(pm, 'preferredModel');
    sets.push('preferred_model = ?');
    vals.push(pm || null); // 空串清空 → NULL（语义：跟随本地配置）
    fields.push('preferredModel');
  }
  if (sets.length > 0) {
    withWrite(ctx, 'agent.profileUpdate', () => {
      ctx.holder.db
        .prepare(`UPDATE agent SET ${sets.join(', ')} WHERE id = ?`)
        .run(...vals, id);
      logEvent(ctx, 'agent.updated', { agentId: id, fields });
    });
  }
  return { agent: getAgent(ctx, id), fields };
}

// CLI worker 每轮取活前拉取：自己的自报清单 + 用户设置的首选模型（零令牌/任意 token 皆可查自己）。
export function getAgentProfile(ctx: Ctx, id: string): {
  agentId: string;
  models: string[];
  preferredModel: string | null;
} {
  const a = getAgent(ctx, id);
  return { agentId: a.id, models: a.models, preferredModel: a.preferredModel };
}

// 删除 ≠ 停用：真删行（用户决策 2026-10-25）。历史任务/消息中的 assignee/author 引用
// 会悬空、按原 id 显示——接受的取舍。单用户身份不可删（改用改名/重签发）。
export function deleteAgent(ctx: Ctx, id: string): void {
  if (id === 'user') {
    throw new HttpError(422, '单用户身份不可删除：可在设置页修改用户名');
  }
  const agent = getAgent(ctx, id); // 404 if missing
  withWrite(ctx, 'agent.delete', () => {
    ctx.holder.db.prepare('DELETE FROM agent WHERE id = ?').run(id);
    logEvent(ctx, 'agent.deleted', { agentId: id, handle: agent.handle, role: agent.role });
  });
}

// token → Agent；吊销（enabled=0）或不存在一律 null，不区分（避免枚举探测）。
export function authByToken(ctx: Ctx, token: string | null | undefined): Agent | null {
  if (!token) return null;
  const h = hashToken(token);
  const rows = ctx.holder.db
    .prepare('SELECT * FROM agent WHERE token_hash = ? AND enabled = 1')
    .all(h) as AgentRow[];
  if (rows.length === 0) return null;
  const row = rows[0];
  // 心跳属在线状态元数据，不进事件台账、不走快照管线（Hermes 纪律只约束结构化写）
  ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
  return rowToAgent(row);
}

export function heartbeat(ctx: Ctx, id: string): Agent {
  const agent = getAgent(ctx, id);
  ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  return rowToAgent(
    ctx.holder.db.prepare('SELECT * FROM agent WHERE id = ?').get(id) as AgentRow,
  );
}
