import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Worker, registerWithRetry } from '@asterhive/sdk';
import { persistRegisteredIdentity, restoreIdentity } from '../../../packages/sdk/src/cli.ts';

// 多身份归档（身份粒度 = 设备 × 执行内核）：worker.json = 活跃身份，identities/<handle>.json = 同构归档。
// 同机 omp/zcode 各自独立身份：register 顶掉旧身份前先原样归档（绝不丢失），use <handle> 随时切回。
// 归档/恢复核心函数（cli.ts 导出）用临时目录直测；register / use 真实分支走子进程冒烟——
// USERPROFILE/HOME 指向临时家目录隔离真实 ~/.asterhive，register 的 HTTP 响应由本文件内 stub 服务器控制。
// 注意布局：CLI 的配置根是 <家目录>/.asterhive，帮助函数以 configDir 参数化——两者统一指向同一路径。

const CLI_PATH = fileURLToPath(new URL('../../../packages/sdk/src/cli.ts', import.meta.url));

interface WorkerConfig {
  url?: string;
  token?: string;
  handle?: string;
  board?: string;
}

// ---- 脚手架：临时家目录 + 配置根（<家目录>/.asterhive）+ 文件预置 ----

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'asterhive-ident-'));
}

// CLI 子进程以 homedir()/.asterhive 为配置根；帮助函数测试注入同一路径，布局与真实环境一致
function configHome(home: string): string {
  return join(home, '.asterhive');
}

function seedJson(path: string, content: WorkerConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

function readJson(path: string): WorkerConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as WorkerConfig;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

// ---- fetch stub：registerWithRetry 走全局 fetch（用完必须 restore），照 onboarding 既有风格 ----

function stubFetch(status: number, body: Record<string, unknown>): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: status < 400,
    status,
    statusText: 'STUB',
    json: async () => body,
  })) as unknown as typeof fetch;
  return { restore: () => (globalThis.fetch = original) };
}

// ---- persistRegisteredIdentity：register 分支的落盘编排（活跃 worker.json + identities 归档）----

test('register 归档: 旧身份 handle-a 被顶替 → 原样归档绝不丢失，新身份活跃/归档双写', async () => {
  const home = tempHome();
  const dir = configHome(home);
  const oldCfg: WorkerConfig = { url: 'http://old:8067', token: 'tok-old', handle: 'handle-a', board: 'b1' };
  seedJson(join(dir, 'worker.json'), oldCfg);
  const { restore } = stubFetch(200, { agent: { id: 'handle-b', handle: 'handle-b' }, token: 'tok-new' });
  try {
    const r = await registerWithRetry(new Worker('http://stub'), { name: 'B@x', handle: 'handle-b', host: 'x' });
    const next = persistRegisteredIdentity(dir, oldCfg, { url: 'http://new:8067', token: r.token, handle: r.handle });

    // 旧身份归档：内容与原 worker.json 逐字段一致（旧 token/board 原样保留，绝不变动他人档案）
    const archivedOld = readJson(join(dir, 'identities', 'handle-a.json'));
    assert.deepEqual(archivedOld, oldCfg);
    // 新身份：活跃 worker.json 与 identities/handle-b.json 一致，token/handle 换新
    assert.deepEqual(next, { url: 'http://new:8067', token: 'tok-new', handle: 'handle-b', board: 'b1' });
    assert.deepEqual(readJson(join(dir, 'worker.json')), next);
    assert.deepEqual(readJson(join(dir, 'identities', 'handle-b.json')), next);
  } finally {
    restore();
    cleanup(home);
  }
});

test('register 归档: 首次注册（无 worker.json）→ 只写活跃与新归档，不产生旧归档', () => {
  const home = tempHome();
  const dir = configHome(home);
  try {
    const next = persistRegisteredIdentity(dir, {}, { url: 'http://u', token: 'tok-1', handle: 'handle-x' });
    assert.deepEqual(readJson(join(dir, 'worker.json')), { url: 'http://u', token: 'tok-1', handle: 'handle-x' });
    assert.deepEqual(readJson(join(dir, 'identities', 'handle-x.json')), next);
    assert.deepEqual(readdirSync(join(dir, 'identities')), ['handle-x.json']);
  } finally {
    cleanup(home);
  }
});

