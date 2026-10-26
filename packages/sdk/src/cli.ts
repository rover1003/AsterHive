#!/usr/bin/env node
// AsterHive worker CLI：桌面会话型 agent 的唯一入口（零依赖，Node ≥ 23.6 原生运行 TS）。
// 身份配置持久化在 ~/.asterhive/worker.json：{ url, token, handle, board }——它永远是"当前活跃身份"；
// 另有 ~/.asterhive/identities/<handle>.json 多身份归档（与 worker.json 同构）：
// 身份粒度 = 设备 × 执行内核，同机 omp/zcode 各自独立身份（omp-imac / zcode-imac），
// 注册新身份时被顶掉的旧身份自动归档（绝不丢失），`use <handle>` 随时切回。
// 约定：所有子命令输出单行紧凑 JSON——成功输出响应数据，失败输出 {"error": ...} 且退出码 1。
// HTTP 全部复用 @asterhive/sdk 的 Worker 类，这里只做参数解析与配置读写。
import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Worker, defaultWorkerIdentity, registerWithRetry, SdkError } from './index.ts';

interface WorkerConfig {
  url?: string;
  token?: string;
  handle?: string;
  board?: string;
}

const CONFIG_DIR = join(homedir(), '.asterhive');
const CONFIG_PATH = join(CONFIG_DIR, 'worker.json');

function readConfig(): WorkerConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as WorkerConfig;
  } catch (err) {
    throw new Error(`配置文件损坏（${CONFIG_PATH}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

// configDir 参数化（默认真实目录）：测试可注入临时目录，不碰真实 ~/.asterhive
function writeConfig(configDir: string, cfg: WorkerConfig): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'worker.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

// ---- 多身份归档（身份粒度 = 设备 × 执行内核）----
// worker.json = 当前活跃身份；identities/<handle>.json = 同构归档副本。
// omp 与 zcode 同设备必须各用各的身份：注册新身份前先把 worker.json 里的旧身份原样归档，
// 旧身份随时用 `use <handle>` 切回。归档函数全部 try/catch 包好——磁盘异常只打印警告，
// 绝不挡住注册主流程（归档是保护性动作，不是必要条件）。

// 归档文件路径：identities/<handle>.json
function identityArchivePath(configDir: string, handle: string): string {
  return join(configDir, 'identities', `${handle}.json`);
}

// 把活跃 worker.json 原样复制到 identities/<oldHandle>.json（同 handle 重注册时覆盖为最新内容）。
// 返回是否归档成功；worker.json 不存在 → 无可归档，返回 false。
function archiveCurrentIdentity(configDir: string, oldHandle: string): boolean {
  try {
    const activePath = join(configDir, 'worker.json');
    if (!existsSync(activePath)) return false;
    mkdirSync(join(configDir, 'identities'), { recursive: true });
    copyFileSync(activePath, identityArchivePath(configDir, oldHandle));
    return true;
  } catch (err) {
    console.error(
      `警告：归档旧身份 ${oldHandle} 失败（注册继续，旧凭据可能被覆盖）：` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// 把身份写入归档目录（注册成功后与 worker.json 同步留档）；失败只警告不崩。
function writeIdentityArchive(configDir: string, handle: string, cfg: WorkerConfig): void {
  try {
    mkdirSync(join(configDir, 'identities'), { recursive: true });
    writeFileSync(identityArchivePath(configDir, handle), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error(
      `警告：写入身份归档 identities/${handle}.json 失败（不影响活跃身份）：` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// 列出归档中的可选身份（文件名去 .json 后缀，字典序）；目录不存在/不可读 → 空数组
function listArchivedIdentities(configDir: string): string[] {
  try {
    return readdirSync(join(configDir, 'identities'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

// register 分支的落盘编排（导出供测试复用）：
// 1) worker.json 里若是别的身份（别的执行内核的档案）→ 先原样归档到 identities/<旧handle>.json，绝不丢失；
// 2) 新身份写入 worker.json（活跃）与 identities/<新handle>.json（归档），--board 有值则透传。
// 返回写入的活跃配置。
export function persistRegisteredIdentity(
  configDir: string,
  prev: WorkerConfig,
  registered: { url: string; token: string; handle: string },
  board?: string,
): WorkerConfig {
  if (prev.handle && prev.handle !== registered.handle) {
    if (archiveCurrentIdentity(configDir, prev.handle)) {
      // 提示走 stderr：stdout 保持单行 JSON 契约
      console.error(`已归档旧身份 ${prev.handle}（identities/${prev.handle}.json）；当前活跃身份 = ${registered.handle}`);
    }
  }
  const next: WorkerConfig = { ...prev, url: registered.url, token: registered.token, handle: registered.handle };
  if (board !== undefined) next.board = board;
  writeConfig(configDir, next);
  writeIdentityArchive(configDir, registered.handle, next);
  return next;
}

// use 命令核心：从 identities/<handle>.json 恢复活跃身份（原样复制回 worker.json）。
// 归档不存在 → 报错并列出可选身份；归档损坏或缺 url/token → 拒绝恢复（坏档案不能当活跃身份）。
export function restoreIdentity(configDir: string, handle: string): WorkerConfig {
  const path = identityArchivePath(configDir, handle);
  if (!existsSync(path)) {
    const options = listArchivedIdentities(configDir);
    throw new Error(
      `归档中不存在身份 "${handle}"（${path}）` +
        (options.length > 0 ? `；可选：${options.join('、')}` : '（归档目录为空，先 register 才会有归档）'),
    );
  }
  let archived: WorkerConfig;
  try {
    archived = JSON.parse(readFileSync(path, 'utf8')) as WorkerConfig;
  } catch (err) {
    throw new Error(`归档文件损坏（${path}）：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!archived.url || !archived.token) {
    throw new Error(`归档 "${handle}" 缺 url/token，不是可用的完整身份，拒绝恢复`);
  }
  writeConfig(configDir, archived);
  return archived;
}

