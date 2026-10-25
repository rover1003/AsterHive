import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { getOverview } from '../src/overview.ts';
import { getOrchestratorSettings, putOrchestratorSettings, decryptApiKey, listOrchestratorModels, testOrchestratorModel } from '../src/settings.ts';
import { listEvents } from '../src/write.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { makeCtx } from '../src/types.ts';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function seed(app: ReturnType<typeof createApp>, rig: ReturnType<typeof mkRig>) {
  const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
  const bee = registerAgent(rig.ctx, { name: '工蜂1', handle: 'zcode' });
  await app.request('/boards', { method: 'POST', headers: H(orch.token), body: JSON.stringify({ id: 'b', name: '板' }) });
  await app.request('/boards/b/tasks', {
    method: 'POST',
    headers: H(orch.token),
    body: JSON.stringify({ id: 'T1', title: '活', lane: 'Ready' }),
  });
  await app.request('/tasks/T1/claim', { method: 'POST', headers: H(bee.token), body: '{}' });
  await app.request('/tasks/T1/checkpoint', {
    method: 'POST',
    headers: H(bee.token),
    body: JSON.stringify({ note: '正在处理' }),
  });
  return { orch, bee };
}

test('T10: /overview——占用/进度/状态纯投影', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const { bee } = await seed(app, rig);

    const ov = getOverview(rig.ctx);
    const b = ov.agents.find((a) => a.id === bee.agent.id)!;
    assert.equal(b.status, 'working', '有 InProgress 占用 → working');
    assert.equal(b.currentTask?.id, 'T1');
    assert.equal(b.currentTask?.lastCheckpoint?.note, '正在处理', '最新 checkpoint 进消息');
    assert.ok(b.currentTask!.elapsedMs >= 0);
    assert.equal(ov.aggregates.working, 1);
    assert.equal(ov.aggregates.lanes.InProgress.count, 1);
    assert.equal(ov.aggregates.lanes.InProgress.limit, 3);

    // HTTP 层同样可读
    const res = await app.request('/overview');
    assert.equal(res.status, 200);
  } finally {
    rig.cleanup();
  }
});

test('T10: 主脑设置——apiKey 加密落库、读取掩码、运行时可解密；PUT 匿名（=user）可写，worker 403，无效 token 401', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'bee' });

    let res = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H('ah-invalid'),
      body: JSON.stringify({ provider: 'openai', model: 'gpt-6', apiKey: 'sk-very-secret' }),
    });
    assert.equal(res.status, 401, '无效 bearer 401（不静默降权）');

    res = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(worker.token),
      body: JSON.stringify({ provider: 'openai', model: 'gpt-6', apiKey: 'sk-very-secret' }),
    });
    assert.equal(res.status, 403, 'worker 角色 403');

    // 零令牌：无凭据即唯一用户（user 角色），可保存
    res = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ provider: 'openai', model: 'gpt-6', apiKey: 'sk-very-secret' }),
    });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { apiKeySet?: boolean; apiKey?: string; model?: string };
    assert.equal(body.apiKeySet, true);
    assert.equal(body.apiKey, undefined, '明文永不回显');
    assert.equal(body.model, 'gpt-6');

    // 落库内容不含明文
    const dbText = readFileSync(join(rig.ctx.cfg.dataDir, 'asterhive.db'), 'utf8');
    assert.ok(!dbText.includes('sk-very-secret'), '数据库文件中无明文 apiKey');

    // 运行时解密（内置主脑消费）
    assert.equal(decryptApiKey(rig.ctx), 'sk-very-secret');

    body = getOrchestratorSettings(rig.ctx);
    assert.equal(body.model, 'gpt-6');
  } finally {
    rig.cleanup();
  }
});