test('register 归档: 同 handle 重注册 → 不产生重复归档错误，归档内容更新为最新', () => {
  const home = tempHome();
  const dir = configHome(home);
  try {
    // 先落一份旧档（上次注册的归档）
    persistRegisteredIdentity(dir, {}, { url: 'http://u1', token: 'tok-1', handle: 'handle-a' });
    // 同 handle 再注册：活跃被覆盖，归档同名覆盖（以最新为准），全程不抛错
    const next = persistRegisteredIdentity(
      dir,
      { url: 'http://u1', token: 'tok-1', handle: 'handle-a' },
      { url: 'http://u2', token: 'tok-2', handle: 'handle-a' },
    );
    assert.deepEqual(readJson(join(dir, 'worker.json')), next);
    assert.deepEqual(readJson(join(dir, 'identities', 'handle-a.json')), next);
    assert.equal(readJson(join(dir, 'identities', 'handle-a.json')).token, 'tok-2');
    assert.deepEqual(readdirSync(join(dir, 'identities')), ['handle-a.json']);
  } finally {
    cleanup(home);
  }
});

test('register 归档: 磁盘异常（identities 建不出来）→ 打印警告继续，活跃身份照常写入', () => {
  const home = tempHome();
  const dir = configHome(home);
  try {
    // 把 identities 路径占成一个普通文件：归档 mkdir 必失败，但注册流程不能崩
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identities'), 'not a dir', 'utf8');
    seedJson(join(dir, 'worker.json'), { url: 'http://old', token: 'tok-old', handle: 'handle-a' });
    const next = persistRegisteredIdentity(
      dir,
      { url: 'http://old', token: 'tok-old', handle: 'handle-a' },
      { url: 'http://new', token: 'tok-new', handle: 'handle-b' },
    );
    assert.deepEqual(readJson(join(dir, 'worker.json')), next, '活跃身份仍写入成功');
    assert.equal(existsSync(join(dir, 'identities', 'handle-b.json')), false, '归档失败只警告，不产生半截文件');
  } finally {
    cleanup(home);
  }
});

// ---- restoreIdentity：use 命令核心（归档 → 活跃）----

test('use 恢复: 从 identities/<handle>.json 恢复活跃身份；未知 handle 报错并列出可选', () => {
  const home = tempHome();
  const dir = configHome(home);
  try {
    const cfgA: WorkerConfig = { url: 'http://old', token: 'tok-a', handle: 'handle-a', board: 'b1' };
    const cfgB: WorkerConfig = { url: 'http://new', token: 'tok-b', handle: 'handle-b' };
    seedJson(join(dir, 'identities', 'handle-a.json'), cfgA);
    seedJson(join(dir, 'identities', 'handle-b.json'), cfgB);
    seedJson(join(dir, 'worker.json'), cfgB); // 当前活跃是 handle-b

    const restored = restoreIdentity(dir, 'handle-a');
    assert.deepEqual(restored, cfgA, '返回恢复出的身份');
    assert.deepEqual(readJson(join(dir, 'worker.json')), cfgA, 'worker.json 已切回 handle-a');

    // 未知识柄：报错信息列出归档里的可选身份（字典序）
    assert.throws(() => restoreIdentity(dir, 'nope'), /可选：handle-a、handle-b/);
  } finally {
    cleanup(home);
  }
});

test('use 恢复: 归档损坏或缺 url/token → 拒绝恢复，活跃身份不被破坏', () => {
  const home = tempHome();
  const dir = configHome(home);
  try {
    const active: WorkerConfig = { url: 'http://u', token: 'tok-b', handle: 'handle-b' };
    seedJson(join(dir, 'worker.json'), active);
    mkdirSync(join(dir, 'identities'), { recursive: true });
    writeFileSync(join(dir, 'identities', 'broken.json'), '{oops', 'utf8');
    seedJson(join(dir, 'identities', 'incomplete.json'), { url: 'http://u', handle: 'incomplete' });

    assert.throws(() => restoreIdentity(dir, 'broken'), /损坏/);
    assert.throws(() => restoreIdentity(dir, 'incomplete'), /缺 url\/token/);
    assert.deepEqual(readJson(join(dir, 'worker.json')), active, '失败的恢复不留副作用');
  } finally {
    cleanup(home);
  }
});