// 手动解析 argv（零依赖）：--key value / --key=value，位置参数进 rest。
// 值本身以 -- 开头视为"缺值"报错，避免吞掉下一个旗标；需传以 -- 开头的值用 --key=value 写法。
function parseArgs(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 2) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${key} 缺少取值（含 "=" 的写法：--${key}=<值>）`);
    }
    flags[key] = value;
    i++;
  }
  return { flags, rest };
}

function need(flags: Record<string, string>, key: string): string {
  const v = flags[key];
  if (v === undefined || v === '') throw new Error(`缺少 --${key}`);
  return v;
}

function parseFiles(spec: string | undefined): string[] | undefined {
  if (spec === undefined) return undefined;
  const files = spec.split(',').map((s) => s.trim()).filter(Boolean);
  return files.length > 0 ? files : undefined;
}

// evidence 形如 "docs/x.md@机器名,src/y.ts@机器名"（逗号分隔）；@ 后缺省用本机 hostname
function parseEvidence(spec: string | undefined): { path: string; machine: string }[] | undefined {
  if (spec === undefined) return undefined;
  const entries = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return undefined;
  const machine = hostname();
  return entries.map((entry) => {
    const at = entry.lastIndexOf('@');
    return at > 0
      ? { path: entry.slice(0, at), machine: entry.slice(at + 1) || machine }
      : { path: entry, machine };
  });
}

async function createGitBundle(sourcePath: string): Promise<{ dir: string; file: string; bytes: number; sha256: string }> {
  const absolute = resolve(sourcePath);
  if (!isAbsolute(absolute) || !existsSync(absolute)) throw new Error(`项目目录不存在：${absolute}`);
  const root = (await runLocalGit(['rev-parse', '--show-toplevel'], absolute)).trim();
  const dirty = await runLocalGit(['status', '--porcelain', '--untracked-files=all'], root);
  if (dirty.trim()) throw new Error('源 Git 工作树不干净；请先自行处理/提交未提交与未跟踪文件，导入不会修改源目录');
  const temp = mkdtempSync(join(tmpdir(), 'asterhive-import-'));
  const bundle = join(temp, 'project.bundle');
  try {
    await runLocalGit(['bundle', 'create', bundle, '--all'], root);
    await runLocalGit(['bundle', 'verify', bundle], root);
    const stat = statSync(bundle);
    const maxAllowed = Number(process.env.ASTERHIVE_MAX_IMPORT_BYTES ?? 2 * 1024 * 1024 * 1024); // 默认允许至 2GiB
    if (stat.size < 1 || stat.size > maxAllowed) throw new Error(`Git bundle 必须在 1 byte 到 ${maxAllowed / 1024 / 1024} MiB 之间`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(bundle)) hash.update(chunk as Buffer);
    return { dir: temp, file: bundle, bytes: stat.size, sha256: hash.digest('hex') };
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

async function runLocalGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`git ${args[0]} 失败（exit=${code}）：${stderr.slice(-600)}`)));
  });
}

async function uploadBundle(cfg: WorkerConfig, boardId: string, bundle: { file: string; bytes: number; sha256: string }): Promise<unknown> {
  if (!cfg.url || !cfg.token) throw new Error(`尚未配置 worker 身份（${CONFIG_PATH}）：先执行 register`);
  if (!/^[a-z0-9-]{1,120}$/.test(boardId)) throw new Error('看板 id 格式无效');
  const endpoint = new URL(`/boards/${boardId}/repo/import`, cfg.url);
  const transport = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolvePromise, reject) => {
    const req = transport(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(bundle.bytes),
        'x-content-sha256': bundle.sha256,
      },
    }, (res: IncomingMessage) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (body.length < 8000) body += chunk; });
      res.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { parsed = { error: body.slice(0, 500) }; }
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          const status = res.statusCode ?? 500;
          const error = typeof parsed === 'object' && parsed !== null && 'error' in parsed
            ? String((parsed as { error: unknown }).error).slice(0, 300)
            : 'request rejected';
          reject(new Error(`服务器拒绝 Git bundle 导入（HTTP ${status}）：${error}`));
        } else resolvePromise(parsed);
      });
    });
    req.setTimeout(120_000, () => req.destroy(new Error('bundle 上传超时')));
    req.on('error', reject);
    const input = createReadStream(bundle.file);
    input.on('error', (err) => req.destroy(err));
    input.pipe(req);
  });
}

async function importLocalRepository(cfg: WorkerConfig, boardId: string, sourcePath: string): Promise<unknown> {
  const bundle = await createGitBundle(sourcePath);
  try {
    return await uploadBundle(cfg, boardId, bundle);
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
}

function requireWorker(cfg: WorkerConfig): Worker {
  if (!cfg.url || !cfg.token) {
    throw new Error(`尚未配置身份（${CONFIG_PATH}）：先执行 register 或 configure`);
  }
  return new Worker(cfg.url, cfg.token, cfg.handle);
}

function requireBoard(cfg: WorkerConfig, flags: Record<string, string>): string {
  const board = flags.board ?? cfg.board;
  if (!board) throw new Error('未指定看板：用 --board 或先在配置中写入 board');
  return board;
}

async function main(): Promise<void> {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0];
  if (!cmd) {
    throw new Error(
      '用法：cli.ts <configure|register|use|repo import|me|inbox|next|claim|checkpoint|submit|release|message> [参数]\n' +
        'register 只需服务器地址：node cli.ts register --url <服务器>（--name/--handle/--models/--host 可省，缺省由本机主机名自动生成，撞名自动加后缀）\n' +
        'use <handle>：从 identities/<handle>.json 归档恢复活跃身份（同机多内核各自独立身份，互不复用）',
    );
  }
  const cfg = readConfig();

  switch (cmd) {
    case 'repo': {
      const subcommand = rest[1];
      if (subcommand !== 'import') throw new Error('用法：cli.ts repo import --board <看板ID> --path <本机 Git 仓库目录>');
      const result = await importLocalRepository(cfg, need(flags, 'board'), need(flags, 'path'));
      console.log(JSON.stringify(result));
      break;
    }
    case 'configure': {
      const next: WorkerConfig = { ...cfg };
      let changed = false;
      for (const key of ['url', 'token', 'handle', 'board'] as const) {
        if (flags[key] !== undefined) {
          next[key] = flags[key];
          changed = true;
        }
      }
      if (!changed) throw new Error('没有可写入项：需要 --url/--token/--handle/--board 至少一个');
      writeConfig(CONFIG_DIR, next);
      console.log(JSON.stringify(next));
      break;
    }
    case 'register': {
      const url = need(flags, 'url');
      // 接入极简化：唯一必填项是 --url。显示名/句柄缺省由接入设备名自动生成（defaultWorkerIdentity）；
      // --host 可覆盖设备名（默认本机 hostname，在哪台设备跑就属于哪台设备）；
      // --models "a,b,c" 随注册一次性上报可用模型清单（可省，之后可用 WORKER_MODELS / me/models 重报）。
      const host = flags.host !== undefined && flags.host !== '' ? flags.host : hostname();
      const def = defaultWorkerIdentity(host);
      const name = flags.name !== undefined && flags.name !== '' ? flags.name : def.name;
      const handle = flags.handle !== undefined && flags.handle !== '' ? flags.handle : def.handle;
      const models = (flags.models ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const w = new Worker(url);
      // 单用户模型：注册无门槛（角色默认 worker）；"用户"身份走服务器设置页（PUT /api/user）。
      // 409 撞名自愈：handle 已被占用时自动加 -2、-3… 后缀重试（显式指定的 handle 也一样，比报错友好）。
      const r = await registerWithRetry(w, { name, handle, host, models });
      if (r.handle !== handle) {
        // 提示走 stderr：stdout 保持单行 JSON 契约，脚本解析不受影响
        console.error(`句柄 @${handle} 已被占用，自动改用 @${r.handle}`);
      }
      // 多身份落盘（身份粒度 = 设备 × 执行内核）：worker.json 里躺着的可能是别的内核的身份，
      // 先原样归档再写新活跃身份——omp/zcode 互不复用互不改档，旧身份可用 use <handle> 切回
      persistRegisteredIdentity(CONFIG_DIR, cfg, { url, token: r.token, handle: r.handle }, flags.board);
      console.log(JSON.stringify(r));
      break;
    }
    case 'use': {
      // 多身份切换：从 identities/<handle>.json 恢复为活跃身份（覆盖 worker.json）
      const handle = rest[1];
      if (!handle) {
        const options = listArchivedIdentities(CONFIG_DIR);
        throw new Error(`用法：use <handle>（可选身份：${options.join('、') || '归档为空，先 register'}）`);
      }
      console.log(JSON.stringify(restoreIdentity(CONFIG_DIR, handle)));
      break;
    }
    case 'me': {
      console.log(JSON.stringify({ url: cfg.url, handle: cfg.handle, board: cfg.board, hasToken: !!cfg.token }));
      break;
    }
    case 'inbox': {
      let since = 0;
      if (flags.since !== undefined) {
        since = Number(flags.since);
        if (!Number.isInteger(since) || since < 0) throw new Error('--since 需要非负整数');
      }
      console.log(JSON.stringify(await requireWorker(cfg).inbox(since)));
      break;
    }
    case 'next': {
      console.log(JSON.stringify(await requireWorker(cfg).next(requireBoard(cfg, flags))));
      break;
    }
    case 'claim': {
      const id = rest[1];
      if (!id) throw new Error('用法：claim <任务号> [--files a.md,b.ts]');
      console.log(JSON.stringify(await requireWorker(cfg).claim(id, parseFiles(flags.files))));
      break;
    }
    case 'checkpoint': {
      const id = rest[1];
      if (!id) throw new Error('用法：checkpoint <任务号> --note "..."');
      console.log(JSON.stringify(await requireWorker(cfg).checkpoint(id, need(flags, 'note'))));
      break;
    }
    case 'submit': {
      const id = rest[1];
      if (!id) throw new Error('用法：submit <任务号> --summary "..." [--evidence "docs/x.md@机器,src/y.ts@机器"]');
      console.log(JSON.stringify(await requireWorker(cfg).submit(id, need(flags, 'summary'), parseEvidence(flags.evidence))));
      break;
    }
    case 'release': {
      const id = rest[1];
      if (!id) throw new Error('用法：release <任务号> [--reason "..."]');
      console.log(JSON.stringify(await requireWorker(cfg).release(id, flags.reason)));
      break;
    }
    case 'message': {
      const content = need(flags, 'content');
      await requireWorker(cfg).postMessage(requireBoard(cfg, flags), content);
      console.log(JSON.stringify({ ok: true }));
      break;
    }
    default:
      throw new Error(`未知子命令：${cmd}`);
  }
}

// 仅直接执行（node cli.ts …）时进入主流程；被测试 import 时只取上面的归档/恢复函数，不跑 main
if (import.meta.main) {
  main().then(
    () => undefined,
    (err: unknown) => {
      const message =
        err instanceof SdkError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      console.log(JSON.stringify({ error: message }));
      process.exitCode = 1;
    },
  );
}
