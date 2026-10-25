import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { withWrite, logEvent } from './write.ts';

// 主脑模型配置（§7 settings）：apiKey 加密存储（AES-256-GCM）。
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
// 3. env 从未设置过的部署不可能有旧密文（旧逻辑无密钥即拒绝保存 apiKey），无需迁移。
export interface OrchestratorSettings {
  provider?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string; // 写入加密；读取仅回掩码
  // T14：内置主脑总开关。默认 false（getOrchestratorSettings 对未存值兜底）。
  enabled?: boolean;
  // 唤醒过滤（T14 语义）：未设置视为 true；显式 false 关闭对应唤醒源。
  wakeOn?: { userMessage?: boolean; taskSubmitted?: boolean; blockedReport?: boolean; scheduleDigest?: boolean };
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

// 解析当前加密密钥；enc_secret 不存在则建立，并尽力迁移旧 env 密文（语义见文件头注释）。
// 只在"真的要加解密"时调用（保存 apiKey / 运行时解密），读侧投影不触发。
function resolveSecret(ctx: Ctx): string {
  const existing = readSetting(ctx, ENC_SECRET_KEY);
  if (existing) return existing;

  const env = process.env.ASTERHIVE_SECRET ?? null;
  const legacyCipher = (readOrchestratorRow(ctx) as { apiKeyCipher?: string } | null)?.apiKeyCipher ?? null;
  const fresh = randomBytes(32).toString('hex');

  withWrite(ctx, 'settings.encSecret', () => {
    if (readSetting(ctx, ENC_SECRET_KEY)) return; // 并发双检：第一个写入者获胜
    if (legacyCipher && env) {
      const plain = decrypt(legacyCipher, env);
      const stored = readOrchestratorRow(ctx) ?? {};
      if (plain !== null) {
        // 旧密文可解：以 enc_secret 重加密回写，一次性完成密钥迁移
        upsertSetting(ctx, 'orchestrator', JSON.stringify({ ...stored, apiKeyCipher: encrypt(plain, fresh) }));
        logEvent(ctx, 'settings.apiKey_migrated', {});
      } else {
        // 解不开：apiKey 置空（UI 提示重填），不让坏密文挡路
        const { apiKeyCipher: _drop, ...rest } = stored as { apiKeyCipher?: string };
        void _drop;
        upsertSetting(ctx, 'orchestrator', JSON.stringify(rest));
        logEvent(ctx, 'settings.apiKey_reset', {});
      }
    }
    upsertSetting(ctx, ENC_SECRET_KEY, fresh);
  });
  return readSetting(ctx, ENC_SECRET_KEY)!;
}

export function getOrchestratorSettings(ctx: Ctx): OrchestratorSettings & { apiKeySet: boolean } {
  const stored = readOrchestratorRow(ctx);
  if (!stored) return { enabled: false, apiKeySet: false };
  const { apiKeyCipher, ...rest } = stored as { apiKeyCipher?: string } & OrchestratorSettings;
  void apiKeyCipher;
  return {
    enabled: (rest as OrchestratorSettings).enabled ?? false, // 未存过开关 → 默认关
    ...(rest as OrchestratorSettings),
    apiKeySet: !!stored.apiKeyCipher,
  };
}

// 授权由 HTTP 层 requireElevated 闸门负责（user/orchestrator 角色可写），这里只管落库。
export function putOrchestratorSettings(
  ctx: Ctx,
  input: OrchestratorSettings,
): OrchestratorSettings & { apiKeySet: boolean } {
  const stored = readOrchestratorRow(ctx) ?? {};
  // 局部更新语义：HTTP 层会对所有键显式传 undefined，这里必须先剔除，
  // 否则 {...stored, ...input} 会把存量字段覆盖成 undefined 再被 JSON.stringify 丢弃
  // （曾致只改 model 的 PUT 把 enabled/provider/baseURL 全部清掉）
  const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const next: Record<string, unknown> = { ...stored, ...clean };
  const apiKey = clean.apiKey as string | undefined;
  if (apiKey !== undefined) {
    if (apiKey === '') {
      delete next.apiKeyCipher;
    } else {
      // 首次保存即建立 enc_secret（此后与 env 解耦）
      next.apiKeyCipher = encrypt(apiKey, resolveSecret(ctx));
    }
  }
  delete next.apiKey;
  withWrite(ctx, 'settings.put', () => {
    ctx.holder.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run('orchestrator', JSON.stringify(next), Date.now());
    logEvent(ctx, 'settings.orchestrator_updated', { fields: Object.keys(clean) });
  });
  return getOrchestratorSettings(ctx);
}

// ---- 主脑模型清单与连通测试（设置页下拉/检测按钮的数据源）----
// 上游账号池状态瞬息万变（曾出现配置的模型瞬时 503「No available accounts」），
// 与其让用户盲填模型名，不如把 /models 清单拉出来供选择 + 一键探测当前可用性。

const MODEL_LIST_TTL_MS = 60_000;
const modelListCache = new Map<string, { at: number; ids: string[] }>();

function trimBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '');
}

export interface OrchestratorModelsResult {
  models: string[];
  fetchedAt: number;
  cached: boolean;
}

export async function listOrchestratorModels(
  ctx: Ctx,
  fetchImpl: typeof fetch = fetch,
): Promise<OrchestratorModelsResult> {
  const s = getOrchestratorSettings(ctx);
  if (!s.baseURL) throw new HttpError(422, 'baseURL 未配置');
  const key = decryptApiKey(ctx);
  if (!key) throw new HttpError(422, 'apiKey 未配置');
  const hit = modelListCache.get(s.baseURL);
  if (hit && Date.now() - hit.at < MODEL_LIST_TTL_MS) {
    return { models: hit.ids, fetchedAt: hit.at, cached: true };
  }
  const res = await fetchImpl(`${trimBase(s.baseURL)}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new HttpError(502, `上游 /models 返回 ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
  const ids = (json.data ?? [])
    .map((x) => String(x.id ?? ''))
    .filter(Boolean)
    .sort();
  modelListCache.set(s.baseURL, { at: Date.now(), ids });
  return { models: ids, fetchedAt: Date.now(), cached: false };
}

export interface OrchestratorTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  error?: string;
}

export async function testOrchestratorModel(
  ctx: Ctx,
  model: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<OrchestratorTestResult> {
  const s = getOrchestratorSettings(ctx);
  const target = model ?? s.model;
  if (!s.baseURL || !target) throw new HttpError(422, 'baseURL/模型未配置');
  const key = decryptApiKey(ctx);
  if (!key) throw new HttpError(422, 'apiKey 未配置');
  const started = Date.now();
  try {
    const res = await fetchImpl(`${trimBase(s.baseURL)}/chat/completions`, {
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

// 运行时解密（内置主脑消费）。返回前可能触发 enc_secret 建立/旧密文迁移：
// 迁移判定不可解时密文已被置空（settings.apiKey_reset），此处重读后按未设置处理。
export function decryptApiKey(ctx: Ctx): string | null {
  const stored = readOrchestratorRow(ctx) as { apiKeyCipher?: string } | null;
  if (!stored?.apiKeyCipher) return null;
  const secret = resolveSecret(ctx);
  const after = readOrchestratorRow(ctx) as { apiKeyCipher?: string } | null;
  if (!after?.apiKeyCipher) return null;
  return decrypt(after.apiKeyCipher, secret);
}
