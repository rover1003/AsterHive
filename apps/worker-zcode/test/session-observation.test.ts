import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPiPrompt } from '../src/pi-executor.ts';
import { createSessionObserver } from '../src/session-observer.ts';
import type { SessionObservationEvent } from '../src/sdk.ts';

test('real Pi observation filters split credentials, reasoning and tool/file content before delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-session-observation-'));
  const privateText = 'PRIVATE_FILE_BODY_MUST_NOT_BE_SHARED';
  writeFileSync(join(root, 'fixture.txt'), privateText);
  let calls = 0;
  let toolResultReceived = false;
  const delivered: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString());
    calls++;
    toolResultReceived ||= body.messages.some((message: { role: string }) => message.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: object, finishReason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `chat-${calls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'isolated-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    send({ role: 'assistant' });
    if (calls === 1) {
      send({ tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'fixture.txt' }) } }] });
      send({}, 'tool_calls');
    } else {
      send({ reasoning_content: 'HIDDEN_REASONING_MUST_NOT_BE_SHARED' });
      for (const content of ['Visible status\n', 'api_', 'key=sk-', 'split-secret-123456789\n', '```text\n', privateText, '\n```\n', 'Done safely.']) send({ content });
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const options = {
      cwd: root, agentDir: join(root, 'agent'), skillsDir: join(root, 'skills'),
      prompt: 'Read fixture.txt once, then report completion.', timeoutMs: 15000, log: () => {},
      config: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'isolated-observation-key', model: 'isolated-model', thinkingLevel: 'low' as const },
      onSessionEvent: (event: Record<string, unknown>) => { delivered.push(event); },
      observeSession: () => true,
      observationSecrets: ['isolated-observation-key'],
    };
    const result = await runPiPrompt(options);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(toolResultReceived, true, 'the SDK must really execute the read tool and return its result');
    const serialized = JSON.stringify(delivered);
    assert.match(serialized, /Visible status/);
    assert.match(serialized, /Done safely/);
    assert.doesNotMatch(serialized, /HIDDEN_REASONING|PRIVATE_FILE_BODY|split-secret-123456789|isolated-observation-key/);
    assert.ok(delivered.some(event => event.kind === 'tool_start'));
    assert.ok(delivered.some(event => event.kind === 'tool_end'));
    assert.ok(delivered.some(event => event.kind === 'redacted'));
    delivered.length = 0;
    await runPiPrompt({ ...options, observeSession: undefined, agentDir: join(root, 'disabled-agent') });
    assert.deepEqual(delivered, [], 'session observation is opt-in even when a callback exists');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('user cancellation aborts the real model stream and waits for Pi prompt settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hive-pi-cancel-'));
  const controller = new AbortController();
  let notifyRequest!: () => void;
  const receivedRequest = new Promise<void>(resolve => { notifyRequest = resolve; });
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'cancel-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
    notifyRequest();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const options = {
      cwd: root, agentDir: join(root, 'agent'), skillsDir: join(root, 'skills'),
      prompt: 'Wait for a reply.', timeoutMs: 1500, log: () => {},
      config: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'isolated-cancel-key', model: 'isolated-model', thinkingLevel: 'low' as const },
      signal: controller.signal,
    };
    const result = runPiPrompt(options);
    await receivedRequest;
    controller.abort();
    const ended = await result;
    assert.equal(ended.code, -2);
    assert.match(ended.stdout, /取消/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

function observerFixture() {
  const delivered: Omit<SessionObservationEvent, 'sequence'>[] = [];
  let enabled = true;
  const observe = createSessionObserver({ enabled: () => enabled, secrets: [], emit: event => { delivered.push(event); } });
  return {
    begin: () => observe({ type: 'message_start', message: { role: 'assistant' } }),
    text: (delta: string, contentIndex = 0) => observe({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta, contentIndex } }),
    endBlock: (contentIndex: number) => observe({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex } }),
    end: () => observe({ type: 'message_end', message: { role: 'assistant' } }),
    setEnabled: (value: boolean) => { enabled = value; },
    visible: () => delivered.filter(event => event.kind === 'assistant_text').map(event => event.text).join(''),
  };
}

test('session observation hides tilde fences and does not close a longer fence with a shorter delimiter', () => {
  for (const source of [
    'safe-before\n~~~ts\nPRIVATE_TILDE_BODY\n~~~\nsafe-after\n',
    'safe-before\n````ts\nPRIVATE_LONG_FENCE\n```\nPRIVATE_SHORT_CLOSING\n````\nsafe-after\n',
  ]) {
    const fixture = observerFixture();
    fixture.begin(); fixture.text(source); fixture.end();
    assert.match(fixture.visible(), /safe-before/);
    assert.match(fixture.visible(), /safe-after/);
    assert.doesNotMatch(fixture.visible(), /PRIVATE_/);
  }
});

test('session observation suppresses multiline sensitive values through the message boundary', () => {
  for (const source of [
    'safe-before\npassword:\nopaque-demo-credential-739204\n',
    'safe-before\nAuthorization:\nBearer\nopaque-demo-credential-739204\n',
    'safe-before\nBearer\nopaque-demo-credential-739204\n',
  ]) {
    const fixture = observerFixture();
    fixture.begin(); fixture.text(source); fixture.end();
    fixture.begin(); fixture.text('safe-new-message\n'); fixture.end();
    assert.match(fixture.visible(), /safe-before/);
    assert.match(fixture.visible(), /safe-new-message/);
    assert.doesNotMatch(fixture.visible(), /opaque-demo-credential/);
  }
});

test('overflowed fence lines do not expose following private code', () => {
  const fixture = observerFixture();
  fixture.begin();
  fixture.text('safe-before\n```' + 'x'.repeat(2100) + '\nPRIVATE_AFTER_OVERFLOW\n```\n');
  fixture.end();
  fixture.begin(); fixture.text('safe-new-message\n'); fixture.end();
  assert.match(fixture.visible(), /safe-before/);
  assert.match(fixture.visible(), /safe-new-message/);
  assert.doesNotMatch(fixture.visible(), /PRIVATE_AFTER_OVERFLOW/);
});

test('enabling observation inside an existing code block stays hidden until a new assistant message', () => {
  const fixture = observerFixture();
  fixture.begin(); fixture.text('safe-before\n```ts\n');
  fixture.setEnabled(false); fixture.text('hidden while disabled\n');
  fixture.setEnabled(true); fixture.text('PRIVATE_AFTER_RESUME\n```\n');
  fixture.end();
  fixture.begin(); fixture.text('safe-new-message\n'); fixture.end();
  assert.match(fixture.visible(), /safe-before/);
  assert.match(fixture.visible(), /safe-new-message/);
  assert.doesNotMatch(fixture.visible(), /PRIVATE_AFTER_RESUME/);
});

test('sensitive labels pending in one content block cannot expose a value in another block', () => {
  const fixture = observerFixture();
  fixture.begin();
  fixture.text('password:', 0);
  fixture.text('opaque-other-block-credential\n', 1);
  fixture.end();
  assert.doesNotMatch(fixture.visible(), /opaque-other-block-credential/);
});

test('completed public text blocks remain visible without requiring a newline', () => {
  const fixture = observerFixture();
  fixture.begin();
  fixture.text('public-first-block', 0);
  fixture.endBlock(0);
  fixture.text('public-second-block\n', 1);
  fixture.end();
  assert.equal(fixture.visible(), 'public-first-blockpublic-second-block\n');
});
