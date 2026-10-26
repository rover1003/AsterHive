import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { createBoard } from '../src/tasks.ts';
import { listMessages } from '../src/messages.ts';
import { listEvents } from '../src/write.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

test('Phase 8 Webhook: Chat-to-Card JSON 格式多端派活与来源标记', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-mobile', name: 'Mobile Dispatch Board' });
    const app = createApp(rig.ctx);

    const res = await app.request('/api/webhooks/chat-to-card', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({
        boardId: 'b-mobile',
        source: 'iOS-Shortcut',
        author: '老板 (手机)',
        content: '紧急：排查登录验证码偶发超时问题',
      }),
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { ok: boolean; boardId: string; message: { id: number; content: string } };
    assert.equal(data.ok, true);
    assert.equal(data.boardId, 'b-mobile');
    assert.ok(data.message.content.includes('[来自 iOS-Shortcut] 紧急：排查登录验证码偶发超时问题'));

    // 检查聊天室消息落库
    const msgs = listMessages(rig.ctx, 'b-mobile');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].author, '老板 (手机)');
    assert.equal(msgs[0].kind, 'intervention');

    // 检查事件台账记录
    const events = listEvents(rig.ctx);
    const whEvent = events.find((e) => e.type === 'webhook.chat_to_card');
    assert.ok(whEvent, 'webhook.chat_to_card 入审计台账');
  } finally {
    rig.cleanup();
  }
});

test('Phase 8 Webhook: 纯文本 body 与自动路由默认看板', async () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'b-default', name: 'Default Board' });
    const app = createApp(rig.ctx);

    // 快捷指令直接以 text/plain 发送，带 x-source 自定义头
    const res = await app.request('/api/webhooks/chat-to-card', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-source': 'Feishu-Bot',
      },
      body: '请为新功能编写立项路线图',
    });
    assert.equal(res.status, 201);
    const data = (await res.json()) as { ok: boolean; boardId: string; message: { content: string } };
    assert.equal(data.ok, true);
    assert.equal(data.boardId, 'b-default', '自动路由至第一可用看板');
    assert.ok(data.message.content.includes('[来自 Feishu-Bot] 请为新功能编写立项路线图'));
  } finally {
    rig.cleanup();
  }
});

test('Phase 8 Webhook: 空内容与无可用看板校验边界', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);

    // 1. 无可用看板时报错
    const noBoardRes = await app.request('/api/webhooks/chat-to-card', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ content: '测试内容' }),
    });
    assert.equal(noBoardRes.status, 404);

    createBoard(rig.ctx, { id: 'b-empty', name: 'Empty Test' });

    // 2. 空内容报错 422
    const emptyRes = await app.request('/api/webhooks/chat-to-card', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({ boardId: 'b-empty', content: '   ' }),
    });
    assert.equal(emptyRes.status, 422);
  } finally {
    rig.cleanup();
  }
});
