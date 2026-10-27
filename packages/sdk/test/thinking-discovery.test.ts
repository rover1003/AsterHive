import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverThinkingTiers } from '../src/thinking-discovery.ts';

test('does not treat default_reasoning_effort as the supported tier list', async () => {
  let calls = 0;
  const result = await discoverThinkingTiers({
    endpoint: 'https://api.x.ai/v1',
    model: 'grok-4.7',
    apiKey: 'secret',
    modelMetadata: {
      id: 'grok-4.7',
      capabilities: { default_reasoning_effort: 'high' },
    },
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'accepted_without_tier_evidence' });
  assert.equal(calls, 1);
});

test('rejects metadata from non-standard host ports and endpoint paths', async () => {
  for (const endpoint of ['https://api.x.ai:8443/v1', 'https://api.x.ai/proxy/v1']) {
    const result = await discoverThinkingTiers({
      endpoint,
      model: 'grok-4.7',
      apiKey: 'secret',
      modelMetadata: {
        id: 'grok-4.7',
        capabilities: { reasoning_effort: ['low', 'high'] },
      },
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    assert.deepEqual(result, { status: 'unknown', reason: 'accepted_without_tier_evidence' });
  }
});
test('matches the official DeepSeek root endpoint without requiring /v1', async () => {
  let calls = 0;
  const result = await discoverThinkingTiers({
    endpoint: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'secret',
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.deepEqual(result, { status: 'tiers', tiers: ['low', 'high', 'max'], source: 'official' });
  assert.equal(calls, 0);
});
