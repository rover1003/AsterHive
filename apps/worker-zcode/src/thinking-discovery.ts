import { discoverThinkingTiers, type ThinkingTierDiscovery } from '../../../packages/sdk/src/thinking-discovery.ts';

export interface WorkerThinkingDiscoveryInput {
  baseURL: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Query model metadata locally, then allow the shared helper one bounded explicit-evidence probe. */
export async function discoverWorkerThinkingTiers(
  input: WorkerThinkingDiscoveryInput,
): Promise<ThinkingTierDiscovery> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let modelMetadata: unknown;
  try {
    const base = new URL(input.baseURL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      return { status: 'unknown', reason: 'probe_failed' };
    }
    const modelsUrl = `${base.toString().replace(/\/+$/u, '')}/models`;
    const response = await fetchImpl(modelsUrl, {
      headers: { authorization: `Bearer ${input.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const records = (data as { data?: unknown }).data;
        if (Array.isArray(records)) modelMetadata = records.find((entry) =>
          entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as { id?: unknown }).id === input.model,
        );
      }
    }
  } catch {
    // Discovery remains best-effort; the shared helper may still classify a direct bounded probe.
  }
  return discoverThinkingTiers({
    endpoint: input.baseURL,
    model: input.model,

    apiKey: input.apiKey,
    fetchImpl,
    modelMetadata,
  });
}

if (process.argv[2] === '--discover') {
  const [, , , baseURL, model] = process.argv;
  const apiKey = process.env.WORKER_PI_API_KEY;
  if (!baseURL || !model || !apiKey) {
    console.error('Missing discovery arguments or WORKER_PI_API_KEY.');
    process.exitCode = 2;
  } else {
    const result = await discoverWorkerThinkingTiers({ baseURL, model, apiKey });
    console.log(JSON.stringify(result));
  }
}
