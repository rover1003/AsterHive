import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { withWrite, logEvent } from './write.ts';

// 主脑模型配置（§7 settings）：多模型组（2026-10-25「主脑多模型组」升级）。
//
// 存储形状（settings 表键 orchestrator，JSON）：
//   {
//     groups: [{ id, name, baseURL, model?, apiKeyCipher? }],  // 每组独立 apiKey 密文（AES-256-GCM）
//     activeGroupId: string,   // 激活组；组被删空时允许悬空（主脑未配置态）
//     enabled: boolean,        // 主脑总开关（组无关）
//     wakeOn?: { userMessage?/taskSubmitted?/blockedReport?/scheduleDigest? }
//   }
// 旧单配置形状（顶层 provider/baseURL/apiKeyCipher/model）由 loadOrchestrator 读到时
// 一次性迁移为 groups[0]（id 'default'，name = provider || '默认组'），事件 settings.groups_migrated。
//
// 加密密钥语义（2026-10-25 单用户模型升级，修遗留耦合）：
// 1. settings 表键 enc_secret 是工作密钥：首次需要加解密时随机生成 32 字节 hex 落库
//    （withWrite 事务内双检，并发下第一个写入者获胜）。一旦存在，加解密一律用它——
//    apiKey 从此与部署环境变量解耦，env 消失/轮换都不影响已存密文。
// 2. env ASTERHIVE_SECRET 只承担旧数据迁移：旧版本用 env（或管理令牌）派生密钥加密，
//    库中已有 apiKeyCipher 且 enc_secret 尚未建立时，若 env 仍设且能解开旧密文，
//    则以新 enc_secret 重加密回写，一次性完成迁移（事件 settings.apiKey_migrated）；
//    解不开（env 已轮换，或旧密文本就派生自已删除的管理令牌）则置空 apiKeyCipher 并记
//    事件 settings.apiKey_reset——UI 显示 apiKey 未设置，提示重填。尽力而为，不阻塞。
//    注意：旧密文可能在顶层（groups 迁移尚未发生）或已随组迁移进 groups[0]——两处都找，
//    并原位重加密/置空，保证 env 密钥迁移不因 groups 迁移先发生而失效。
// 3. env 从未设置过的部署不可能有旧密文（旧逻辑无密钥即拒绝保存 apiKey），无需迁移。

export interface OrchestratorWakeOn {
  userMessage?: boolean;
  taskSubmitted?: boolean;
  blockedReport?: boolean;
  scheduleDigest?: boolean;
}

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

function thinkingLevelOf(g: OrchestratorGroup): ThinkingLevel {
  return THINKING_LEVELS.includes(g.thinkingLevel as ThinkingLevel) ? (g.thinkingLevel as ThinkingLevel) : 'off';
}

function parseThinkingLevel(value: unknown): ThinkingLevel {
  if (typeof value !== 'string' || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new HttpError(422, `thinkingLevel 必须是以下之一：${THINKING_LEVELS.join(', ')}`);
  }
  return value as ThinkingLevel;
}

function parseThinkingLevelMap(value: unknown): ThinkingLevelMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(422, 'thinkingLevelMap 必须是 Pi 档位到上游标签的对象');
  }
  const map: ThinkingLevelMap = {};
  for (const [key, rawLabel] of Object.entries(value)) {
    if (!THINKING_LEVELS.includes(key as ThinkingLevel)) {
      throw new HttpError(422, `thinkingLevelMap 包含无效 Pi 档位: ${key}`);
    }
    if (rawLabel === null) {
      map[key as ThinkingLevel] = null;
      continue;
    }
    if (typeof rawLabel !== 'string' || !rawLabel.trim()) {
      throw new HttpError(422, `thinkingLevelMap.${key} 必须是非空上游标签或 null`);
    }
    map[key as ThinkingLevel] = rawLabel.trim();
  }
  return map;
}

// 新建组默认为 low；旧模型组无此字段时按旧行为 off 读取，不静默改变既有通道。
//
// 单个模型组（存储形态，含密文；密文永不离开服务端）
export interface OrchestratorGroup {
  id: string;
  name: string;
  baseURL: string;
  model?: string;
  apiKeyCipher?: string;
  thinkingLevel?: ThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
}

