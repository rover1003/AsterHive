import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverWorkerThinkingTiers } from '../src/thinking-discovery.ts';

test('worker discovers tiers from local model metadata without sending credentials to Hive', async () => {
  const calls: { url: string; authorization?: string }[] = [];
  const result = await discoverWorkerThinkingTiers({
    baseURL: 'https://api.x.ai/v1', model: 'grok-4', apiKey: 'local-secret',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') ?? undefined });
      if (String(input) === 'https://api.x.ai/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'grok-4', capabilities: { reasoning_effort: ['low', 'high'] } }] }), { status: 200 });
      }
      throw new Error('metadata should avoid probing');
    },
  });
  assert.deepEqual(result, { status: 'tiers', tiers: ['low', 'high'], source: 'metadata' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/models');
  assert.equal(calls[0].authorization, 'Bearer local-secret');
});

test('worker returns unknown when upstream accepts an ordinary request without tier evidence', async () => {
  const result = await discoverWorkerThinkingTiers({
    baseURL: 'https://models.example/v1', model: 'unknown-model', apiKey: 'local-secret',
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'unknown-model' }] }), { status: 200 }),
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'accepted_without_tier_evidence' });
});
