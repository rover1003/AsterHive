import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';
import { listEvents } from '../src/write.ts';
import { setRuntimeExecutorForTest, restoreRuntimeExecutor, PiRuntimeManager } from '../src/pi-runtime.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// 模拟 npm install --prefix <dir> <spec>：在 dir/node_modules/<pkg> 建一个最小扩展包
function stubNpmInstall(rigCtxDataDir: string) {
  setRuntimeExecutorForTest(async (cmd) => {
    const m = cmd.match(/npm install --prefix "(.+?)" (\S+)/);
    if (!m) return { code: 1, stdout: '', stderr: `unrecognized command: ${cmd}` };
    const [, prefix, spec] = m;
    // 剥版本号：非 scoped 在最后一个 @ 处切；scoped（@scope/name@ver）保留前导 @，在最后一个 @（非首字符）处切
    const lastAt = spec.lastIndexOf('@');
    const pkgName = lastAt > 0 ? spec.slice(0, lastAt) : spec;
    const segs = pkgName.split('/');
    const dir = join(prefix, 'node_modules', ...segs);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0' }), 'utf8');
    writeFileSync(join(dir, 'index.js'), 'export const activate = () => ({});\n', 'utf8');
    return { code: 0, stdout: `added 1 package (${spec})`, stderr: '' };
  });
}

test('T17 扩展管理: npm 安装、列表、启停过滤与删除（领域层 + 事件落账）', async () => {
  const rig = mkRig();
  try {
    stubNpmInstall(rig.ctx.cfg.dataDir);
    const rt = new PiRuntimeManager(rig.ctx);
    rt.ensureMountDirs();

    // 1. npm 安装扩展
    const { name } = await rt.installExtension('@community/billion-context', '2.0.1');
    assert.equal(name, '@community/billion-context');
    assert.ok(existsSync(join(rt.extensionsDir, 'node_modules', '@community', 'billion-context', 'index.js')));

    // 2. 列表：npm 来源 + 启用
    let list = rt.listExtensions();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '@community/billion-context');
    assert.equal(list[0].enabled, true);
    assert.equal(list[0].source, 'npm');

    // 3. enabledExtensionPaths 返回其路径；停用后不再返回
    const absPath = join(rt.extensionsDir, 'node_modules', '@community', 'billion-context');
    assert.deepEqual(rt.enabledExtensionPaths(), [absPath]);
    rt.setExtensionEnabled(name, false);
    assert.deepEqual(rt.enabledExtensionPaths(), [], '停用后主脑不再挂载');
    assert.equal(rt.listExtensions()[0].enabled, false);

    // 4. 重新启用 + 删除
    rt.setExtensionEnabled(name, true);
    assert.deepEqual(rt.enabledExtensionPaths(), [absPath]);
    rt.deleteExtension(name);
    assert.ok(!existsSync(absPath), '目录已移除');
    assert.deepEqual(rt.listExtensions(), []);

    // 5. 事件台账
    const events = listEvents(rig.ctx);
    for (const type of ['pi.extension_installed', 'pi.extension_toggled', 'pi.extension_deleted']) {
      assert.ok(events.some((e) => e.type === type), `${type} 落账`);
    }
  } finally {
    restoreRuntimeExecutor();
    rig.cleanup();
  }
});

test('T17 扩展管理: 手工放入的目录默认启用，不受注册表缺失影响', async () => {
  const rig = mkRig();
  try {
    const rt = new PiRuntimeManager(rig.ctx);
    rt.ensureMountDirs();
    const manualDir = join(rt.extensionsDir, 'my-manual-plugin');
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, 'index.js'), 'export default () => ({});\n', 'utf8');

    assert.deepEqual(rt.listExtensions(), [
      { name: 'my-manual-plugin', enabled: true, source: 'manual', installedAt: null },
    ]);
    assert.deepEqual(rt.enabledExtensionPaths(), [manualDir], '手工目录默认启用');
  } finally {
    rig.cleanup();
  }
});

test('T17 技能管理: 写入 SKILL.md、扫描列表、删除与 HTTP 端点权限', async () => {
  const rig = mkRig();
  try {
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen', handle: 'queen-t17', role: 'orchestrator',
    });
    const { agent: worker, token: workerToken } = registerAgent(rig.ctx, { name: 'Bee', handle: 'bee-t17' });
    const rt = new PiRuntimeManager(rig.ctx);
    rt.ensureMountDirs();
    const app = createApp(rig.ctx);

    // 1. 写技能（HTTP）
    const putRes = await app.request('/settings/runtime/skills/deep-review', {
      method: 'PUT',
      headers: H(queenToken),
      body: JSON.stringify({ markdown: '---\nname: deep-review\n---\n# 深度审查技能\n' }),
    });
    assert.equal(putRes.status, 200);
    const written = readFileSync(join(rt.skillsDir, 'deep-review', 'SKILL.md'), 'utf8');
    assert.ok(written.includes('深度审查技能'));

    // 2. 列表（HTTP）
    const listRes = await app.request('/settings/runtime/skills', { headers: H(queenToken) });
    assert.equal(listRes.status, 200);
    const { skills } = (await listRes.json()) as { skills: { name: string }[] };
    assert.ok(skills.some((s) => s.name === 'deep-review'));

    // 3. worker 全部 403
    for (const [method, path] of [
      ['GET', '/settings/runtime/extensions'],
      ['GET', '/settings/runtime/skills'],
    ] as const) {
      const res = await app.request(path, { headers: H(workerToken) });
      assert.equal(res.status, 403, `worker 访问 ${path} 得 403`);
    }
    const wPut = await app.request('/settings/runtime/skills/x', {
      method: 'PUT', headers: H(workerToken), body: JSON.stringify({ markdown: 'x' }),
    });
    assert.equal(wPut.status, 403);

    // 4. 删除技能（HTTP）
    const delRes = await app.request('/settings/runtime/skills/deep-review', {
      method: 'DELETE', headers: H(queenToken),
    });
    assert.equal(delRes.status, 200);
    assert.ok(!existsSync(join(rt.skillsDir, 'deep-review')));

    // 5. 事件落账
    const events = listEvents(rig.ctx);
    assert.ok(events.some((e) => e.type === 'pi.skill_written'));
    assert.ok(events.some((e) => e.type === 'pi.skill_deleted'));
  } finally {
    rig.cleanup();
  }
});

test('T17 扩展管理: HTTP npm 安装（stub 执行器）与非法包名拒绝', async () => {
  const rig = mkRig();
  try {
    stubNpmInstall(rig.ctx.cfg.dataDir);
    const { agent: queen, token: queenToken } = registerAgent(rig.ctx, {
      name: 'Queen', handle: 'queen-t17b', role: 'orchestrator',
    });
    const app = createApp(rig.ctx);

    // 1. 正常安装
    const res = await app.request('/settings/runtime/extensions/install', {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ package: 'pi-ext-demo', version: '1.2.3' }),
    });
    assert.equal(res.status, 201);
    const { name } = (await res.json()) as { name: string };
    assert.equal(name, 'pi-ext-demo');

    // 2. 启停端点
    const toggle = await app.request(`/settings/runtime/extensions/${encodeURIComponent(name)}/enabled`, {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggle.status, 200);

    // 3. 非法包名 → 422
    const bad = await app.request('/settings/runtime/extensions/install', {
      method: 'POST',
      headers: H(queenToken),
      body: JSON.stringify({ package: 'bad name; rm -rf' }),
    });
    assert.equal(bad.status, 422);
  } finally {
    restoreRuntimeExecutor();
    rig.cleanup();
  }
});