interface StoredOrchestrator {
  groups?: OrchestratorGroup[];
  activeGroupId?: string;
  reviewerGroupId?: string | null; // 独立审核员绑定的模型组 id（null 或空则跟随主脑 activeGroupId）
  reviewerModel?: string | null;   // 审核员用的具体模型（组内清单任选；null = 用组当前 model）
  reviewerEnabled?: boolean; // 默认关闭，启用后 managed 任务由内置 Pi Reviewer 自动验收
  enabled?: boolean;
  wakeOn?: OrchestratorWakeOn;
  // 旧单配置残留字段（迁移后不存在于存储）：provider / baseURL / model / apiKeyCipher
}

// 旧单配置形状（迁移输入）：顶层 provider/baseURL/model/apiKeyCipher
type LegacyOrchestrator = StoredOrchestrator & {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKeyCipher?: string;
};

// 读侧投影（永不含密文/明文；HTTP GET 的输出形态）
export interface OrchestratorGroupView {
  id: string;
  name: string;
  baseURL: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
  apiKeySet: boolean;
}

export interface OrchestratorSettingsView {
  enabled: boolean;
  wakeOn?: OrchestratorWakeOn;
  activeGroupId: string | null;   // 悬空（无组或指向已删组）→ null：主脑未配置态
  reviewerGroupId: string | null; // 独立审核员绑定的模型组 id（null = 跟随主脑激活组）
  reviewerModel?: string | null;  // 审核员用的具体模型（组内清单任选；null = 用组当前 model）
  reviewerEnabled: boolean;
  groups: OrchestratorGroupView[];
}

// 运行时消费形态（brain / models / test）：含解密后 apiKey 明文——仅内存传递，永不落库/回显
export interface ActiveOrchestratorGroup {
  id: string;
  name: string;
  baseURL: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
  apiKey: string | null; // 未设置或解不开 → null（主脑不启动轮次）
  apiKeySet: boolean;    // 密文在场（与解密是否成功无关，供 UI 展示）
  enabled: boolean;      // 主脑总开关随组一起给出，调用方少读一次
}

const ENC_SECRET_KEY = 'enc_secret';

type SettingsRow = { key: string; value: string };

function readSetting(ctx: Ctx, key: string): string | null {
  const row = ctx.holder.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | SettingsRow
    | undefined;
  return row?.value ?? null;
}

function upsertSetting(ctx: Ctx, key: string, value: string): void {
  ctx.holder.db
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, value, Date.now());
}

function encryptionKey(secret: string): Buffer {
  return scryptSync(secret, 'asterhive-settings-v1', 32);
}

