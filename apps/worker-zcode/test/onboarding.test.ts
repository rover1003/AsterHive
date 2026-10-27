import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkError, Worker, defaultWorkerIdentity, registerWithRetry } from '@asterhive/sdk';
import { firstSkip, nextBoardsToPoll, BOARD_REFRESH_MS } from '../src/polling.ts';

// 接入极简化：默认身份规则（sdk）、注册 409 冲突自愈（sdk，fetch stub 可控 409 序列）、
// 多板巡检状态决策（polling.ts 纯函数）。命令编排薄壳（cli.ts / main.ts）不在此测。

// ---- fetch stub：Worker.call 走全局 fetch，替换后可控响应序列（用完必须 restore）----

interface StubResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<Record<string, unknown>>;
}

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(responses: StubResponse[]): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    const resp = responses[Math.min(requests.length, responses.length - 1)];
    requests.push({ url: String(url), body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    return resp;
  }) as unknown as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = original) };
}

function res(status: number, body: Record<string, unknown>): StubResponse {
  return { ok: status < 400, status, statusText: 'STUB', json: async () => body };
}

// ---- defaultWorkerIdentity：默认身份规则 ----

test('默认身份: 常规主机名 → worker- + 小写去符号前 8 位', () => {
  const id = defaultWorkerIdentity('DESKTOP-ABC123');
  assert.equal(id.handle, 'worker-desktopa'); // desktop-abc123 → desktopabc123 → 前 8 位
  assert.equal(id.name, 'Worker@DESKTOP-ABC123');
});

test('默认身份: 含中文/大写 → 非 [a-z0-9] 全剥除；超长截 8 位', () => {
  assert.equal(defaultWorkerIdentity('张三-PC').handle, 'worker-pc');
  assert.equal(defaultWorkerIdentity('My-Work-Station-01').handle, 'worker-myworkst'); // 前 8 位截断
  // 显示名截 32 字符
  const long = 'x'.repeat(50);
  assert.equal(defaultWorkerIdentity(long).name.length, 'Worker@'.length + 32);
});

test('默认身份: 空串 → 剥完为空用 node 兜底', () => {
  const id = defaultWorkerIdentity('');
  assert.equal(id.handle, 'worker-node');
  assert.equal(id.name, 'Worker@');
});

// ---- registerWithRetry：409 冲突自愈 ----

test('注册自愈: 首试成功 → 原句柄原样返回，只发一次请求', async () => {
  const { requests, restore } = stubFetch([
    res(200, { agent: { id: 'worker-x', handle: 'worker-x' }, token: 'tok-1' }),
  ]);
  try {
    const w = new Worker('http://stub');
    const r = await registerWithRetry(w, { name: 'Worker@x', handle: 'worker-x', models: ['m1'], host: 'x' });
    assert.equal(r.handle, 'worker-x');
    assert.equal(r.token, 'tok-1');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://stub/agents/register');
    assert.deepEqual(requests[0].body, { name: 'Worker@x', handle: 'worker-x', models: ['m1'], host: 'x' });
  } finally {
    restore();
  }
});

test('注册自愈: 撞一次 409 → 句柄自动加 -2 重试成功', async () => {
  const { requests, restore } = stubFetch([
    res(409, { error: 'agent id or handle already exists: worker-x/worker-x' }),
    res(200, { agent: { id: 'worker-x-2', handle: 'worker-x-2' }, token: 'tok-2' }),
  ]);
  try {
    const r = await registerWithRetry(new Worker('http://stub'), { name: 'n', handle: 'worker-x' });
    assert.equal(r.handle, 'worker-x-2'); // 与传入不同即发生了自动改名，调用方可据此提示
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.handle, 'worker-x-2'); // 第二次请求带后缀句柄
    assert.equal(requests[1].body.name, 'n'); // 显示名不变
  } finally {
    restore();
  }
});

test('注册自愈: 连续 5 次 409 → 抛错（句柄与 -2…-5 全试尽）', async () => {
  const conflict = res(409, { error: 'agent id or handle already exists' });
  const { requests, restore } = stubFetch([conflict, conflict, conflict, conflict, conflict, conflict]);
  try {
    await assert.rejects(
      registerWithRetry(new Worker('http://stub'), { name: 'n', handle: 'worker-x' }),
      /已被占用/,
    );
    assert.equal(requests.length, 5); // 最多共试 5 次：原句柄 + 后缀 -2…-5
    assert.equal(requests[4].body.handle, 'worker-x-5');
  } finally {
    restore();
  }
});

test('注册自愈: 非 409 错误原样上抛，不重试', async () => {
  const { requests, restore } = stubFetch([res(500, { error: 'boom' })]);
  try {
    await assert.rejects(
      registerWithRetry(new Worker('http://stub'), { name: 'n', handle: 'worker-x' }),
      (err: unknown) => err instanceof SdkError && err.status === 500,
    );
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

// ---- 多板巡检状态决策（polling.ts 纯函数）----

test('多板巡检: 显式绑板 → 只巡检该板且永不刷新清单（兼容旧单板模式）', () => {
  const d = nextBoardsToPoll(['b1', 'b2'], { explicitBoard: 'b2', now: 1000, lastRefresh: 0 });
  assert.deepEqual(d.poll, ['b2']);
  assert.equal(d.refreshDue, false);
});

test('多板巡检: 首轮（lastRefresh=0）必须先拉板清单', () => {
  const d = nextBoardsToPoll([], { now: 5 * 60_000 - 1, lastRefresh: 0 });
  assert.deepEqual(d.poll, []);
  assert.equal(d.refreshDue, true);
});

test('多板巡检: 刷新窗口内不刷新、返回全部已知板（副本）', () => {
  const boards = ['b1', 'b2', 'b3'];
  const d = nextBoardsToPoll(boards, { now: 60_000, lastRefresh: 1, refreshMs: 5 * 60_000 });
  assert.equal(d.refreshDue, false);
  assert.deepEqual(d.poll, boards);
  assert.notEqual(d.poll, boards); // 副本：编排层改动不影响已知清单
});

test('多板巡检: 超过刷新周期 → 到点刷新（自定义周期同样生效）', () => {
  const REF = BOARD_REFRESH_MS;
  assert.equal(nextBoardsToPoll(['b1'], { now: REF + 1, lastRefresh: 1 }).refreshDue, true); // 恰好一个周期
  assert.equal(nextBoardsToPoll(['b1'], { now: REF, lastRefresh: 1 }).refreshDue, false); // 差 1ms 不刷
  assert.equal(nextBoardsToPoll(['b1'], { now: 1001, lastRefresh: 1, refreshMs: 1000 }).refreshDue, true);
});

test('多板巡检: firstSkip 同板只首次返回 true（日志防刷屏）', () => {
  const skipped = new Set<string>();
  assert.equal(firstSkip(skipped, 'b1'), true);
  assert.equal(firstSkip(skipped, 'b1'), false);
  assert.equal(firstSkip(skipped, 'b1'), false);
  assert.equal(firstSkip(skipped, 'b2'), true);
  assert.deepEqual([...skipped].sort(), ['b1', 'b2']);
});