test('T10: settings 密钥——无 env 时首次保存即生成 enc_secret，重启（新连接）后解密仍成功', () => {
  const rig = mkRig();
  const prevEnv = process.env.ASTERHIVE_SECRET;
  try {
    delete process.env.ASTERHIVE_SECRET; // 明确无 env 场景
    const ctx = rig.ctx;

    // 无 ASTERHIVE_SECRET：保存 apiKey 自动生成 enc_secret（不再依赖 env/管理令牌）
    const saved = putOrchestratorSettings(ctx, { provider: 'openai', model: 'gpt-6', apiKey: 'sk-no-env' });
    assert.equal(saved.apiKeySet, true);
    const enc = ctx.holder.db.prepare("SELECT value FROM settings WHERE key = 'enc_secret'").get() as {
      value: string;
    };
    assert.ok(/^[0-9a-f]{64}$/.test(enc.value), 'enc_secret 为 32 字节 hex，已落库');

    // 模拟重启：同一数据目录开新连接，env 依旧未设
    const db2 = openDb(ctx.cfg.dataDir);
    const ctx2 = makeCtx(db2, { dataDir: ctx.cfg.dataDir, ttlMinutes: 240, keepSnapshots: 3 });
    try {
      assert.equal(decryptApiKey(ctx2), 'sk-no-env', '新连接（重启语义）解密成功——密钥与 env 解耦');
    } finally {
      db2.close();
    }
  } finally {
    if (prevEnv === undefined) delete process.env.ASTERHIVE_SECRET;
    else process.env.ASTERHIVE_SECRET = prevEnv;
    rig.cleanup();
  }
});

