import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, ensureBrainAgent, findAgent } from '../src/agents.ts';
import { listEvents } from '../src/write.ts';
import type { Agent } from '../src/agents.ts';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 单用户模型·零令牌终态测试：GET/PUT /api/user 改名流程、旧 user 迁移清理、
// asterhive-brain 不受影响、主脑设置与 agent 启停的 requireElevated 闸门、技能分发。
// 鉴权语义：无 Authorization = 唯一用户（写放行）；无效 token 401；worker 角色限制不变。
function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('单用户：GET/PUT /api/user——匿名即用户、公开回填、改名落账 user.configured', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);

    let res = await app.request('/api/user');
    assert.equal(res.status, 200);
    let status = (await res.json()) as { handle: string | null; configured: boolean };
    assert.deepEqual(status, { handle: null, configured: false }, '未配置时 handle 为 null');

    res = await app.request('/api/user', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ handle: 'boss' }),
    });
    assert.equal(res.status, 200, '零令牌：无凭据改名直接成功');
    assert.deepEqual((await res.json()) as { handle: string }, { handle: 'boss' }, '响应只含 handle');

    status = (await (await app.request('/api/user')).json()) as typeof status;
    assert.deepEqual(status, { handle: 'boss', configured: true }, '公开回填');

    // 匿名即用户身份：写操作放行（user 角色语义）
    res = await app.request('/boards', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ id: 'b', name: '板' }),
    });
    assert.equal(res.status, 201, '匿名（=user）写操作放行');

    assert.ok(
      listEvents(rig.ctx, { type: 'user.configured', limit: 5 }).some((e) => e.payload.handle === 'boss'),
      'user.configured 事件落账',
    );
    assert.equal(findAgent(rig.ctx, 'user')!.handle, 'boss', '单用户身份 handle 已更新');
  } finally {
    rig.cleanup();
  }
});

test('单用户：重复 PUT 幂等改名——响应稳定、无 token 轮换概念、改名生效', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);

    const first = await app.request('/api/user', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ handle: 'boss' }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()) as { handle: string }, { handle: 'boss' });

    // 重复 PUT：幂等改名（零令牌终态不签发/轮换任何凭据）
    const second = await app.request('/api/user', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ handle: 'boss' }),
    });
    assert.equal(second.status, 200, '重复改名幂等 200');
    assert.deepEqual((await second.json()) as { handle: string }, { handle: 'boss' });

    // 无"用户 token"概念：改名后匿名写操作照常放行
    const res = await app.request('/boards', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ id: 'b1', name: 'x' }),
    });
    assert.equal(res.status, 201, '匿名写操作不受改名影响');

    // 改名：仅更新 name/handle，id 保持 'user'
    const rename = await app.request('/api/user', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ handle: '老板' }),
    });
    assert.equal(rename.status, 200);
    assert.deepEqual((await rename.json()) as { handle: string }, { handle: '老板' });
    assert.equal(findAgent(rig.ctx, 'user')!.handle, '老板');
  } finally {
    rig.cleanup();
  }
});

test('单用户：迁移——首次写操作触发 ensure，既有 user 角色 agent 直接删除（≠停用），asterhive-brain 不受影响', async () => {
  const rig = mkRig();
  try {
    // 模拟旧部署：两个 user 角色 agent（含占用目标句柄 'boss' 的）+ 内置主脑
    const legacy1 = registerAgent(rig.ctx, { name: '老板', handle: 'boss', role: 'user' });
    const legacy2 = registerAgent(rig.ctx, { name: 'boss', handle: 'boss2', role: 'user' });
    const brain = ensureBrainAgent(rig.ctx);

    const app = createApp(rig.ctx);
    const res = await app.request('/api/user', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ handle: 'boss' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as { handle: string }, { handle: 'boss' }, '目标句柄让出后由单用户持有');

    // 两个旧 user 被彻底删除（无停用行残留）；单用户身份 id='user' 建立
    assert.equal(findAgent(rig.ctx, legacy1.agent.id), null, '旧 user 已删除（非停用）');
    assert.equal(findAgent(rig.ctx, legacy2.agent.id), null, '旧 user 已删除（非停用）');
    assert.equal(findAgent(rig.ctx, 'user')!.handle, 'boss', "单用户身份 id='user' 已建立");

    // asterhive-brain 不受影响：仍启用、角色 orchestrator、句柄 '主脑'
    const b = findAgent(rig.ctx, brain.id)!;
    assert.equal(b.enabled, true);
    assert.equal(b.role, 'orchestrator');
    assert.equal(b.handle, '主脑');

    const migrated = listEvents(rig.ctx, { type: 'user.migrated_cleaned', limit: 5 });
    assert.equal(migrated.length, 1, 'user.migrated_cleaned 事件落账一次');
    assert.equal((migrated[0].payload.agents as unknown[]).length, 2, '事件列出全部旧 user');

    // 迁移后的匿名（单用户）写操作可用
    const me = await app.request('/boards', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ id: 'b', name: '板' }),
    });
    assert.equal(me.status, 201);
  } finally {
    rig.cleanup();
  }
});