function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(blob: string, secret: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = blob.split('.');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function readOrchestratorRow(ctx: Ctx): Record<string, unknown> | null {
  const row = ctx.holder.db.prepare('SELECT value FROM settings WHERE key = ?').get('orchestrator') as
    | SettingsRow
    | undefined;
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
}

function projectGroup(g: OrchestratorGroup): OrchestratorGroupView {
  return {
    id: g.id,
    name: g.name,
    baseURL: g.baseURL,
    ...(g.model !== undefined ? { model: g.model } : {}),
    thinkingLevel: thinkingLevelOf(g),
    ...(g.thinkingLevelMap ? { thinkingLevelMap: g.thinkingLevelMap } : {}),
    apiKeySet: !!g.apiKeyCipher,
  };
}

// 旧单配置是否携带可迁移的模型配置（仅 {enabled} 的行没有可入组的字段，不迁）
function hasLegacyConfig(stored: LegacyOrchestrator): boolean {
  return (
    stored.provider !== undefined ||
    stored.baseURL !== undefined ||
    stored.model !== undefined ||
    stored.apiKeyCipher !== undefined
  );
}

// 统一读取入口：旧单配置形状 → 一次性迁移为 groups[0]（id 'default'，name = provider || '默认组'）。
// 写回前判断 groups 字段不存在才迁（一次性）；仅 {enabled} 等无模型字段的行不迁（没有可入组内容）。
// 迁移在 withWrite 内落库并记事件 settings.groups_migrated。注意：本函数可能在无事务的读路径
// 触发写（与 resolveSecret 同款语义），所有调用点都必须不在 withWrite 事务内。
function loadOrchestrator(ctx: Ctx): StoredOrchestrator {
  const stored = readOrchestratorRow(ctx) as LegacyOrchestrator | null;
  if (!stored) return {};
  if (!Array.isArray(stored.groups) && hasLegacyConfig(stored)) {
    const legacy = stored;
    const group: OrchestratorGroup = {
      id: 'default',
      name: legacy.provider?.trim() || '默认组',
      baseURL: legacy.baseURL ?? '',
      ...(legacy.model !== undefined ? { model: legacy.model } : {}),
      ...(legacy.apiKeyCipher ? { apiKeyCipher: legacy.apiKeyCipher } : {}),
    };
    const migrated: StoredOrchestrator = {
      groups: [group],
      activeGroupId: 'default',
      ...(legacy.enabled !== undefined ? { enabled: legacy.enabled } : {}),
      ...(legacy.wakeOn ? { wakeOn: legacy.wakeOn } : {}),
    };
    withWrite(ctx, 'settings.groups_migrate', () => {
      upsertSetting(ctx, 'orchestrator', JSON.stringify(migrated));
      logEvent(ctx, 'settings.groups_migrated', { groupId: group.id, name: group.name });
    });
    return migrated;
  }
  return stored;
}

// 解析当前加密密钥；enc_secret 不存在则建立，并尽力迁移旧 env 密文（语义见文件头注释）。
// 只在"真的要加解密"时调用（保存 apiKey / 运行时解密），读侧投影不触发。
function resolveSecret(ctx: Ctx): string {
  const existing = readSetting(ctx, ENC_SECRET_KEY);
  if (existing) return existing;

  const env = process.env.ASTERHIVE_SECRET ?? null;
  // 旧密文位置：顶层（groups 迁移前）或组内（迁移后）——两处都找，env 密钥迁移不因组迁移先发生而失效
  const row = readOrchestratorRow(ctx) as LegacyOrchestrator | null;
  const topCipher =
    typeof row?.apiKeyCipher === 'string' && row.apiKeyCipher ? row.apiKeyCipher : null;
  const groupWithCipher =
    row?.groups?.find((g) => typeof g.apiKeyCipher === 'string' && g.apiKeyCipher) ?? null;
  const legacyCipher = topCipher ?? groupWithCipher?.apiKeyCipher ?? null;
  const fresh = randomBytes(32).toString('hex');

  withWrite(ctx, 'settings.encSecret', () => {
    if (readSetting(ctx, ENC_SECRET_KEY)) return; // 并发双检：第一个写入者获胜
    if (legacyCipher && env) {
      const plain = decrypt(legacyCipher, env);
      const stored = (readOrchestratorRow(ctx) as LegacyOrchestrator | null) ?? {};
      if (plain !== null) {
        // 旧密文可解：原位重加密回写（顶层留顶层、组内写回组内），一次性完成密钥迁移
        const next: LegacyOrchestrator = topCipher
          ? { ...stored, apiKeyCipher: encrypt(plain, fresh) }
          : {
              ...stored,
              groups: (stored.groups ?? []).map((g) =>
                g.id === groupWithCipher!.id ? { ...g, apiKeyCipher: encrypt(plain, fresh) } : g,
              ),
            };
        upsertSetting(ctx, 'orchestrator', JSON.stringify(next));
        logEvent(ctx, 'settings.apiKey_migrated', {});
      } else {
        // 解不开：原位置空（UI 提示重填），不让坏密文挡路
        const next: LegacyOrchestrator = topCipher
          ? (() => {
              const { apiKeyCipher: _drop, ...rest } = stored;
              void _drop;
              return rest;
            })()
          : {
              ...stored,
              groups: (stored.groups ?? []).map((g) =>
                g.id === groupWithCipher!.id ? { ...g, apiKeyCipher: undefined } : g,
              ),
            };
        upsertSetting(ctx, 'orchestrator', JSON.stringify(next));
        logEvent(ctx, 'settings.apiKey_reset', {});
      }
    }
    upsertSetting(ctx, ENC_SECRET_KEY, fresh);
  });
  return readSetting(ctx, ENC_SECRET_KEY)!;
}

// ---- 读侧投影（GET /settings/orchestrator；brain 的 enabled/wakeOn 也从这里读）----

export function getOrchestratorSettings(ctx: Ctx): OrchestratorSettingsView {
  const st = loadOrchestrator(ctx);
  const groups = st.groups ?? [];
  const active = groups.find((g) => g.id === st.activeGroupId);
  const reviewer = st.reviewerGroupId ? groups.find((g) => g.id === st.reviewerGroupId) : null;
  return {
    enabled: st.enabled ?? false, // 未存过开关 → 默认关
    ...(st.wakeOn ? { wakeOn: st.wakeOn } : {}),
    activeGroupId: active ? active.id : null,
    reviewerGroupId: reviewer ? reviewer.id : null,
    reviewerModel: reviewer ? (st.reviewerModel ?? null) : null, // 悬空组不回显模型
    reviewerEnabled: st.reviewerEnabled ?? false,
    groups: groups.map(projectGroup),
  };
}

// 激活组（运行时消费入口）：brain 与 models/test 接口一律从这里取通道配置，
// 替代散落的顶层字段读取。无组或 activeGroupId 悬空 → null（主脑未配置态）。
export function activeGroup(ctx: Ctx): ActiveOrchestratorGroup | null {
  const st = loadOrchestrator(ctx);
  const g = st.groups?.find((x) => x.id === st.activeGroupId);
  if (!g) return null;
  return {
    id: g.id,
    name: g.name,
    baseURL: g.baseURL,
    ...(g.model !== undefined ? { model: g.model } : {}),
    thinkingLevel: thinkingLevelOf(g),
    ...(g.thinkingLevelMap ? { thinkingLevelMap: g.thinkingLevelMap } : {}),
    apiKeySet: !!g.apiKeyCipher,
    apiKey: g.apiKeyCipher ? decryptGroupApiKey(ctx, g.id) : null,
    enabled: st.enabled ?? false,
  };

}
// 独立审核员（Reviewer Profile）运行时消费入口：
// 若 reviewerGroupId 有值且找到有效组，则使用该组；否则自动回退到主脑激活组（activeGroup）。
// 组内模型优先取 reviewerModel（审核员在组清单里任选），未设则用组当前 model。
export function reviewerGroup(ctx: Ctx): ActiveOrchestratorGroup | null {
  const st = loadOrchestrator(ctx);
  const g = st.reviewerGroupId ? st.groups?.find((x) => x.id === st.reviewerGroupId) : null;
  if (g) {
    const model = st.reviewerModel ?? g.model;
    return {
      id: g.id,
      name: g.name,
      baseURL: g.baseURL,
      ...(model !== undefined ? { model } : {}),
      thinkingLevel: thinkingLevelOf(g),
      ...(model === g.model && g.thinkingLevelMap ? { thinkingLevelMap: g.thinkingLevelMap } : {}),
      apiKeySet: !!g.apiKeyCipher,
      apiKey: g.apiKeyCipher ? decryptGroupApiKey(ctx, g.id) : null,
      enabled: st.enabled ?? false,
    };
  }
  return activeGroup(ctx);
}
export function getThinkingProbeTarget(ctx: Ctx, groupId: string): { endpoint: string; model: string; apiKey: string } {
  const st = loadOrchestrator(ctx);
  const group = st.groups?.find((item) => item.id === groupId);
  if (!group) throw new HttpError(404, `模型组不存在: ${groupId}`);
  if (!group.model) throw new HttpError(422, '请先为模型组选择模型，再探测思考等级');
  const apiKey = decryptGroupApiKey(ctx, group.id);
  if (!apiKey) throw new HttpError(422, '模型组 API Key 未设置或无法解密');
  return { endpoint: group.baseURL, model: group.model, apiKey };
}


// 运行时解密指定组的 apiKey（groupId 缺省 = 激活组）。返回前可能触发 enc_secret 建立/
// 旧 env 密文迁移：迁移判定不可解时密文已被置空（settings.apiKey_reset），重读后按未设置处理。
export function decryptGroupApiKey(ctx: Ctx, groupId?: string): string | null {
  const st = loadOrchestrator(ctx);
  const gid = groupId ?? st.activeGroupId;
  const g = st.groups?.find((x) => x.id === gid);
  if (!g?.apiKeyCipher) return null;
  const secret = resolveSecret(ctx);
  // resolveSecret 可能原位重加密/置空旧密文：重读后再解
  const after = loadOrchestrator(ctx);
  const g2 = after.groups?.find((x) => x.id === g.id);
  if (!g2?.apiKeyCipher) return null;
  return decrypt(g2.apiKeyCipher, secret);
}

// ---- 全局开关（PUT /settings/orchestrator 只管 enabled/wakeOn；模型组字段一律走组接口）----

// 授权由 HTTP 层 requireElevated 闸门负责（user/orchestrator 角色可写），这里只管落库。
export function putOrchestratorSettings(
  ctx: Ctx,
  input: { enabled?: boolean; wakeOn?: OrchestratorWakeOn; reviewerGroupId?: string | null; reviewerModel?: string | null; reviewerEnabled?: boolean },
): OrchestratorSettingsView {
  const stored = loadOrchestrator(ctx);
  if (input.reviewerGroupId && !stored.groups?.some((g) => g.id === input.reviewerGroupId)) {
    throw new HttpError(404, `审核员模型组不存在: ${input.reviewerGroupId}`);
  }
  // reviewerModel 必须归属 reviewerGroupId 指向的组（跨组绑定一律拒绝——Key 与模型必须同源）
  if (input.reviewerModel) {
    const targetId = input.reviewerGroupId === undefined ? stored.reviewerGroupId : input.reviewerGroupId;
    if (!targetId) throw new HttpError(422, '审核模型需要先选择模型组（reviewerGroupId）');
    if (!stored.groups?.some((g) => g.id === targetId)) throw new HttpError(404, `审核员模型组不存在: ${targetId}`);
  }
  const reviewerEnabled = input.reviewerEnabled ?? stored.reviewerEnabled ?? false;
  if (reviewerEnabled) {
    const selectedId = input.reviewerGroupId === undefined ? stored.reviewerGroupId : input.reviewerGroupId;
    const group = (stored.groups ?? []).find((g) => g.id === (selectedId || stored.activeGroupId));
    const reviewerModel = input.reviewerModel === undefined ? stored.reviewerModel : input.reviewerModel;
    if (!group?.baseURL || !(reviewerModel || group.model) || !group.apiKeyCipher || !decryptGroupApiKey(ctx, group.id)) {
      throw new HttpError(422, '启用独立审核员前，请配置完整的审核模型组（Base URL、模型和有效 API Key）。');
    }
  }
  const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const fields = Object.keys(clean).filter((key) => {
    const previous = (stored as Record<string, unknown>)[key];
    const nextValue = clean[key];
    if (key === 'enabled' || key === 'reviewerEnabled') return Boolean(previous) !== Boolean(nextValue);
    if (key === 'reviewerGroupId' || key === 'reviewerModel') return (previous ?? null) !== (nextValue ?? null);
    return JSON.stringify(previous) !== JSON.stringify(nextValue);
  });
  if (fields.length === 0) return getOrchestratorSettings(ctx);
  const next: Record<string, unknown> = { ...stored, ...clean };
  withWrite(ctx, 'settings.put', () => {
    upsertSetting(ctx, 'orchestrator', JSON.stringify(next));
    if (stored.reviewerEnabled === true && input.reviewerEnabled === false) {
      const reset = ctx.holder.db.prepare("UPDATE task SET review_status='none', updated_at=? WHERE lane='Review' AND review_status IN ('pending','reviewing','failed')").run(Date.now());
      if (Number(reset.changes) > 0) logEvent(ctx, 'task.review_disabled', { count: Number(reset.changes) });
    }
    logEvent(ctx, 'settings.orchestrator_updated', { fields });
  });
  return getOrchestratorSettings(ctx);
}

// ---- 模型组 CRUD（每组独立 name/baseURL/apiKey/model）----

function newGroupId(existing: OrchestratorGroup[]): string {
  for (;;) {
    const id = `g${randomBytes(4).toString('hex')}`; // 随机短码，撞码重试
    if (!existing.some((g) => g.id === id)) return id;
  }
}

// 创建模型组。groups 为空（主脑未配置态）时自动激活为首组，避免 activeGroupId 悬空多一次点击；
// 自动激活即主脑可用配置变化 → 必发 settings.orchestrator_updated（brain 侧 disposeSession 闭环）。
export function createOrchestratorGroup(
  ctx: Ctx,
  input: { name?: string; baseURL?: string; apiKey?: string; model?: string; thinkingLevel?: unknown; thinkingLevelMap?: unknown },
): OrchestratorGroupView {
  const name = input.name?.trim();
  const baseURL = input.baseURL?.trim();
  if (!name) throw new HttpError(422, '模型组名称必填');
  if (!baseURL) throw new HttpError(422, 'Base URL 必填');
  const st = loadOrchestrator(ctx);
  const groups = st.groups ?? [];
  const group: OrchestratorGroup = {
    id: newGroupId(groups),
    name,
    baseURL,
    thinkingLevel: input.thinkingLevel === undefined ? 'low' : parseThinkingLevel(input.thinkingLevel),
  };
  const model = input.model?.trim();
  if (model) group.model = model;
  if (input.thinkingLevelMap !== undefined) group.thinkingLevelMap = parseThinkingLevelMap(input.thinkingLevelMap);
  if (input.apiKey) group.apiKeyCipher = encrypt(input.apiKey, resolveSecret(ctx)); // 首个 KEY 即建立 enc_secret
  const autoActivate = groups.length === 0;
  const next: StoredOrchestrator = {
    ...st,
    groups: [...groups, group],
    ...(autoActivate ? { activeGroupId: group.id } : {}),
  };
  withWrite(ctx, 'settings.groupCreate', () => {
    upsertSetting(ctx, 'orchestrator', JSON.stringify(next));
    logEvent(
      ctx,
      autoActivate ? 'settings.orchestrator_updated' : 'settings.group_created',
      autoActivate
        ? { groupId: group.id, fields: ['groups', 'activeGroupId'] }
        : { groupId: group.id },
    );
  });
  return projectGroup(group);
}

// 局部更新（undefined 键不覆盖——沿用修过的坑；apiKey 缺省/空串 = 保留原 KEY，UI 永不回显）。
// 仅激活组被改才影响主脑运行配置 → 必发 settings.orchestrator_updated 触发既有 disposeSession
// 闭环；非激活组改动不影响任何轮次，只记审计事件。
export function updateOrchestratorGroup(
  ctx: Ctx,
  id: string,
  input: { name?: string; baseURL?: string; apiKey?: string; model?: string; thinkingLevel?: unknown; thinkingLevelMap?: unknown },
): OrchestratorGroupView {
  const st = loadOrchestrator(ctx);
  const groups = st.groups ?? [];
  const idx = groups.findIndex((g) => g.id === id);
  if (idx < 0) throw new HttpError(404, `模型组不存在: ${id}`);
  const g: OrchestratorGroup = { ...groups[idx] };
  const changed: string[] = [];
  if (input.name !== undefined) {
    const v = input.name.trim();
    if (!v) throw new HttpError(422, '模型组名称不能为空');
    if (v !== g.name) {
      g.name = v;
      changed.push('name');
    }
  }
  if (input.baseURL !== undefined) {
    const v = input.baseURL.trim();
    if (!v) throw new HttpError(422, 'Base URL 不能为空');
    if (v !== g.baseURL) {
      g.baseURL = v;
      changed.push('baseURL');
    }
  }
  if (input.model !== undefined) {
    const v = input.model.trim();
    if (v) {
      if (v !== g.model) {
        g.model = v;
        changed.push('model');
      }
    } else if (g.model !== undefined) {
      delete g.model; // 显式空串 = 清除模型
      changed.push('model');
    }
  }
  if ((changed.includes('model') || changed.includes('baseURL')) && input.thinkingLevelMap === undefined && g.thinkingLevelMap !== undefined) {
    delete g.thinkingLevelMap;
    changed.push('thinkingLevelMap');
  }
  if (input.thinkingLevel !== undefined) {
    const level = parseThinkingLevel(input.thinkingLevel);
    if (level !== thinkingLevelOf(g)) {
      g.thinkingLevel = level;
      changed.push('thinkingLevel');
    }
  }
  if (input.thinkingLevelMap !== undefined) {
    const map = parseThinkingLevelMap(input.thinkingLevelMap);
    const normalized = Object.keys(map).length ? map : undefined;
    if (JSON.stringify(normalized ?? {}) !== JSON.stringify(g.thinkingLevelMap ?? {})) {
      if (normalized) g.thinkingLevelMap = normalized;
      else delete g.thinkingLevelMap;
      changed.push('thinkingLevelMap');
    }
  }
  if (input.apiKey) {
    g.apiKeyCipher = encrypt(input.apiKey, resolveSecret(ctx));
    changed.push('apiKey');
  }
  if (changed.length === 0) return projectGroup(groups[idx]); // 无实际变化：不动库不发事件
  const nextGroups = [...groups];
  nextGroups[idx] = g;
  const affectsReviewer = st.reviewerEnabled === true && (st.reviewerGroupId === id || (!st.reviewerGroupId && st.activeGroupId === id));
  withWrite(ctx, 'settings.groupUpdate', () => {
    upsertSetting(ctx, 'orchestrator', JSON.stringify({ ...st, groups: nextGroups }));
    if (st.activeGroupId === id || affectsReviewer) {
      logEvent(ctx, 'settings.orchestrator_updated', { fields: changed, groupId: id });
    } else {
      logEvent(ctx, 'settings.group_updated', { fields: changed, groupId: id });
    }
  });
  return projectGroup(g);
}

// 删除模型组：还有其他组时激活组 422（先启用其他组）；删的是最后一组则允许——
// 删空 = 主脑未配置态（否则"清空重配"在 API 层无路可走）。
export function deleteOrchestratorGroup(ctx: Ctx, id: string): void {
  const st = loadOrchestrator(ctx);
  const groups = st.groups ?? [];
  if (!groups.some((g) => g.id === id)) throw new HttpError(404, `模型组不存在: ${id}`);
  const wasActive = st.activeGroupId === id;
  const wasReviewer = st.reviewerEnabled === true && (st.reviewerGroupId === id || (!st.reviewerGroupId && wasActive));
  if (wasActive && groups.length > 1) {
    throw new HttpError(422, '不能删除当前使用的模型组——请先启用其他组');
  }
  withWrite(ctx, 'settings.groupDelete', () => {
    upsertSetting(
      ctx,
      'orchestrator',
      JSON.stringify({
        ...st,
        groups: groups.filter((g) => g.id !== id),
        ...(wasReviewer ? { reviewerGroupId: null, reviewerModel: null, reviewerEnabled: false } : {}),
      }),
    );
    if (wasActive || wasReviewer) {
      // 主脑与 Reviewer 均从模型组读配置；通道变更/删除后尽快丢弃旧会话并重新检查队列。
      logEvent(ctx, 'settings.orchestrator_updated', { fields: ['groups', ...(wasReviewer ? ['reviewerEnabled', 'reviewerGroupId'] : [])], groupId: id });
    } else {
      logEvent(ctx, 'settings.group_deleted', { groupId: id });
    }
  });
}

// 切换激活组：组不存在 404。切换必发 settings.orchestrator_updated → brain 既有
// settings.orchestrator_updated 处理分支（#onEvent）会 #disposeSession + markDirty——
// Pi 会话创建时绑定 provider/model，不弃会话则切换后旧会话仍走旧通道
// （真实事故：上游账号池瞬时 503，用户切换模型后主脑仍报错）。同组重复切换为幂等空操作。
export function switchOrchestratorGroup(ctx: Ctx, groupId: string): OrchestratorSettingsView {
  const st = loadOrchestrator(ctx);
  if (!st.groups?.some((g) => g.id === groupId)) throw new HttpError(404, `模型组不存在: ${groupId}`);
  if (st.activeGroupId === groupId) return getOrchestratorSettings(ctx); // 未变化不发事件，避免无谓的会话重建轮次
  withWrite(ctx, 'settings.groupActivate', () => {
    upsertSetting(ctx, 'orchestrator', JSON.stringify({ ...st, activeGroupId: groupId }));
    logEvent(ctx, 'settings.orchestrator_updated', { fields: ['activeGroupId'], groupId });
  });
  return getOrchestratorSettings(ctx);
}

// ---- 主脑模型清单与连通测试（设置页下拉/检测按钮的数据源，按组路由）----
// 上游账号池状态瞬息万变（曾出现配置的模型瞬时 503「No available accounts」），
// 与其让用户盲填模型名，不如把 /models 清单拉出来供选择 + 一键探测当前可用性。

const MODEL_LIST_TTL_MS = 60_000;

const modelListCache = new Map<string, { at: number; ids: string[] }>();
const modelMetadataCache = new Map<string, { at: number; byId: Map<string, unknown> }>();

function metadataCacheKey(baseURL: string, apiKey: string): string {
  return createHash('sha256').update(baseURL).update('\0').update(apiKey).digest('hex');
}

function trimBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '');
}

