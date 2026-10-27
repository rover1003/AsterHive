export type ThinkingTierDiscovery =
  | { status: 'tiers'; tiers: string[]; source: 'official' | 'rejection' | 'metadata' }
  | { status: 'unknown'; reason: 'accepted_without_tier_evidence' | 'no_tier_evidence' | 'probe_failed' };

export interface ThinkingTierProbeInput {
  /** Caller must pass a baseURL from a server-side configured model group. */
  endpoint: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Exact model record returned by this endpoint's /models response. */
  modelMetadata?: unknown;
}

const PROBE_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 16_384;
const VALID_TIER = /^[a-z][a-z0-9_-]{0,31}$/i;

function tiersFromMetadata(value: unknown, model: string, url: URL): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = url.pathname.replace(/\/+$/, '');
  const officialPath = url.hostname === 'api.deepseek.com' ? path === '' || path === '/v1' : path === '/v1';
  if (record.id !== model || url.protocol !== 'https:' || url.port !== '' || !officialPath ||
    (url.hostname !== 'api.x.ai' && url.hostname !== 'api.deepseek.com')) return undefined;
  const capabilities = record.capabilities;
  if (capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)) {
    const effort = (capabilities as Record<string, unknown>).reasoning_effort;
    if (Array.isArray(effort)) {
      const tiers = cleanTiers(effort);
      if (tiers.length) return tiers;
    }
  }
  const effort = record.effort;
  if (effort && typeof effort === 'object' && !Array.isArray(effort)) {
    const supported = (effort as Record<string, unknown>).supported_levels;
    if (Array.isArray(supported)) {
      const tiers = cleanTiers(supported);
      if (tiers.length) return tiers;
    }
  }
  return undefined;
}

function cleanTiers(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const tier = value.trim();
    if (VALID_TIER.test(tier) && !result.includes(tier)) result.push(tier);
  }
  return result;
}
/**
 * Static matches are intentionally limited to exact official API hosts and model IDs.
 * DeepSeek: https://api-docs.deepseek.com/guides/thinking_mode/
 * Moonshot: https://platform.kimi.ai/docs/guide/use-reasoning-effort
 * xAI publishes model-specific tiers in /models capabilities; see
 * https://docs.x.ai/developers/model-capabilities/text/reasoning
 */
function officialModelTiers(url: URL, model: string): string[] | undefined {
  const path = url.pathname.replace(/\/+$/, '');
  const officialPath = url.hostname === 'api.deepseek.com' ? path === '' || path === '/v1' : path === '/v1';
  if (url.protocol !== 'https:' || url.port !== '' || !officialPath) return undefined;
  if (url.hostname === 'api.deepseek.com' && (model === 'deepseek-flash' || model === 'deepseek-v4-pro')) {
    return ['low', 'high', 'max'];
  }
  if (url.hostname === 'api.moonshot.ai' && model === 'kimi-k3.1-pro') {
    return ['low', 'high', 'max'];
  }
  return undefined;
}


function tiersFromRejection(message: string): string[] | undefined {
  const match = message.match(/(?:请使用|(?:must\s+be\s+one\s+of|one\s+of\s+the\s+following|allowed\s+values?\s*[:=]|valid\s+(?:values?|options?)\s*[:=]))\s*([^\n.;。；]+)/i);
  if (!match) return undefined;
  const tiers = cleanTiers(match[1].split(/\s*(?:,|，|、|\/|\bor\b|或)\s*/i).map((item) => item.replace(/^[:：\s]+/, '').replace(/^['"`]|['"`]$/g, '').trim()));
  return tiers.length ? tiers : undefined;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, MAX_RESPONSE_BYTES - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength !== value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function responseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nestedError = record.error;
  if (nestedError && typeof nestedError === 'object' && !Array.isArray(nestedError)) {
    const message = (nestedError as Record<string, unknown>).message;
    if (typeof message === 'string') return message.slice(0, MAX_RESPONSE_BYTES);
  }
  return typeof record.message === 'string' ? record.message.slice(0, MAX_RESPONSE_BYTES) : undefined;
}


/** Probe exactly one minimal chat request; acceptance is not evidence that reasoning works. */
export async function discoverThinkingTiers(input: ThinkingTierProbeInput): Promise<ThinkingTierDiscovery> {
  let base: URL;
  try { base = new URL(input.endpoint); } catch { return { status: 'unknown', reason: 'probe_failed' }; }
  const metadataTiers = tiersFromMetadata(input.modelMetadata, input.model, base);
  if (metadataTiers) return { status: 'tiers', tiers: metadataTiers, source: 'metadata' };
  const officialTiers = officialModelTiers(base, input.model);
  if (officialTiers) return { status: 'tiers', tiers: officialTiers, source: 'official' };
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    return { status: 'unknown', reason: 'probe_failed' };
  }
  try {
    const endpoint = `${base.toString().replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await (input.fetchImpl ?? fetch)(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 }),
        signal: controller.signal,
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { status: 'unknown', reason: 'accepted_without_tier_evidence' };
      }
      const text = await boundedText(response);
      let message: string | undefined;
      try { message = responseErrorMessage(JSON.parse(text)); } catch { /* Ignore non-JSON error details. */ }
      const tiers = message ? tiersFromRejection(message) : undefined;
      return tiers ? { status: 'tiers', tiers, source: 'rejection' } : { status: 'unknown', reason: 'no_tier_evidence' };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { status: 'unknown', reason: 'probe_failed' };
  }
}