test('agent 删除——匿名（=user）可删、worker 403、无效 token 401、单用户受保护、真删行且落账', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '临时工', handle: 'tmp' });

    // 单用户身份受保护（匿名身份不可自删）
    let res = await app.request('/agents/user', { method: 'DELETE', headers: H() });
    assert.equal(res.status, 422);

    // worker token 不够格
    res = await app.request(`/agents/${encodeURIComponent(worker.agent.id)}`, {
      method: 'DELETE',
      headers: H(worker.token),
    });
    assert.equal(res.status, 403, 'worker 不能删 agent');

    // 无效 token 明确失败
    res = await app.request(`/agents/${encodeURIComponent(worker.agent.id)}`, {
      method: 'DELETE',
      headers: H('ah-invalid'),
    });
    assert.equal(res.status, 401, '无效 bearer 401');

    // 匿名（=user）可删；真删（行消失）且事件落账
    res = await app.request(`/agents/${encodeURIComponent(worker.agent.id)}`, { method: 'DELETE', headers: H() });
    assert.equal(res.status, 200);
    assert.equal(findAgent(rig.ctx, worker.agent.id), null);
    assert.ok(listEvents(rig.ctx, { type: 'agent.deleted', limit: 5 }).length === 1);

    // 再删 404
    res = await app.request(`/agents/${encodeURIComponent(worker.agent.id)}`, { method: 'DELETE', headers: H() });
    assert.equal(res.status, 404);
  } finally {
    rig.cleanup();
  }
});

test('工蜂自助注销: POST /agents/me/unregister 凭自身 token 销毁身份、行消失且 token 失效', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '即将注销的工蜂', handle: 'self-del' });

    // 1. 凭自身 token 注销
    let res = await app.request('/agents/me/unregister', {
      method: 'POST',
      headers: H(worker.token),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean; deleted: string };
    assert.equal(data.ok, true);
    assert.equal(data.deleted, worker.agent.id);

    // 2. 数据库行消失
    assert.equal(findAgent(rig.ctx, worker.agent.id), null);

    // 3. 审计事件落账
    assert.ok(listEvents(rig.ctx, { type: 'agent.deleted', limit: 5 }).length === 1);

    // 4. 原 token 立即失效（401）
    res = await app.request('/agents/me/inbox', { headers: H(worker.token) });
    assert.equal(res.status, 401);
  } finally {
    rig.cleanup();
  }
});

test('单用户：校验——空句柄/保留句柄/乱码 422 且无副作用；句柄与他人冲突 409', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const put = (handle?: string) =>
      app.request('/api/user', {
        method: 'PUT',
        headers: H(),
        body: JSON.stringify(handle === undefined ? {} : { handle }),
      });

    let res = await put();
    assert.equal(res.status, 422, '句柄必填');
    res = await put('主脑');
    assert.equal(res.status, 422, '保留句柄拒绝');
    res = await put('bad\uFFFD');
    assert.equal(res.status, 422, '乱码句柄拒收');
    assert.equal(((await (await app.request('/api/user')).json()) as { configured: boolean }).configured, false, '失败的创建不留副作用');

    // 与他人（worker）句柄冲突：创建与更新两条路径都 409
    registerAgent(rig.ctx, { name: '工蜂', handle: 'bee' });
    res = await put('bee');
    assert.equal(res.status, 409, '创建路径句柄冲突 409');

    await put('boss');
    res = await put('bee');
    assert.equal(res.status, 409, '更新路径句柄冲突 409');
    assert.equal(findAgent(rig.ctx, 'user')!.handle, 'boss', '冲突时不改动现有用户名');
  } finally {
    rig.cleanup();
  }
});