// ---- CLI 冒烟（子进程，USERPROFILE/HOME 指向临时家目录）：真实 register / use 分支 ----

function startRegisterStub(token: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const input = JSON.parse(raw || '{}') as { handle?: string };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agent: { id: input.handle, handle: input.handle }, token }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// 跑一次 CLI 子进程（USERPROFILE/HOME 覆盖后 homedir()/.asterhive 即临时配置根）。
// 必须用异步 spawn：stub 服务器与本测试同进程，spawnSync 会阻塞事件循环导致
// stub 无法应答子进程的 fetch（父子互相等待的死锁）；30s 杀计时器防子进程异常挂起。
function runCli(args: string[], home: string): Promise<{ status: number; stdout: string; stderr: string }> {
  // Windows 用 USERPROFILE、POSIX 用 HOME，两个都覆盖，homedir() 即指向临时家目录
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr });
    });
  });
}

test('CLI 冒烟 register: 旧身份归档落盘、活跃切到新身份、stderr 说明归档去向', async () => {
  const home = tempHome();
  const dir = configHome(home);
  const oldCfg: WorkerConfig = { url: 'http://old:8067', token: 'tok-old', handle: 'handle-a', board: 'b1' };
  seedJson(join(dir, 'worker.json'), oldCfg);
  const stub = await startRegisterStub('tok-new');
  try {
    const r = await runCli(['register', '--url', stub.url], home);
    assert.equal(r.status, 0, `register 应成功：${r.stderr}`);

    // stdout 单行 JSON 契约：注册响应（handle 由 stub 原样回显）
    const registered = JSON.parse(r.stdout.trim()) as { handle: string; token: string };
    assert.equal(registered.token, 'tok-new');
    // stderr 提示：旧身份已归档 + 当前活跃身份
    assert.match(r.stderr, /已归档旧身份 handle-a/);
    assert.match(r.stderr, new RegExp(`当前活跃身份 = ${registered.handle}`));

    // 磁盘三处落位：旧档原样保留、新档与活跃一致
    assert.deepEqual(readJson(join(dir, 'identities', 'handle-a.json')), oldCfg);
    const active = readJson(join(dir, 'worker.json'));
    assert.equal(active.handle, registered.handle);
    assert.equal(active.token, 'tok-new');
    assert.equal(active.board, 'b1', 'board 沿用旧配置');
    assert.deepEqual(readJson(join(dir, 'identities', `${registered.handle}.json`)), active);
  } finally {
    stub.close();
    cleanup(home);
  }
});

test('CLI 冒烟 use: 归档恢复为活跃身份；未知 handle 退出码 1 且错误列出可选', async () => {
  const home = tempHome();
  const dir = configHome(home);
  try {
    const cfgA: WorkerConfig = { url: 'http://old', token: 'tok-a', handle: 'handle-a', board: 'b1' };
    seedJson(join(dir, 'identities', 'handle-a.json'), cfgA);
    seedJson(join(dir, 'worker.json'), { url: 'http://new', token: 'tok-b', handle: 'handle-b' });

    const ok = await runCli(['use', 'handle-a'], home);
    assert.equal(ok.status, 0, `use 应成功：${ok.stderr}`);
    assert.deepEqual(JSON.parse(ok.stdout.trim()), cfgA, 'stdout 单行 JSON = 恢复出的身份');
    assert.deepEqual(readJson(join(dir, 'worker.json')), cfgA);

    const miss = await runCli(['use', 'nope'], home);
    assert.equal(miss.status, 1);
    const err = JSON.parse(miss.stdout.trim()) as { error: string };
    assert.match(err.error, /不存在身份 "nope"/);
    assert.match(err.error, /可选：handle-a/);
  } finally {
    cleanup(home);
  }
});