// 组解析：groupId 缺省 = 激活组；组不存在 404，无组可选 422（与组接口同一语义）
function resolveTargetGroup(ctx: Ctx, groupId?: string): OrchestratorGroup {
  const st = loadOrchestrator(ctx);
  const g = st.groups?.find((x) => x.id === (groupId ?? st.activeGroupId));
  if (!g) {
    throw new HttpError(groupId ? 404 : 422, groupId ? `模型组不存在: ${groupId}` : '未配置任何模型组');
  }
  return g;
}

function reasoningMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== 'string' || !source.id) return undefined;
  const metadata: Record<string, unknown> = { id: source.id };
  const sourceCapabilities = source.capabilities;
  if (sourceCapabilities && typeof sourceCapabilities === 'object' && !Array.isArray(sourceCapabilities)) {
    const capabilities = sourceCapabilities as Record<string, unknown>;
    const selected: Record<string, unknown> = {};
    if (Array.isArray(capabilities.reasoning_effort)) selected.reasoning_effort = capabilities.reasoning_effort;
    if (typeof capabilities.default_reasoning_effort === 'string') {
      selected.default_reasoning_effort = capabilities.default_reasoning_effort;
    }
    if (Object.keys(selected).length) metadata.capabilities = selected;
  }
  const sourceEffort = source.effort;
  if (sourceEffort && typeof sourceEffort === 'object' && !Array.isArray(sourceEffort)) {
    const supportedLevels = (sourceEffort as Record<string, unknown>).supported_levels;
    if (Array.isArray(supportedLevels)) metadata.effort = { supported_levels: supportedLevels };
  }
  return Object.keys(metadata).length > 1 ? metadata : undefined;
}