// 旧版本密钥方案复刻（迁移测试用）：scrypt(secret, 'asterhive-settings-v1', 32) + AES-256-GCM
function legacyEncrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(secret, 'asterhive-settings-v1', 32), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function readRow(ctx: ReturnType<typeof mkRig>['ctx'], key: string): string | null {
  const row = ctx.holder.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

test('T10: settings 密钥迁移——env 仍设且能解开旧密文：一次性迁移到 enc_secret，此后 env 可撤', () => {
  const rig = mkRig();
  const prevEnv = process.env.ASTERHIVE_SECRET;
  try {
    // 构造旧数据：apiKeyCipher 由 env 派生密钥加密，且没有 enc_secret
    process.env.ASTERHIVE_SECRET = 'legacy-env-secret';
    rig.ctx.holder.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('orchestrator', JSON.stringify({ provider: 'openai', apiKeyCipher: legacyEncrypt('sk-legacy', 'legacy-env-secret') }), Date.now());

    // 升级后首次解密：env 在场 → 迁移成功并返回明文
    assert.equal(decryptApiKey(rig.ctx), 'sk-legacy');

    const enc = readRow(rig.ctx, 'enc_secret');
    assert.ok(/^[0-9a-f]{64}$/.test(enc ?? ''), 'enc_secret 已建立');
    const stored = JSON.parse(readRow(rig.ctx, 'orchestrator')!) as { apiKeyCipher: string };
    assert.notEqual(stored.apiKeyCipher, legacyEncrypt('sk-legacy', 'legacy-env-secret'), '密文已重加密');

    // env 撤掉后（重启且忘带 env 的最坏情形）解密依然成功——已迁移到 enc_secret
    delete process.env.ASTERHIVE_SECRET;
    assert.equal(decryptApiKey(rig.ctx), 'sk-legacy', '迁移后 env 不再被依赖');

    assert.equal(listEvents(rig.ctx, { type: 'settings.apiKey_migrated', limit: 5 }).length, 1);
  } finally {
    if (prevEnv === undefined) delete process.env.ASTERHIVE_SECRET;
    else process.env.ASTERHIVE_SECRET = prevEnv;
    rig.cleanup();
  }
});

test('T10: settings 密钥迁移失败路径——env 解不开旧密文：置空 apiKey 并记 settings.apiKey_reset，之后可用 enc_secret 重填', () => {
  const rig = mkRig();
  const prevEnv = process.env.ASTERHIVE_SECRET;
  try {
    // 旧密文由"已丢失的旧 env 密钥"加密；当前 env 是轮换后的新值，解不开
    process.env.ASTERHIVE_SECRET = 'rotated-env-secret';
    rig.ctx.holder.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('orchestrator', JSON.stringify({ provider: 'openai', apiKeyCipher: legacyEncrypt('sk-old', 'lost-old-secret') }), Date.now());

    assert.equal(decryptApiKey(rig.ctx), null, '解不开 → 按未设置处理');

    const stored = JSON.parse(readRow(rig.ctx, 'orchestrator')!) as { apiKeyCipher?: string };
    assert.equal(stored.apiKeyCipher, undefined, '坏密文已置空');
    assert.ok(readRow(rig.ctx, 'enc_secret'), 'enc_secret 仍建立，部署回到可用状态');
    assert.equal(getOrchestratorSettings(rig.ctx).apiKeySet, false, 'UI 显示未设置 → 提示重填');
    assert.equal(listEvents(rig.ctx, { type: 'settings.apiKey_reset', limit: 5 }).length, 1);

    // 之后重填 apiKey 走 enc_secret，正常加解密
    putOrchestratorSettings(rig.ctx, { apiKey: 'sk-refilled' });
    assert.equal(decryptApiKey(rig.ctx), 'sk-refilled');
  } finally {
    if (prevEnv === undefined) delete process.env.ASTERHIVE_SECRET;
    else process.env.ASTERHIVE_SECRET = prevEnv;
    rig.cleanup();
  }
});

// ---- 2026-10-25 追加：局部 PUT 回归 + 模型清单/连通测试（设置页下拉的数据源）----

test('T10: 局部 PUT 不清空未传字段（回归：曾把 enabled/provider/baseURL 覆盖成 undefined 后被 JSON 丢弃）', () => {
  const rig = mkRig();
  try {
    putOrchestratorSettings(rig.ctx, {
      enabled: true,
      provider: 'Xapi',
      baseURL: 'https://t10-keep.example/v1',
      model: 'm1',
      apiKey: 'sk-keep',
    });
    // http 层对未传字段会显式构造 undefined 键——这里原样复现
    putOrchestratorSettings(rig.ctx, {
      enabled: undefined,
      provider: undefined,
      baseURL: undefined,
      model: 'm2',
      apiKey: undefined,
      wakeOn: undefined,
    } as Parameters<typeof putOrchestratorSettings>[1]);

    const s = getOrchestratorSettings(rig.ctx);
    assert.equal(s.enabled, true, 'enabled 保留');
    assert.equal(s.provider, 'Xapi', 'provider 保留');
    assert.equal(s.baseURL, 'https://t10-keep.example/v1', 'baseURL 保留');
    assert.equal(s.model, 'm2', 'model 已更新');
    assert.equal(s.apiKeySet, true, 'apiKey 未被清空');
  } finally {
    rig.cleanup();
  }
});

test('T10: listOrchestratorModels 拉取上游 /models 并按 baseURL 缓存 60s', async () => {
  const rig = mkRig();
  try {
    putOrchestratorSettings(rig.ctx, {
      baseURL: 'https://t10-models.example/v1',
      model: 'gemini-x',
      apiKey: 'sk-models',
    });
    let fetchCount = 0;
    const stub = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: 'beta' }, { id: 'alpha' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r1 = await listOrchestratorModels(rig.ctx, stub);
    assert.deepEqual(r1.models, ['alpha', 'beta'], '排序去重输出');
    assert.equal(r1.cached, false);
    const r2 = await listOrchestratorModels(rig.ctx, stub);
    assert.equal(r2.cached, true, 'TTL 内命中缓存');
    assert.equal(fetchCount, 1, '上游只打了一次');
  } finally {
    rig.cleanup();
  }
});

test('T10: testOrchestratorModel 成功/失败都不抛异常，带状态与延迟', async () => {
  const rig = mkRig();
  try {
    putOrchestratorSettings(rig.ctx, {
      baseURL: 'https://t10-probe.example/v1',
      model: 'm-ok',
      apiKey: 'sk-probe',
    });
    const ok = await testOrchestratorModel(
      rig.ctx,
      undefined,
      (async () => new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 })) as unknown as typeof fetch,
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.ok(ok.latencyMs >= 0);

    const bad = await testOrchestratorModel(
      rig.ctx,
      'm-bad',
      (async () =>
        new Response('{"error":{"message":"No available accounts"}}', {
          status: 503,
          statusText: 'Service Unavailable',
        })) as unknown as typeof fetch,
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 503);
    assert.match(bad.error ?? '', /No available accounts/, '上游错误透传给 UI');
  } finally {
    rig.cleanup();
  }
});
