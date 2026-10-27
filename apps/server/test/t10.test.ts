import './_brain-env.ts'; // 必须第一条：先设 ASTERHIVE_BRAIN_* 再加载 brain.ts（经 http.ts 传递加载）
import { test } from 'node:test';
import { createServer, type AddressInfo } from 'node:http';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { createBoard } from '../src/tasks.ts';
import { getOverview } from '../src/overview.ts';
import {
  getOrchestratorSettings,
  putOrchestratorSettings,
  activeGroup,
  createOrchestratorGroup,
  updateOrchestratorGroup,
  switchOrchestratorGroup,
  reviewerGroup,
  listOrchestratorModels,
  testOrchestratorModel,
  getCachedOrchestratorModelMetadata,
} from '../src/settings.ts';
import { listEvents } from '../src/write.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { makeCtx } from '../src/types.ts';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

// ---- 2026-10-25 主脑多模型组：组 CRUD / 激活切换 / 迁移 / 按组 models·test / brain 消费 ----

test('T10: 模型组——apiKey 加密落库、明文/密文永不回显；组接口匿名（=user）可写，worker 403，无效 token 401', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'bee' });

    const createBody = JSON.stringify({ name: '主通道', baseURL: 'https://t10.example/v1', model: 'gpt-6', apiKey: 'sk-very-secret' });
    let res = await app.request('/settings/orchestrator/groups', { method: 'POST', headers: H('ah-invalid'), body: createBody });
    assert.equal(res.status, 401, '无效 bearer 401（不静默降权）');

    res = await app.request('/settings/orchestrator/groups', { method: 'POST', headers: H(worker.token), body: createBody });
    assert.equal(res.status, 403, 'worker 角色 403');

    // 零令牌：无凭据即唯一用户（user 角色），可创建
    res = await app.request('/settings/orchestrator/groups', { method: 'POST', headers: H(), body: createBody });
    assert.equal(res.status, 201);
    const { group } = (await res.json()) as { group: { id: string; name: string; apiKeySet?: boolean; model?: string; thinkingLevel?: string; apiKey?: string; apiKeyCipher?: string } };
    assert.ok(group.id.startsWith('g'), `组 id 为 g+随机短码：${group.id}`);
    assert.equal(group.apiKeySet, true, 'apiKeySet=true（已加密落库）');
    assert.equal(group.model, 'gpt-6');
    assert.equal(group.thinkingLevel, 'low', '新建模型组默认 low');
    assert.equal(group.apiKey, undefined, '明文不回显');
    assert.equal(group.apiKeyCipher, undefined, '密文不回显');

    // 落库内容不含明文
    const dbText = readFileSync(join(rig.ctx.cfg.dataDir, 'asterhive.db'), 'utf8');
    assert.ok(!dbText.includes('sk-very-secret'), '数据库文件中无明文 apiKey');

    // 空组态创建的第一组自动激活：activeGroup 可解密（内置主脑消费）
    assert.equal(getOrchestratorSettings(rig.ctx).activeGroupId, group.id);
    assert.equal(activeGroup(rig.ctx)?.apiKey, 'sk-very-secret');
    const updated = await app.request(`/settings/orchestrator/groups/${group.id}`, {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ thinkingLevel: 'xhigh', thinkingLevelMap: { xhigh: 'max' } }),
    });
    assert.equal(updated.status, 200);
    const updatedGroup = (await updated.json() as { group: { thinkingLevel?: string; thinkingLevelMap?: Record<string, string | null>; apiKey?: string; apiKeyCipher?: string } }).group;
    assert.equal(updatedGroup.thinkingLevel, 'xhigh', 'Pi SDK 原生最高等级 xhigh 可保存');
    assert.deepEqual(reviewerGroup(rig.ctx)?.thinkingLevelMap, { xhigh: 'max' }, '默认审核员跟随主脑组的档位映射');
    const reviewerModel = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ reviewerGroupId: group.id, reviewerModel: 'review-model' }),
    });
    assert.equal(reviewerModel.status, 200);
    assert.equal(reviewerGroup(rig.ctx)?.model, 'review-model');
    assert.equal(reviewerGroup(rig.ctx)?.thinkingLevel, 'xhigh');
    assert.equal(reviewerGroup(rig.ctx)?.thinkingLevelMap, undefined, '不同审核员模型不误用主模型专属映射');
    assert.deepEqual(updatedGroup.thinkingLevelMap, { xhigh: 'max' }, '自定义映射应通过设置 API 保存');
    assert.equal(updatedGroup.apiKey, undefined, '更新响应不泄露明文 KEY');
    assert.equal(updatedGroup.apiKeyCipher, undefined, '更新响应不泄露密文 KEY');
    assert.equal(activeGroup(rig.ctx)?.apiKey, 'sk-very-secret', '修改推理等级不破坏加密密钥');
    const switchedModel = await app.request(`/settings/orchestrator/groups/${group.id}`, {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ model: 'gpt-6-next' }),
    });
    assert.equal(switchedModel.status, 200);
    const switchedGroup = (await switchedModel.json() as { group: { thinkingLevel?: string; thinkingLevelMap?: Record<string, string | null> } }).group;
    assert.equal(switchedGroup.thinkingLevelMap, undefined, '切换模型必须清掉旧模型的推理映射');
    assert.equal(switchedGroup.thinkingLevel, 'xhigh', '切换模型保留用户选定 Pi 档位');
  } finally {
    rig.cleanup();
  }
});
test('T10: thinking-tier probe requires confirmation and uses only the saved model-group target', async () => {
  const rig = mkRig();
  const requests: { url: string; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'reasoning_effort must be one of low, high, max' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const app = createApp(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'thinking-probe-worker' });
    const port = (server.address() as AddressInfo).port;
    const created = await app.request('/settings/orchestrator/groups', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({
        name: 'local probe',
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-probe-saved',
        model: 'exact-model',
      }),
    });
    assert.equal(created.status, 201);
    const { group } = (await created.json()) as { group: { id: string } };
    const path = `/settings/orchestrator/groups/${group.id}/thinking-probe`;

    const unconfirmed = await app.request(path, { method: 'POST', headers: H(), body: '{}' });
    assert.equal(unconfirmed.status, 400, '未确认时拒绝触发可能计费的请求');
    const forbidden = await app.request(path, { method: 'POST', headers: H(worker.token), body: JSON.stringify({ confirmed: true }) });
    assert.equal(forbidden.status, 403, 'worker 不能调用探测');
    assert.equal(requests.length, 0, '拒绝请求不能接触上游');

    const result = await app.request(path, {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ confirmed: true, endpoint: 'https://attacker.invalid', apiKey: 'sk-injected', model: 'other-model' }),
    });
    assert.equal(result.status, 200);
    const resultBody = await result.json();
    assert.deepEqual(resultBody, { status: 'tiers', tiers: ['low', 'high', 'max'], source: 'rejection' });
    assert.equal((JSON.stringify(resultBody) ?? '').includes('sk-probe-saved'), false, '响应不得泄露组 API Key');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, '/v1/chat/completions');
    assert.equal(requests[0]?.authorization, 'Bearer sk-probe-saved');
    assert.equal(requests[0]?.body.model, 'exact-model', '探测目标必须取配置组，而非请求体覆盖值');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test('T10: retains exact model metadata per key without trusting an unverified proxy', async () => {
  const rig = mkRig();
  let modelsCalls = 0;
  const chatBodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/meta/v1/models') {
      modelsCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'exact-model', effort: { supported_levels: ['low', 'high', 'max'] } }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      chatBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'reasoning_effort must be one of low, high, max' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const app = createApp(rig.ctx);
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/meta/v1`;
    const createGroup = async (model: string) => {
      const response = await app.request('/settings/orchestrator/groups', {
        method: 'POST',
        headers: H(),
        body: JSON.stringify({ name: model, baseURL, apiKey: 'sk-metadata-probe', model }),
      });
      assert.equal(response.status, 201);
      return (await response.json() as { group: { id: string } }).group;
    };
    const exact = await createGroup('exact-model');
    const modelList = await app.request(`/settings/orchestrator/models?group=${exact.id}`);
    assert.equal(modelList.status, 200);
    assert.deepEqual(getCachedOrchestratorModelMetadata(rig.ctx, exact.id, 'exact-model'), {
      id: 'exact-model',
      effort: { supported_levels: ['low', 'high', 'max'] },
    });
    assert.equal(getCachedOrchestratorModelMetadata(rig.ctx, exact.id, 'different-model'), undefined);
    const metadataResult = await app.request(`/settings/orchestrator/groups/${exact.id}/thinking-probe`, {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ confirmed: true }),
    });
    assert.deepEqual(await metadataResult.json(), {
      status: 'tiers',
      tiers: ['low', 'high', 'max'],
      source: 'rejection',
    }, '不可信代理的 /models 标签不能被当作官方能力证据');
    assert.equal(modelsCalls, 1);
    assert.equal(chatBodies.length, 1, '非官方主机的元数据不可作为能力结论');

    const different = await createGroup('different-model');
    assert.equal(getCachedOrchestratorModelMetadata(rig.ctx, different.id, 'different-model'), undefined);
    const fallback = await app.request(`/settings/orchestrator/groups/${different.id}/thinking-probe`, {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ confirmed: true }),
    });
    assert.deepEqual(await fallback.json(), {
      status: 'tiers',
      tiers: ['low', 'high', 'max'],
      source: 'rejection',
    });
    assert.equal(modelsCalls, 1, '复用短期模型目录缓存');
    assert.equal(chatBodies.length, 2, '不同模型不能复用 exact-model 的能力元数据');
    assert.equal(chatBodies[1]?.model, 'different-model');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test('T10: settings 密钥——无 env 时首次保存组 apiKey 即生成 enc_secret，重启（新连接）后解密仍成功', () => {
  const rig = mkRig();
  const prevEnv = process.env.ASTERHIVE_SECRET;
  try {
    delete process.env.ASTERHIVE_SECRET; // 明确无 env 场景
    const ctx = rig.ctx;

    // 无 ASTERHIVE_SECRET：创建组带 apiKey 自动生成 enc_secret（不再依赖 env/管理令牌）
    createOrchestratorGroup(ctx, { name: '主', baseURL: 'https://t10-key.example/v1', apiKey: 'sk-no-env' });
    const enc = ctx.holder.db.prepare("SELECT value FROM settings WHERE key = 'enc_secret'").get() as {
      value: string;
    };
    assert.ok(/^[0-9a-f]{64}$/.test(enc.value), 'enc_secret 为 32 字节 hex，已落库');

    // 模拟重启：同一数据目录开新连接，env 依旧未设
    const db2 = openDb(ctx.cfg.dataDir);
    const ctx2 = makeCtx(db2, { dataDir: ctx.cfg.dataDir, ttlMinutes: 240, keepSnapshots: 3 });
    try {
      assert.equal(activeGroup(ctx2)?.apiKey, 'sk-no-env', '新连接（重启语义）解密成功——密钥与 env 解耦');
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

test('T10: 旧单配置迁移——顶层 provider/baseURL/model/apiKeyCipher 一次性包成 groups[0]（id=default）+ activeGroupId，事件 settings.groups_migrated', () => {
  const rig = mkRig();
  const prevEnv = process.env.ASTERHIVE_SECRET;
  try {
    // 构造旧形状：顶层单配置（apiKeyCipher 由 env 派生密钥加密，无 enc_secret、无 groups）
    process.env.ASTERHIVE_SECRET = 'legacy-env-secret';
    rig.ctx.holder.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'orchestrator',
        JSON.stringify({
          provider: 'Xapi',
          baseURL: 'https://legacy.example/v1',
          model: 'gpt-legacy',
          apiKeyCipher: legacyEncrypt('sk-legacy', 'legacy-env-secret'),
          enabled: true,
        }),
        Date.now(),
      );

    // 首次读设置即迁移
    const view = getOrchestratorSettings(rig.ctx);
    assert.equal(view.groups.length, 1);
    assert.equal(view.groups[0].id, 'default');
    assert.equal(view.groups[0].name, 'Xapi', '组名取旧 provider');
    assert.equal(view.groups[0].baseURL, 'https://legacy.example/v1');
    assert.equal(view.groups[0].model, 'gpt-legacy');
    assert.equal(view.groups[0].apiKeySet, true, 'apiKeySet 保留');
    assert.equal(view.groups[0].thinkingLevel, 'off', '迁移旧模型组维持原有思考关闭行为');
    assert.equal(view.activeGroupId, 'default');
    assert.equal(view.enabled, true, 'enabled 保留');
    assert.equal(listEvents(rig.ctx, { type: 'settings.groups_migrated', limit: 5 }).length, 1);

    // 迁移一次性：再读不重复迁移/发事件
    getOrchestratorSettings(rig.ctx);
    assert.equal(listEvents(rig.ctx, { type: 'settings.groups_migrated', limit: 5 }).length, 1);

    // 顶层旧字段不再存在于存储
    const stored = JSON.parse(readRow(rig.ctx, 'orchestrator')!) as Record<string, unknown>;
    assert.equal(stored.provider, undefined);
    assert.equal(stored.baseURL, undefined);
    assert.equal(stored.model, undefined);
    assert.equal(stored.apiKeyCipher, undefined);
    assert.ok(Array.isArray(stored.groups));

    // env→enc_secret 密钥迁移仍生效：密文已随组迁移进 groups[0]，resolveSecret 在组内找到旧密文
    assert.equal(activeGroup(rig.ctx)?.apiKey, 'sk-legacy', '升级后首次解密：env 在场 → 迁移成功');
    delete process.env.ASTERHIVE_SECRET;
    assert.equal(activeGroup(rig.ctx)?.apiKey, 'sk-legacy', '迁移后 env 不再被依赖');
    const after = JSON.parse(readRow(rig.ctx, 'orchestrator')!) as { groups: { apiKeyCipher?: string }[] };
    assert.notEqual(after.groups[0].apiKeyCipher, legacyEncrypt('sk-legacy', 'legacy-env-secret'), '密文已原位重加密到组内');
    assert.equal(listEvents(rig.ctx, { type: 'settings.apiKey_migrated', limit: 5 }).length, 1);
  } finally {
    if (prevEnv === undefined) delete process.env.ASTERHIVE_SECRET;
    else process.env.ASTERHIVE_SECRET = prevEnv;
    rig.cleanup();
  }
});

test('T10: settings 密钥迁移失败路径——env 解不开旧密文（组内）：置空组 apiKey 并记 settings.apiKey_reset，之后可用 enc_secret 重填', () => {
  const rig = mkRig();
  const prevEnv = process.env.ASTERHIVE_SECRET;
  try {
    // 旧密文由"已丢失的旧 env 密钥"加密；当前 env 是轮换后的新值，解不开
    process.env.ASTERHIVE_SECRET = 'rotated-env-secret';
    rig.ctx.holder.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('orchestrator', JSON.stringify({ provider: 'openai', apiKeyCipher: legacyEncrypt('sk-old', 'lost-old-secret') }), Date.now());

    // 读设置触发组迁移；解密触发密钥迁移失败路径
    const migrated = getOrchestratorSettings(rig.ctx);
    assert.equal(migrated.groups[0]?.id, 'default');
    const ag = activeGroup(rig.ctx);
    assert.ok(ag, '组迁移后激活组在场');
    assert.equal(ag!.apiKey, null, '解不开 → 按未设置处理');

    const stored = JSON.parse(readRow(rig.ctx, 'orchestrator')!) as { groups: { apiKeyCipher?: string }[] };
    assert.equal(stored.groups[0].apiKeyCipher, undefined, '坏密文已置空');
    assert.ok(readRow(rig.ctx, 'enc_secret'), 'enc_secret 仍建立，部署回到可用状态');
    assert.equal(getOrchestratorSettings(rig.ctx).groups[0].apiKeySet, false, 'UI 显示未设置 → 提示重填');
    assert.equal(listEvents(rig.ctx, { type: 'settings.apiKey_reset', limit: 5 }).length, 1);

    // 之后重填 apiKey 走 enc_secret，正常加解密
    updateOrchestratorGroup(rig.ctx, 'default', { apiKey: 'sk-refilled' });
    assert.equal(activeGroup(rig.ctx)?.apiKey, 'sk-refilled');
  } finally {
    if (prevEnv === undefined) delete process.env.ASTERHIVE_SECRET;
    else process.env.ASTERHIVE_SECRET = prevEnv;
    rig.cleanup();
  }
});

test('T10: 局部更新回归——组字段 undefined 键不覆盖（曾把存量字段覆盖成 undefined 后被 JSON 丢弃）；全局 PUT 只动 enabled/wakeOn', () => {
  const rig = mkRig();
  try {
    const g = createOrchestratorGroup(rig.ctx, {
      name: '主',
      baseURL: 'https://t10-keep.example/v1',
      model: 'm1',
      apiKey: 'sk-keep',
    });
    // http 层对未传字段会显式构造 undefined 键——这里原样复现
    updateOrchestratorGroup(rig.ctx, g.id, {
      name: undefined,
      baseURL: undefined,
      model: 'm2',
      apiKey: undefined,
    } as Parameters<typeof updateOrchestratorGroup>[2]);

    const view = getOrchestratorSettings(rig.ctx).groups.find((x) => x.id === g.id)!;
    assert.equal(view.name, '主', 'name 保留');
    assert.equal(view.baseURL, 'https://t10-keep.example/v1', 'baseURL 保留');
    assert.equal(view.model, 'm2', 'model 已更新');
    assert.equal(view.apiKeySet, true, 'apiKey 未被清空');
    assert.equal(activeGroup(rig.ctx)?.apiKey, 'sk-keep', '解密后 KEY 不变');

    // 全局 PUT：enabled/wakeOn 局部语义（undefined 键不覆盖）
    putOrchestratorSettings(rig.ctx, { enabled: true, wakeOn: { userMessage: false } });
    putOrchestratorSettings(rig.ctx, { enabled: false, wakeOn: undefined });
    const s = getOrchestratorSettings(rig.ctx);
    assert.equal(s.enabled, false, 'enabled 已更新');
    assert.equal(s.wakeOn?.userMessage, false, 'wakeOn 保留（undefined 键不覆盖）');

    // 空更新不落库不发事件（避免惊动主脑重建会话）
    const before = listEvents(rig.ctx, { type: 'settings.orchestrator_updated', limit: 50 }).length;
    putOrchestratorSettings(rig.ctx, { enabled: undefined, wakeOn: undefined });
    assert.equal(listEvents(rig.ctx, { type: 'settings.orchestrator_updated', limit: 50 }).length, before, '空更新无事件');
  } finally {
    rig.cleanup();
  }
});

test('T10: listOrchestratorModels 拉取上游 /models 并按 baseURL 缓存 60s（缺省 = 激活组）', async () => {
  const rig = mkRig();
  try {
    createOrchestratorGroup(rig.ctx, {
      name: 'M',
      baseURL: 'https://t10-models.example/v1',
      model: 'gemini-x',
      apiKey: 'sk-models',
    });
    let fetchCount = 0;
    const stub = (async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ data: [{ id: 'beta' }, { id: 'alpha' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r1 = await listOrchestratorModels(rig.ctx, {}, stub);
    assert.deepEqual(r1.models, ['alpha', 'beta'], '排序去重输出');
    assert.equal(r1.cached, false);
    const r2 = await listOrchestratorModels(rig.ctx, {}, stub);
    assert.equal(r2.cached, true, 'TTL 内命中缓存');
    assert.equal(fetchCount, 1, '上游只打了一次');
  } finally {
    rig.cleanup();
  }
});

test('T10: testOrchestratorModel 成功/失败都不抛异常，带状态与延迟', async () => {
  const rig = mkRig();
  try {
    createOrchestratorGroup(rig.ctx, {
      name: 'P',
      baseURL: 'https://t10-probe.example/v1',
      model: 'm-ok',
      apiKey: 'sk-probe',
    });
    const ok = await testOrchestratorModel(
      rig.ctx,
      {},
      (async () => new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 })) as unknown as typeof fetch,
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.ok(ok.latencyMs >= 0);

    const bad = await testOrchestratorModel(
      rig.ctx,
      { model: 'm-bad' },
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

test('T10: models/test 按组路由——stub fetch 区分 baseURL，缓存键=baseURL，缺省 = 激活组，组不存在 404', async () => {
  const rig = mkRig();
  try {
    const a = createOrchestratorGroup(rig.ctx, { name: 'A', baseURL: 'https://t10-a.example/v1', model: 'm-a', apiKey: 'sk-a' });
    const b = createOrchestratorGroup(rig.ctx, { name: 'B', baseURL: 'https://t10-b.example/v1', model: 'm-b', apiKey: 'sk-b' });
    const seen: { url: string; auth: string; body: string }[] = [];
    const recording = (resp: () => Response) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({
          url: String(input),
          auth: headers.authorization ?? '',
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return resp();
      }) as unknown as typeof fetch;
    const stub = recording(() => {
      // 上一条请求的 URL 决定响应（A/B 清单内容不同，用于区分缓存）
      const url = seen[seen.length - 1]?.url ?? '';
      if (url.startsWith('https://t10-a.example')) {
        return new Response(JSON.stringify({ data: [{ id: 'a2' }, { id: 'a1' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: 'b1' }] }), { status: 200 });
    });

    // 按组拉取：URL/KEY 都来自组本身
    const ra = await listOrchestratorModels(rig.ctx, { groupId: a.id }, stub);
    assert.deepEqual(ra.models, ['a1', 'a2']);
    assert.equal(seen[0].url, 'https://t10-a.example/v1/models', '按组 baseURL 路由');
    assert.equal(seen[0].auth, 'Bearer sk-a', '按组 apiKey');
    const rb = await listOrchestratorModels(rig.ctx, { groupId: b.id }, stub);
    assert.deepEqual(rb.models, ['b1']);
    assert.equal(seen[1].auth, 'Bearer sk-b');
    assert.equal(seen.length, 2);

    // 缓存键 = baseURL：再拉 A 命中缓存，上游不再被打
    const ra2 = await listOrchestratorModels(rig.ctx, { groupId: a.id }, stub);
    assert.equal(ra2.cached, true);
    assert.equal(seen.length, 2);

    // 缺省 = 激活组：切到 B 后缺省走 B（A/B 清单内容不同，结果可区分）
    switchOrchestratorGroup(rig.ctx, b.id);
    const rd = await listOrchestratorModels(rig.ctx, {}, stub);
    assert.deepEqual(rd.models, ['b1'], '缺省走激活组 B');
    assert.equal(rd.cached, true);
    assert.equal(seen.length, 2, '复用 B 的 baseURL 缓存');

    // 组不存在 → 404
    await assert.rejects(
      () => listOrchestratorModels(rig.ctx, { groupId: 'g-nope' }, stub),
      (err: unknown) => (err as { status?: number }).status === 404,
      '组不存在 404',
    );

    // test 按组探测：model 缺省取组配置
    seen.length = 0;
    const probe = await testOrchestratorModel(
      rig.ctx,
      { groupId: b.id },
      recording(() => new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 })),
    );
    assert.equal(probe.ok, true);
    assert.equal(seen[0].url, 'https://t10-b.example/v1/chat/completions');
    assert.ok(seen[0].body.includes('"model":"m-b"'), 'model 缺省取组配置');

    // 缺省探测 = 激活组
    seen.length = 0;
    await testOrchestratorModel(
      rig.ctx,
      {},
      recording(() => new Response('{}', { status: 200 })),
    );
    assert.ok(seen[0].url.startsWith('https://t10-b.example'), '缺省探测走激活组 B');
  } finally {
    rig.cleanup();
  }
});

test('T10: 组 CRUD over HTTP——局部更新、删除激活组 422、删空允许（未配置态）、active 切换事件必发、GET 投影无密文', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);

    // 创建两组（首组自动激活）
    const r1 = await app.request('/settings/orchestrator/groups', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ name: '主通道', baseURL: 'https://c1.example/v1', apiKey: 'sk-1' }),
    });
    assert.equal(r1.status, 201);
    const g1 = ((await r1.json()) as { group: { id: string } }).group;
    const r2 = await app.request('/settings/orchestrator/groups', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ name: '备用', baseURL: 'https://c2.example/v1', model: 'm2' }),
    });
    assert.equal(r2.status, 201);
    const g2 = ((await r2.json()) as { group: { id: string; apiKeySet: boolean } }).group;
    assert.equal(g2.apiKeySet, false, '未传 KEY 的组 apiKeySet=false');

    let view = (await (await app.request('/settings/orchestrator')).json()) as {
      enabled?: boolean;
      activeGroupId?: string | null;
      groups?: { id: string; name: string; baseURL: string; model?: string; apiKeySet?: boolean }[];
    };
    assert.equal(view.activeGroupId, g1.id, '首组自动激活');
    assert.equal(view.groups?.length, 2);

    // GET 投影：永不含密文/明文；旧单配置顶层字段不再输出
    const raw = (await (await app.request('/settings/orchestrator')).json()) as Record<string, unknown>;
    assert.equal(raw.provider, undefined);
    assert.equal(raw.baseURL, undefined);
    assert.equal(raw.model, undefined);
    assert.equal(raw.apiKey, undefined);
    assert.equal(raw.apiKeyCipher, undefined);
    for (const g of (raw.groups ?? []) as Record<string, unknown>[]) {
      assert.equal(g.apiKeyCipher, undefined, '组投影无密文');
      assert.equal(g.apiKey, undefined, '组投影无明文');
    }

    // 局部更新（apiKey 缺省保留）
    const ru = await app.request(`/settings/orchestrator/groups/${g2.id}`, {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ model: 'm2x' }),
    });
    assert.equal(ru.status, 200);
    const updated = ((await ru.json()) as { group: { model?: string; name: string; baseURL: string; apiKeySet?: boolean } }).group;
    assert.equal(updated.model, 'm2x');
    assert.equal(updated.name, '备用', '未传字段保留');
    assert.equal(updated.baseURL, 'https://c2.example/v1', '未传字段保留');

    // 更新不存在的组 → 404
    const r404 = await app.request('/settings/orchestrator/groups/g-nope', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(r404.status, 404);

    // 删除激活组 → 422
    const rdActive = await app.request(`/settings/orchestrator/groups/${g1.id}`, { method: 'DELETE', headers: H() });
    assert.equal(rdActive.status, 422, '激活组不可删——先启用其他组');

    // 切换激活：组不存在 404；成功后 orchestrator_updated 事件必发（brain disposeSession 闭环）
    const badSwitch = await app.request('/settings/orchestrator/active', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ groupId: 'g-nope' }),
    });
    assert.equal(badSwitch.status, 404);
    const sw = await app.request('/settings/orchestrator/active', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ groupId: g2.id }),
    });
    assert.equal(sw.status, 200);
    view = (await sw.json()) as typeof view;
    assert.equal(view.activeGroupId, g2.id);
    const evs = listEvents(rig.ctx, { type: 'settings.orchestrator_updated', limit: 50 });
    assert.ok(
      evs.some((e) => e.payload.groupId === g2.id && (e.payload.fields as string[]).includes('activeGroupId')),
      'active 切换事件必发（带 groupId 与 fields）',
    );

    // 切换后原激活组可删；删最后一组（即激活组）也允许——删空 = 主脑未配置态（"清空重配"的合法路径）
    const rd1 = await app.request(`/settings/orchestrator/groups/${g1.id}`, { method: 'DELETE', headers: H() });
    assert.equal(rd1.status, 200);
    const rd2 = await app.request(`/settings/orchestrator/groups/${g2.id}`, { method: 'DELETE', headers: H() });
    assert.equal(rd2.status, 200, '删最后一组（激活组）允许');
    const empty = (await (await app.request('/settings/orchestrator')).json()) as {
      groups: unknown[];
      activeGroupId: string | null;
    };
    assert.deepEqual(empty.groups, []);
    assert.equal(empty.activeGroupId, null, 'activeGroupId 悬空 → null');
    assert.equal(activeGroup(rig.ctx), null, '删空 = 主脑未配置态');
    assert.ok(
      listEvents(rig.ctx, { type: 'settings.orchestrator_updated', limit: 50 }).some((e) => e.payload.groupId === g2.id),
      '删除激活组（最后一组）必发 orchestrator_updated（brain disposeSession 闭环）',
    );
  } finally {
    rig.cleanup();
  }
});

test('T10: brain 消费 activeGroup——无组/组缺 KEY 不启动轮次（唤醒原因丢弃），配置补全前不会误发轮次', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    createBoard(rig.ctx, { id: 'b', name: '板' });

    // 启用主脑但无任何模型组
    const put = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put.status, 200);
    await app.request('/boards/b/messages', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ content: '@主脑 试试' }),
    });
    await sleep(800); // 越过去抖窗口（_brain-env 200ms）
    let types = listEvents(rig.ctx, { limit: 100 }).map((e) => e.type);
    assert.ok(types.includes('brain.started'), '主脑激活（身份注册）照常');
    assert.ok(!types.includes('brain.turn_started'), '无激活组不应有轮次');

    // 组缺 apiKey：同样不启动（创建首组自动激活 → orchestrator_updated → markDirty → 仍不启动）
    createOrchestratorGroup(rig.ctx, { name: '缺KEY组', baseURL: 'https://t10-nokey.example/v1', model: 'm1' });
    await sleep(800);
    types = listEvents(rig.ctx, { limit: 200 }).map((e) => e.type);
    assert.ok(!types.includes('brain.turn_started'), '组缺 apiKey 不应有轮次');

    // 收尾：关闭主脑，清掉去抖计时器，避免清理数据目录后计时器触碰已关闭的库
    const off = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    await sleep(300);
    types = listEvents(rig.ctx, { limit: 200 }).map((e) => e.type);
    assert.ok(types.includes('brain.stopped'), '关闭后应有 brain.stopped');
    assert.ok(!types.includes('brain.turn_started'), '全程未产生轮次');
  } finally {
    rig.cleanup();
  }
});
