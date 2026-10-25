import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent } from '../src/agents.ts';

// 乱码防护：坏编码客户端（Windows GBK 控制台等）产生的 U+FFFD 输入一律 422 拒收
test('编码防护：含替换符的注册名/句柄/消息内容拒收', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);

    let res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '部署验证\uFFFD蜂', handle: 'bee-gbk' }),
    });
    assert.equal(res.status, 422, '乱码 name 拒收');

    res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '正常蜂', handle: 'bee-\uFFFD' }),
    });
    assert.equal(res.status, 422, '乱码 handle 拒收');

    // 正常 UTF-8 中文不受影响
    res = await app.request('/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '正常中文蜂', handle: 'bee-ok' }),
    });
    assert.equal(res.status, 201, '正常中文注册放行');

    // 建板后乱码消息内容拒收（注册自由化：orchestrator 直接注册，无需管理令牌）
    const orch = registerAgent(rig.ctx, { name: '主脑A', handle: 'brain-a', role: 'orchestrator' });
    const H = { 'content-type': 'application/json', authorization: `Bearer ${orch.token}` };
    await app.request('/boards', { method: 'POST', headers: H, body: JSON.stringify({ id: 'b', name: '板' }) });
    res = await app.request('/boards/b/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '中文正常消息' }),
    });
    assert.equal(res.status, 201, '正常中文消息放行');

    res = await app.request('/boards/b/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '\uFFFD\uFFFDϢ' }),
    });
    assert.equal(res.status, 422, '乱码消息拒收');
  } finally {
    rig.cleanup();
  }
});

