import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverThinkingTiers } from '../../../packages/sdk/src/thinking-discovery.ts';

test('reads xAI reasoning tiers only from the exact model metadata record', async () => {
  let calls = 0;
  const result = await discoverThinkingTiers({
    endpoint: 'https://api.x.ai/v1', model: 'grok-4', apiKey: 'secret',
    modelMetadata: { id: 'grok-4', capabilities: { reasoning_effort: ['low', 'high'], default_reasoning_effort: 'low' } },
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.deepEqual(result, { status: 'tiers', tiers: ['low', 'high'], source: 'metadata' });
  assert.equal(calls, 0);
});

test('reads DeepSeek supported levels from the exact model metadata record', async () => {
  let calls = 0;
  const result = await discoverThinkingTiers({
    endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'secret',
    modelMetadata: { id: 'deepseek-flash', effort: { supported_levels: ['low', 'medium', 'high'] } },
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.deepEqual(result, { status: 'tiers', tiers: ['low', 'medium', 'high'], source: 'metadata' });
  assert.equal(calls, 0);
});
test('matches only documented exact DeepSeek and Moonshot host/model pairs', async () => {
  for (const [endpoint, model] of [
    ['https://api.deepseek.com/v1', 'deepseek-flash'],
    ['https://api.deepseek.com/v1', 'deepseek-v4-pro'],
    ['https://api.moonshot.ai/v1', 'kimi-k3.1-pro'],
  ]) {
    let calls = 0;
    const result = await discoverThinkingTiers({
      endpoint, model, apiKey: 'secret',
      fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
    });
    assert.deepEqual(result, { status: 'tiers', tiers: ['low', 'high', 'max'], source: 'official' });
    assert.equal(calls, 0);
  }
});

test('does not match an official model ID on a proxy host or an undocumented model ID', async () => {
  for (const [endpoint, model] of [
    ['https://proxy.example/v1', 'deepseek-flash'],
    ['https://api.deepseek.com/v1', 'deepseek-v4-pro-latest'],
    ['https://api.moonshot.ai/v1', 'kimi-k3.1'],
  ]) {
    let calls = 0;
    const result = await discoverThinkingTiers({
      endpoint, model, apiKey: 'secret',
      fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
    });
    assert.deepEqual(result, { status: 'unknown', reason: 'accepted_without_tier_evidence' });
    assert.equal(calls, 1);
  }
});


test('does not apply another model metadata record to the requested model', async () => {
  let calls = 0;
  const result = await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'grok-4', apiKey: 'secret',
    modelMetadata: { id: 'grok-3', capabilities: { reasoning_effort: ['low', 'high'] } },
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'accepted_without_tier_evidence' });
  assert.equal(calls, 1);
});

test('returns unknown when exact model metadata has no explicit tier information', async () => {
  let calls = 0;
  const result = await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'custom-gateway-model', apiKey: 'secret',
    modelMetadata: { id: 'custom-gateway-model', capabilities: { reasoning: true } },
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'accepted_without_tier_evidence' });
  assert.equal(calls, 1);
});

test('extracts only explicit legal tiers from a bounded rejection response', async () => {
  const result = await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'model-a', apiKey: 'secret',
    fetchImpl: async (_input, init) => {
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'model-a');
      return new Response(JSON.stringify({ error: { message: 'thinking_level must be one of: low, medium, high' } }), { status: 400 });
    },
  });
  assert.deepEqual(result, { status: 'tiers', tiers: ['low', 'medium', 'high'], source: 'rejection' });
});
test('extracts tiers from a top-level Chinese upstream message', async () => {
  const result = await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'model-a', apiKey: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ message: '该模型始终思考，不支持关闭思考;请使用low、high或max.' }), { status: 400 }),
  });
  assert.deepEqual(result, { status: 'tiers', tiers: ['low', 'high', 'max'], source: 'rejection' });
});

test('does not interpret unrelated error text as a tier enumeration', async () => {
  const result = await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'model-a', apiKey: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ message: '请求失败，请稍后重试。' }), { status: 400 }),
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'no_tier_evidence' });
});


test('accepted minimum request is not treated as proof of an effective tier', async () => {
  let calls = 0;
  const result = await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'model-a', apiKey: 'secret',
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: 'unknown', reason: 'accepted_without_tier_evidence' });
});

test('does not disclose API key through errors or output', async () => {
  const key = 'private-key-value';
  const result = await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'model-a', apiKey: key,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: `invalid credential ${key}` } }), { status: 401 }),
  });
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(result.status, 'unknown');
});

test('limits network probe attempts to one', async () => {
  let calls = 0;
  await discoverThinkingTiers({
    endpoint: 'https://example.invalid/v1', model: 'model-a', apiKey: 'secret',
    fetchImpl: async () => { calls++; throw new Error('network failure'); },
  });
  assert.equal(calls, 1);
});