test('提权闸门：主脑设置/agent 启停——匿名（=user）/orchestrator 可写，worker 403，无效 token 401', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'bee1' });
    const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });

    // 主脑设置：GET 公开读
    let res = await app.request('/settings/orchestrator');
    assert.equal(res.status, 200);

    res = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ provider: 'openai', model: 'gpt-6' }),
    });
    assert.equal(res.status, 200, '匿名即 user，可保存');

    res = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H('ah-invalid'),
      body: JSON.stringify({ provider: 'openai' }),
    });
    assert.equal(res.status, 401, '无效 bearer 401');

    res = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(worker.token),
      body: JSON.stringify({ provider: 'openai' }),
    });
    assert.equal(res.status, 403, 'worker 角色 403');

    res = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: H(orch.token),
      body: JSON.stringify({ model: 'gpt-7' }),
    });
    assert.equal(res.status, 200, 'orchestrator 身份可保存');

    // agent 启停：同一闸门
    res = await app.request(`/agents/${worker.agent.id}`, {
      method: 'PATCH',
      headers: H(worker.token),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 403, 'worker 不能启停 agent');

    res = await app.request(`/agents/${worker.agent.id}`, {
      method: 'PATCH',
      headers: H(),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200, '匿名（=user）可启停 agent');
    assert.equal(((await res.json()) as { agent: Agent }).agent.enabled, false);

    res = await app.request(`/agents/${worker.agent.id}`, {
      method: 'PATCH',
      headers: H(orch.token),
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200, 'orchestrator 可启停 agent');
    assert.equal(((await res.json()) as { agent: Agent }).agent.enabled, true);

    // 吊销 worker 后其 inbox 拒绝（token 失效）
    res = await app.request(`/agents/${worker.agent.id}`, {
      method: 'PATCH',
      headers: H(orch.token),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200);
    res = await app.request('/agents/me/inbox', { headers: H(worker.token) });
    assert.equal(res.status, 401);
  } finally {
    rig.cleanup();
  }
});

test('注册自由化：worker/orchestrator/user 均无门槛注册，token 仅一次返回', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    for (const [role, handle] of [
      ['worker', 'bee'],
      ['orchestrator', 'brain-a'],
      ['user', 'someone'],
    ] as const) {
      const res = await app.request('/agents/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `N-${handle}`, handle, role }),
      });
      assert.equal(res.status, 201, `角色 ${role} 无门槛注册`);
      const body = (await res.json()) as { agent: Agent; token: string };
      assert.equal(body.agent.role, role);
      assert.ok(body.token.startsWith('ah_'));
    }
  } finally {
    rig.cleanup();
  }
});

test('技能分发：GET /skill/asterhive-worker 返回技能全文，未知技能 404', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const res = await app.request('/skill/asterhive-worker');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    const text = await res.text();
    assert.ok(text.includes('asterhive-worker'), '含技能名');
    assert.ok(text.includes('工作循环'), '含协议章节');

    const miss = await app.request('/skill/nope');
    assert.equal(miss.status, 404);
  } finally {
    rig.cleanup();
  }
});

test('按自举指引下载的独立 CLI 能直接运行并注册，无需仓库或第三方依赖', async () => {
  const rig = mkRig();
  const server = serve({ fetch: createApp(rig.ctx).fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const guide = await (await fetch(base + '/bootstrap/')).text();
    const client = join(rig.ctx.cfg.dataDir, 'standalone-client');
    mkdirSync(client);
    for (const [, name, url] of guide.matchAll(/^curl -fLo (\S+) (\S+)$/gm)) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      writeFileSync(join(client, name), await response.text());
    }
    const child = spawn(process.execPath, [join(client, 'cli.ts'), 'register', '--url', base, '--handle', 'standalone-bootstrap'], {
      cwd: client, windowsHide: true, signal: AbortSignal.timeout(15000),
      env: { ...process.env, HOME: client, USERPROFILE: client },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    const [exitCode] = await once(child, 'exit');
    assert.equal(exitCode, 0, stderr);
    const config = JSON.parse(readFileSync(join(client, '.asterhive', 'worker.json'), 'utf8'));
    const profile = await fetch(base + '/agents/me/profile', { headers: { authorization: `Bearer ${config.token}` } });
    assert.equal(profile.status, 200);
    const registered = findAgent(rig.ctx, 'standalone-bootstrap');
    assert.ok(registered);
    assert.equal((await profile.json()).agentId, registered.id);
    assert.equal((await fetch(base + '/bootstrap/not-public.ts')).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rig.cleanup();
  }
});

test('托管脚本与源码分发：/scripts/ 动态注入当前服务器 origin，worker.tar.gz 返回二进制，未知文件 404', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);

    // 请求 install-bee.ps1：动态替换 __HIVE_URL_PLACEHOLDER__ 为请求的 origin
    const ps = await app.request('http://hive.local:8067/scripts/install-bee.ps1');
    assert.equal(ps.status, 200);
    assert.match(ps.headers.get('content-type') ?? '', /text\/plain/);
    const psText = await ps.text();
    assert.ok(psText.includes('http://hive.local:8067'), '已注入请求的 origin 地址');
    assert.ok(!psText.includes('__HIVE_URL_PLACEHOLDER__'), '占位符已被完全替换');

    // 请求 install-bee.sh：同样替换
    const sh = await app.request('http://hive.local:8067/scripts/install-bee.sh');
    assert.equal(sh.status, 200);
    const shText = await sh.text();
    assert.ok(shText.includes('http://hive.local:8067'), '已注入请求的 origin 地址');
    assert.ok(!shText.includes('__HIVE_URL_PLACEHOLDER__'), '占位符已被完全替换');

    // worker.tar.gz 二进制流
    const gz = await app.request('/scripts/worker.tar.gz');
    assert.equal(gz.status, 200);
    assert.equal(gz.headers.get('content-type'), 'application/gzip');
    const buf = await gz.arrayBuffer();
    assert.ok(buf.byteLength > 1024, '工蜂源码 tarball 大小正常');

    // 未知脚本 404
    const miss = await app.request('/scripts/evil.sh');
    assert.equal(miss.status, 404);
  } finally {
    rig.cleanup();
  }
});