export interface OrchestratorModelsResult {
  models: string[];
  fetchedAt: number;
  cached: boolean;
}

export async function listOrchestratorModels(
  ctx: Ctx,
  opts: { groupId?: string; force?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<OrchestratorModelsResult> {
  const g = resolveTargetGroup(ctx, opts.groupId);
  if (!g.baseURL) throw new HttpError(422, 'baseURL 未配置');
  const key = decryptGroupApiKey(ctx, g.id);
  if (!key) throw new HttpError(422, 'apiKey 未配置');
  // 缓存键 = baseURL：同端点的组共享一份清单（/models 与具体 KEY 无关的场景占绝大多数）；
  // force = 手动刷新按钮，绕过 60s 缓存强制重拉
  const hit = modelListCache.get(g.baseURL);
  if (!opts.force && hit && Date.now() - hit.at < MODEL_LIST_TTL_MS) {
    return { models: hit.ids, fetchedAt: hit.at, cached: true };
  }
  const res = await fetchImpl(`${trimBase(g.baseURL)}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(502, `上游 /models 返回 ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
  const records = json.data ?? [];
  const metadataById = new Map<string, unknown>();
  for (const record of records) {
    const metadata = reasoningMetadataRecord(record);
    if (typeof metadata?.id === 'string') metadataById.set(metadata.id, metadata);
  }
  const ids = records.map((record) => String(record.id ?? '')).filter(Boolean).sort();
  const fetchedAt = Date.now();
  modelListCache.set(g.baseURL, { at: fetchedAt, ids });
  for (const [cacheKey, entry] of modelMetadataCache) {
    if (fetchedAt - entry.at >= MODEL_LIST_TTL_MS) modelMetadataCache.delete(cacheKey);
  }
  modelMetadataCache.set(metadataCacheKey(g.baseURL, key), { at: fetchedAt, byId: metadataById });
  return { models: ids, fetchedAt, cached: false };
}

export function getCachedOrchestratorModelMetadata(ctx: Ctx, groupId: string, model: string): unknown | undefined {
  const group = resolveTargetGroup(ctx, groupId);
  const apiKey = decryptGroupApiKey(ctx, group.id);
  if (!apiKey) return undefined;
  const cached = modelMetadataCache.get(metadataCacheKey(group.baseURL, apiKey));
  if (!cached || Date.now() - cached.at >= MODEL_LIST_TTL_MS) return undefined;
  const metadata = cached.byId.get(model);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  return (metadata as Record<string, unknown>).id === model ? metadata : undefined;
}

export interface OrchestratorTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
}

export async function testOrchestratorModel(
  ctx: Ctx,
  opts: { groupId?: string; model?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<OrchestratorTestResult> {
  const g = resolveTargetGroup(ctx, opts.groupId);
  const target = opts.model ?? g.model;
  if (!g.baseURL || !target) throw new HttpError(422, 'baseURL/模型未配置');
  const key = decryptGroupApiKey(ctx, g.id);
  if (!key) throw new HttpError(422, 'apiKey 未配置');
  const started = Date.now();
  try {
    const res = await fetchImpl(`${trimBase(g.baseURL)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: target, max_tokens: 16, messages: [{ role: 'user', content: '回复：ok' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - started;
    if (res.ok) return { ok: true, status: res.status, latencyMs };
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown } };
    return {
      ok: false,
      status: res.status,
      latencyMs,
      error: String(body.error?.message ?? res.statusText).slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}
