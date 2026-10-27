// ZCode headless worker 适配器（§9.1：适配器只写三件事——怎么启动、怎么组 prompt、怎么变成 submit）
//
// 环境变量：
//   ASTERHIVE_URL      服务器地址（默认 http://127.0.0.1:8067）
//   ASTERHIVE_BOARD    轮询的看板 id（可选；缺省=多板巡检模式——每轮对全部看板逐板领活，
//                      非参与者板自动跳过，板清单每 5 分钟刷新、新板自动纳入）
//   WORKER_HANDLE      @句柄（默认 <内核>-<主机名短缀>，内核名自动探测：omp/zcode/opencode…；
//                      撞名自动加后缀自愈）
//   WORKER_NAME        显示名（默认 <内核>@<主机名>）
//   WORKER_TOKEN       已有 token；缺省则现场注册新 worker（token 只打印一次）
//   WORKER_WORKDIR     工作目录（默认 <本目录>/work；repo 看板的项目工作区在其下 projects/<看板id> 持久化）
//   WORKER_PUSH        任务成果 commit 后是否自动 push 任务分支（默认关；push 凭据完全用设备 git 自身配置）
//   WORKER_MODELS      本机可用模型清单（逗号分隔，注册/启动时上报服务器供用户指派首选）
//   ZCODE_BIN          zcode 可执行（默认本机 ZCode Desktop 的 zcode.cjs，找不到再退 PATH 的 zcode）
//   POLL_MS            轮询间隔（默认 10000；每次轮询同时充当心跳）
//   TASK_TIMEOUT_MS    单任务执行超时（默认 1800000 = 30 分钟）
import {
  SdkError,
  Worker,
  defaultWorkerIdentity,
  registerWithRetry,
  detectDeviceSpecs,
  type Task,
  type PendingMessage,
} from './sdk.ts';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitWorkspace, prepareWorkspace, type PreparedWorkspace } from './workspace.ts';
import { firstSkip, nextBoardsToPoll } from './polling.ts';
import { runPiPrompt } from './pi-executor.ts';
import {
  OmpRpcSession,
  DEFAULT_THRESHOLDS,
  contextAction,
  type CtxThresholds,
} from './rpc-executor.ts';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 模型清单重报节流：常驻巡检期间每 60 分钟重报一次 CFG.models——
// 设备主人装了新模型后无需重启 worker，服务器档案最迟一小时内对齐
const MODEL_REREPORT_MS = 60 * 60_000;

// 托管工蜂（T19）：~/.asterhive/worker.json 可承载完整设备配置（安装脚本写入）——
// url/board/executor 与 model{baseURL,apiKey,model}；环境变量优先级更高，兼容既有部署。
interface WorkerFileConfig {
  url?: string;
  token?: string;
  handle?: string;
  board?: string;
  executor?: string;
  model?: { baseURL?: string; apiKey?: string; model?: string; thinkingLevel?: string };
}

function readWorkerFileConfig(): WorkerFileConfig {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.asterhive', 'worker.json'), 'utf8')) as WorkerFileConfig;
  } catch {
    return {}; // 无配置文件 = 既有 env 驱动部署，行为不变
  }
}

const WORKER_FILE = readWorkerFileConfig();

const CFG = {
  url: process.env.ASTERHIVE_URL ?? WORKER_FILE.url ?? 'http://127.0.0.1:8067',
  board: process.env.ASTERHIVE_BOARD ?? WORKER_FILE.board ?? '', // 空 = 未绑板 → 多板巡检模式
  // 默认身份自报内核：探测本机执行内核（pi/omp/zcode/opencode…），写成 <内核>-<主机名短缀> /
  // <内核>@<主机名>——用户一眼看出"这台设备跑的是什么"；探测不到兜底 worker-（SDK 同款中性名）
  handle: process.env.WORKER_HANDLE ?? WORKER_FILE.handle ?? (() => {
    const id = defaultWorkerIdentity(hostname());
    const kind = detectExecutorKind();
    return kind === 'worker' ? id.handle : `${kind}-${id.handle.replace(/^worker-/, '')}`;
  })(),
  name: process.env.WORKER_NAME ?? WORKER_FILE.handle ?? (() => {
    const id = defaultWorkerIdentity(hostname());
    const kind = detectExecutorKind();
    return kind === 'worker' ? id.name : `${kind[0].toUpperCase()}${kind.slice(1)}@${hostname()}`;
  })(),
  token: process.env.WORKER_TOKEN ?? WORKER_FILE.token,
  workdirRoot: process.env.WORKER_WORKDIR ?? join(here, 'work'),
  pollMs: Number(process.env.POLL_MS ?? 10_000),
  taskTimeoutMs: Number(process.env.TASK_TIMEOUT_MS ?? 1_800_000),
  // 模型渠道由 worker 所有者自选（§8.3 服务器不感知）；omp 模糊匹配如 gpt-5.2 / openai/gpt-5.2
  model: process.env.WORKER_MODEL,
  // 托管工蜂（pi 执行器）的设备本地模型配置：安装脚本交互式写入 worker.json，Key 设备自持
  piModel: (() => {
    const m = WORKER_FILE.model;
    const baseURL = process.env.WORKER_PI_BASE_URL ?? m?.baseURL;
    const apiKey = process.env.WORKER_PI_API_KEY ?? m?.apiKey;
    const model = process.env.WORKER_PI_MODEL ?? m?.model;
    if (!baseURL || !apiKey || !model) return null;
    return { baseURL, apiKey, model, thinkingLevel: process.env.WORKER_PI_THINKING ?? m?.thinkingLevel };
  })(),
  // RPC 直接执行 OMP 二进制；OMP_BIN 可继续指向用户 oneshot 包装器
  ompRpcBin: process.env.OMP_RPC_BIN,
  // 项目工作区 push 开关（T15）：默认关，成果只以本地 commit 留在工作区；=1 时任务 commit 后推送任务分支
  push: process.env.WORKER_PUSH === '1',
  executorMode: (process.env.EXECUTOR_MODE ?? 'oneshot') as 'rpc' | 'oneshot',
  ctxThresholds: {
    shake: Number(process.env.WORKER_CTX_SHAKE ?? DEFAULT_THRESHOLDS.shake),
    compact: Number(process.env.WORKER_CTX_COMPACT ?? DEFAULT_THRESHOLDS.compact),
    stop: Number(process.env.WORKER_CTX_STOP ?? DEFAULT_THRESHOLDS.stop),
    resume: Number(process.env.WORKER_CTX_RESUME ?? DEFAULT_THRESHOLDS.resume),
  } satisfies CtxThresholds,
  // RPC 会话本机私有数据根（与项目仓库分离，不提交）
  rpcSessionRoot: process.env.WORKER_RPC_SESSION_DIR ?? join(homedir(), '.asterhive', 'rpc-sessions'),
  // 设备主人声明的本机可用模型（逗号分隔）：注册/每小时重报给服务器，供用户指派首选
  models: (process.env.WORKER_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};

// pi 执行器：模型清单缺省 = 设备配置的那个模型（注册/重报给服务器，供调度匹配 requiredModel）
if (CFG.models.length === 0 && CFG.piModel) CFG.models.push(CFG.piModel.model);

// 探测本机执行内核名（供默认身份自报"我是什么"）：显式 WORKER_EXECUTOR / worker.json 优先，
// 否则按 PATH 逐个探测常见 CLI，兜底 worker——名字必须内核无关地反映真实内核
function detectExecutorKind(): string {
  const explicit = process.env.WORKER_EXECUTOR?.trim() ?? WORKER_FILE.executor?.trim();
  if (explicit) return explicit;
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const has = (bin: string) =>
    pathDirs.some((d) => {
      try {
        return d && existsSync(join(d, process.platform === 'win32' ? `${bin}.exe` : bin));
      } catch {
        return false;
      }
    });
  if (has('omp')) return 'omp';
  if (has('zcode')) return 'zcode';
  if (has('opencode')) return 'opencode';
  return 'worker';
}

function detectExecutor(): { kind: 'omp' | 'zcode'; cmd: string; args: string[] } {
  const kind = process.env.WORKER_EXECUTOR === 'zcode' ? 'zcode' : 'omp';
  if (kind === 'omp') {
    return { kind, cmd: process.env.OMP_BIN ?? 'omp', args: [] };
  }
  const envBin = process.env.ZCODE_BIN;
  const desktopCjs = join(
    homedir(),
    'AppData',
    'Local',
    'Programs',
    'ZCode',
    'resources',
    'glm',
    'zcode.cjs',
  );
  const bin = envBin ?? (existsSync(desktopCjs) ? desktopCjs : 'zcode');
  if (/\.(cjs|mjs|js)$/.test(bin)) return { kind, cmd: process.execPath, args: [resolve(bin)] };
  return { kind, cmd: bin, args: [] };
}

function buildPrompt(task: Task, ws: PreparedWorkspace, reworkNotes: string[] = []): string {
  // 工作区模式说明：repo 模式告知分支名与「完成后由系统提交」，scratch 模式维持一次性目录语义
  const workspaceLine =
    ws.mode === 'repo'
      ? `## 工作区\n当前目录是本设备的持久项目工作区，所在分支 ${ws.branch}${ws.pulled ? '（开工前已 pull --rebase 同步远端）' : ''}${ws.cloned ? '（本次为新 clone）' : ''}；完成后由系统统一 git 提交，你不需要自行 commit/push。`
      : '## 工作区\n当前目录是本次任务的一次性工作目录。';
  const lines = [
    `你是 AsterHive 星巢的一名 worker，领取了任务 ${task.id}。请在当前工作目录内完成任务。`,
    '',
    `# 任务 ${task.id}：${task.title}`,
    workspaceLine,
    task.detail ? `## 说明\n${task.detail}` : '',
    `## 验收标准\n${task.acceptance || '（未填写——按标题合理完成）'}`,
    task.files.length ? `## 预期触碰文件\n${task.files.join('\n')}` : '',
    task.protectedPaths.length ? `## 禁止触碰\n${task.protectedPaths.join('\n')}` : '',
    reworkNotes.length ? `## 主脑/用户反馈（这是被退回后的重做，必须逐条落实）\n${reworkNotes.join('\n')}` : '',
    '',
    '要求：',
    '1. 只在当前目录下工作，不要越界；',
    '2. 完成后，用 3-5 句话总结你做了什么、产出物在哪里；',
    '3. 不要创建多余文件；',
    '4. 文件名优先用 ASCII 字符（Windows shell 下中文文件名易乱码）。',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

// prompt 写入文件经 @file 传入（避免长中文参数在 shell 下的引号问题；omp 支持 @file）
// model：本次执行用的模型渠道（服务器首选模型覆盖本地 WORKER_MODEL 后由 poll 传入）
function runExecutor(prompt: string, cwd: string, model: string | undefined): Promise<{ stdout: string; code: number | null }> {
  const ex = detectExecutor();
  const promptFile = join(CFG.workdirRoot, 'prompt.md');
  writeFileSync(promptFile, prompt, 'utf8');
  const promptArg = ex.kind === 'omp' ? `@${promptFile.replace(/\\/g, '/')}` : prompt;
  const flagArgs =
    ex.kind === 'omp'
      ? [
          '--print',
          '--no-prewalk',
          '--no-title',
          '--no-skills',
          '--auto-approve',
          '--cwd',
          cwd.replace(/\\/g, '/'),
          ...(model ? ['--model', model] : []),
        ]
      : ['--mode', 'yolo'];
  return new Promise((resolveRun) => {
    const child = spawn(ex.cmd, [...ex.args, ...flagArgs, promptArg], {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ASTERHIVE_WORKER: '1' },
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CFG.taskTimeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, code });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveRun({ stdout: stdout + String(err), code: -1 });
    });
  });
}

// ---- RPC 常驻执行（EXECUTOR_MODE=rpc 显式启用；仅 omp 内核）----
// 每个项目工作目录 + 模型一个私有会话；任务即时推入，阈值门禁在取活前执行。
const rpcSessions = new Map<string, OmpRpcSession>();
let rpcDisabled = false;

function rpcSessionKey(cwd: string, model: string | undefined): string {
  const modelKey = Buffer.from(model ?? process.env.WORKER_MODEL ?? 'default').toString('base64url').slice(0, 24);
  return `${cwd}\\u0000${modelKey}`;
}

async function ensureRpcSession(cwd: string, model: string | undefined): Promise<OmpRpcSession> {
  const resolvedModel = model ?? process.env.WORKER_MODEL;
  const key = rpcSessionKey(cwd, resolvedModel);
  const existing = rpcSessions.get(key);
  if (existing?.alive) return existing;
  if (existing) await existing.kill();
  const workspaceKey = createHash('sha256').update(cwd).digest('hex').slice(0, 20);
  const modelKey = createHash('sha256').update(resolvedModel ?? 'default').digest('hex').slice(0, 12);
  const sessionDir = join(CFG.rpcSessionRoot, detectExecutorKind(), workspaceKey, modelKey);
  const session = new OmpRpcSession({
    ompBin: CFG.ompRpcBin ?? (process.env.OMP_BIN ?? 'omp'),
    cwd,
    sessionDir,
    model: resolvedModel,
    timeoutMs: CFG.taskTimeoutMs,
    log,
  });
  await session.start();
  rpcSessions.set(key, session);
  return session;
}

async function stopRpcSession(cwd: string, model: string | undefined): Promise<void> {
  const key = rpcSessionKey(cwd, model);
  const session = rpcSessions.get(key);
  if (!session) return;
  rpcSessions.delete(key);
  await session.kill();
}


const COMPACT_INSTRUCTIONS =
  '保留本任务 Spec、授权、文件所有权、基线、真实改动和未验证项；不扩大范围，不重放副作用。';


async function gateRpcSessionBeforeClaim(cwd: string, model: string | undefined): Promise<'ready' | 'stop'> {
  if (CFG.executorMode !== 'rpc' || detectExecutor().kind !== 'omp') return 'ready';
  // 仅检查已存在的 session。新 repo 尚未 clone、scratch task dir 尚未知时，不能提前 spawn OMP。
  const session = rpcSessions.get(rpcSessionKey(cwd, model));
  if (!session?.alive) return 'ready';
  const state = await session.getState();
  const action = contextAction(state.contextPercent, CFG.ctxThresholds);
  if (action === 'stop') {
    log(`RPC 上下文占用 ${state.contextPercent}% 达 STOP ${CFG.ctxThresholds.stop}%；本板暂停领取`);
    return 'stop';
  }
  if (action === 'shake') {
    log(`RPC 上下文占用 ${state.contextPercent}% 达 SHAKE ${CFG.ctxThresholds.shake}%；OMP slash 未验证为无模型操作，仅提示`);
  }
  if (action === 'compact') {
    if (state.settled !== true) {
      log('RPC 会话未确认 settled；暂停本板领取，避免打断在途操作');
      return 'stop';
    }
    const ok = await session.compact(COMPACT_INSTRUCTIONS).catch(() => false);
    if (!ok) {
      log('RPC compact 失败；暂停本板领取，不静默回落');
      return 'stop';
    }
    const after = await session.getState();
    if (after.contextPercent === undefined || after.contextPercent >= CFG.ctxThresholds.resume) {
      log(`RPC compact 后占用未确认低于 RESUME ${CFG.ctxThresholds.resume}%；暂停本板领取`);
      return 'stop';
    }
    log(`RPC compact 完成，当前上下文 ${after.contextPercent}%`);
  }
  return 'ready';
}

/** RPC 优先执行；失败（内核不支持/协议异常）回落 oneshot 并告警（进程内一次） */
async function executeTask(
  prompt: string,
  cwd: string,
  model: string | undefined,
  hooks?: { taskId?: string; checkpoint?: (note: string) => Promise<{ pendingMessages?: { author?: string; content?: string }[] }> },
): Promise<{ stdout: string; code: number | null }> {
  // 托管工蜂（T19）：pi 执行器 = 进程内 Pi 会话，零外部 CLI 依赖；
  // 模型配置来自设备本地 worker.json（安装脚本交互式写入），服务器首选模型不适用于该内核
  if (detectExecutorKind() === 'pi') {
    if (!CFG.piModel) {
      return {
        stdout: 'Pi 执行器未配置完整模型：需要在 ~/.asterhive/worker.json 写入 model.baseURL / apiKey / model（可重跑 install-bee.sh 交互式配置）。',
        code: -1,
      };
    }
    return runPiPrompt({
      prompt,
      cwd,
      config: CFG.piModel,
      timeoutMs: CFG.taskTimeoutMs,
      log,
      checkpoint: hooks?.checkpoint,
    });
  }
  const projectRoot = join(CFG.workdirRoot, 'projects');
  const relativeCwd = relative(projectRoot, cwd);
  const isPersistentProject = relativeCwd !== '' && !relativeCwd.startsWith('..') && !isAbsolute(relativeCwd);
  if (!isPersistentProject || CFG.executorMode !== 'rpc' || detectExecutor().kind !== 'omp') {
    return runExecutor(prompt, cwd, model);
  }
  if (rpcDisabled) return { stdout: 'RPC 已禁用；请检查 OMP RPC 配置。', code: -1 };

  let session: OmpRpcSession;
  try {
    session = await ensureRpcSession(cwd, model);
  } catch (err) {
    await stopRpcSession(cwd, model);
    if (!rpcDisabled) {
      rpcDisabled = true;
      log(`RPC 启动/探活失败，任务尚未派发，本进程后续回落 oneshot：${err instanceof Error ? err.message : String(err)}`);
    }
    return runExecutor(prompt, cwd, model);
  }

  // 上下文门禁在 poll 取活前已完成；这里不 compact，不改变已 claim 任务状态。
  try {
    const result = await session.runPrompt(prompt);
    if (result.status === 'completed') return { stdout: result.text, code: 0 };
    return { stdout: `RPC 任务返回 ${result.status}；诊断保留在设备本地。`, code: 1 };
  } catch (err) {
    // prompt 派发后结果未知：绝不 oneshot 重跑，避免重复修改或外部副作用。
    await stopRpcSession(cwd, model);
    log(`RPC 执行结果未知（不重跑）：${err instanceof Error ? err.message : 'unknown error'}`);
    return { stdout: 'RPC 执行结果未知；已停止自动重试以避免重复副作用，请检查设备本地会话。', code: -1 };
  }
}

// 上交证据：工作目录内全部文件（相对路径 + 本机名）
function collectEvidence(workdir: string): Task['evidence'] {
  const out: Task['evidence'] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push({ path: relative(workdir, full).replace(/\\/g, '/'), machine: hostname() });
    }
  };
  if (existsSync(workdir)) walk(workdir);
  return out;
}

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

function logPending(msgs: PendingMessage[]): void {
  for (const m of msgs) {
    log(`  📩 待达消息(${m.author}): ${m.content}`);
  }
}

async function main(): Promise<void> {
  // 复用 token 时必须同时给 agentId（注册时 id 默认取 handle）。
  // token.txt 第一行存 token、第二行存注册后实际生效的 handle（撞名自动加后缀的场景下两者不同）；
  // 旧格式（只有一行）也能读——handle 退回 WORKER_HANDLE/默认值。
  const tokenFile = join(CFG.workdirRoot, 'token.txt');
  if (!CFG.token && existsSync(tokenFile)) {
    const lines = readFileSync(tokenFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    CFG.token = lines[0];
    if (lines[1]) CFG.handle = lines[1];
  }
  let worker = new Worker(CFG.url, CFG.token, CFG.handle);
  const deviceSpecs = detectDeviceSpecs(detectExecutorKind());
  let needRegister = !CFG.token;

  if (CFG.token) {
    // token 复用（已注册）：启动时尝试自报设备能力以验证既有 token 有效性
    try {
      await worker.reportSpecs(deviceSpecs);
      log(`已自报设备能力：${deviceSpecs.os}/${deviceSpecs.arch} · ${deviceSpecs.cpus}C/${deviceSpecs.memoryTotalGb}GB · 内核 ${deviceSpecs.executor}`);
    } catch (err) {
      if (err instanceof SdkError && err.status === 401) {
        log('检测到既有 Token 在当前服务器已失效（401：可能服务器已重置或身份被注销），自动发起重新注册…');
        needRegister = true;
        CFG.token = undefined;
      } else {
        log('设备能力规格上报失败（非致命）：', err instanceof Error ? err.message : err);
      }
    }
  }

  if (needRegister) {
    // 重新实例化未带旧 token 的 worker 发起纯净注册
    const freshWorker = new Worker(CFG.url, undefined, CFG.handle);
    const reg = await registerWithRetry(freshWorker, {
      name: CFG.name,
      handle: CFG.handle,
      models: CFG.models,
      host: hostname(),
      specs: deviceSpecs,
    });
    if (reg.handle !== CFG.handle) log(`句柄 @${CFG.handle} 已被占用，自动改用 @${reg.handle}`);
    CFG.handle = reg.handle;
    CFG.token = reg.token;
    worker = freshWorker;
    // token 只此一次：落盘到 work 目录（连同实际 handle），供下次复用
    mkdirSync(CFG.workdirRoot, { recursive: true });
    writeFileSync(join(CFG.workdirRoot, 'token.txt'), `${reg.token}\n${reg.handle}\n`, 'utf8');
    log(`已注册工蜂 ${reg.handle}（token 已存 ${join(CFG.workdirRoot, 'token.txt')}）`);
    log(`已自报设备能力：${deviceSpecs.os}/${deviceSpecs.arch} · ${deviceSpecs.cpus}C/${deviceSpecs.memoryTotalGb}GB · 内核 ${deviceSpecs.executor}`);
  } else {
    // 复用有效 token：如果本地缺失 token.txt，补齐落盘供管理脚本与回显使用
    if (!existsSync(tokenFile) && CFG.token) {
      mkdirSync(CFG.workdirRoot, { recursive: true });
      writeFileSync(join(CFG.workdirRoot, 'token.txt'), `${CFG.token}\n${CFG.handle}\n`, 'utf8');
    }
    if (CFG.models.length > 0) {
      try {
        const reported = await worker.reportModels(CFG.models);
        log(`已上报模型清单：${reported.join('、')}`);
      } catch (err) {
        log('模型清单上报失败（不影响取活）：', err instanceof Error ? err.message : err);
      }
    }
  }

  let busy = false;
  // 定期重报基线：启动时注册/复用 token 分支已上报过一次模型，从现在起再计时
  let lastModelReport = Date.now();
  const getAuthHeaders = () => ({ authorization: `Bearer ${worker.token ?? ''}` });
  // 多板巡检状态：已知板清单（定期刷新）+ 403 跳过集合（只 log 一次防刷屏）
  const knownBoards: { ids: string[]; lastRefresh: number } = { ids: [], lastRefresh: 0 };
  const skipped403 = new Set<string>();
  const listMine = async (boardId: string, lane: string): Promise<Task[]> => {
    const r = await fetch(
      `${CFG.url}/boards/${boardId}/tasks?lane=${lane}&assignee=${encodeURIComponent(worker.agentId)}`,
      { headers: getAuthHeaders() },
    );
    // 非 2xx 一律抛 SdkError（与 SDK call() 同语义）：多板巡检靠 403 识别非参与者板
    const json = (await r.json().catch(() => ({}))) as { tasks?: Task[]; error?: string };
    if (!r.ok) throw new SdkError(r.status, String(json.error ?? r.statusText));
    return json.tasks ?? [];
  };
  const taskFeedback = async (boardId: string, taskId: string): Promise<string[]> => {
    const r = await fetch(`${CFG.url}/boards/${boardId}/messages?limit=500`, { headers: getAuthHeaders() });
    const json = (await r.json().catch(() => ({}))) as {
      messages?: { taskRef: string | null; author: string; content: string }[];
      error?: string;
    };
    if (!r.ok) throw new SdkError(r.status, String(json.error ?? r.statusText));
    return (json.messages ?? [])
      .filter((m) => m.taskRef === taskId && m.author !== worker.agentId)
      .slice(-3)
      .map((m) => `（${m.author}）${m.content}`);
  };

  // 看板 repo 缓存（T15：board 元数据 30s 缓存过期刷新；boardId → { repo, repoMode, cachedAt }）
  const boardMetaCache = new Map<string, { repo: string | null; repoMode: 'managed' | 'remote-legacy'; cachedAt: number }>();
  const boardMeta = async (boardId: string): Promise<{ repo: string | null; repoMode: 'managed' | 'remote-legacy' }> => {
    const cached = boardMetaCache.get(boardId);
    if (!cached || Date.now() - cached.cachedAt > 30_000) {
      const board = await worker.getBoard(boardId);
      const repo = board.repo?.trim() || null;
      const repoMode = board.repoMode === 'managed' ? 'managed' : 'remote-legacy';
      boardMetaCache.set(boardId, { repo, repoMode, cachedAt: Date.now() });
      if (repoMode === 'managed') log(`看板仓库托管模式：managed（服务器主仓）`);
      else if (repo) log(`项目仓库（board.repo）：${repo}`);
    }
    return boardMetaCache.get(boardId)!;
  };

  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      // 每轮取活前拉服务器档案：用户在设置页为本 agent 选了首选模型则覆盖本地 WORKER_MODEL。
      // 拉取失败不阻塞取活——记一行日志后继续用本地配置。
      let model = CFG.model;
      try {
        const profile = await worker.getMyProfile();
        if (profile.preferredModel) {
          model = profile.preferredModel;
          log(`模型通道：${model}（服务器设置）`);
        }
      } catch (err) {
        log('拉取首选模型失败，沿用本地配置：', err instanceof Error ? err.message : err);
      }
      // 定期重报模型清单（节流 MODEL_REREPORT_MS=60 分钟，非空才报）：顺带做，失败不阻塞取活
      if (CFG.models.length > 0 && Date.now() - lastModelReport >= MODEL_REREPORT_MS) {
        lastModelReport = Date.now();
        try {
          const reported = await worker.reportModels(CFG.models);
          log(`已定期重报模型清单：${reported.join('、')}`);
        } catch (err) {
          log('模型清单定期重报失败（不影响取活）：', err instanceof Error ? err.message : err);
        }
      }
      // 板清单决策（polling.ts 纯函数）：ASTERHIVE_BOARD 显式绑板=只巡检它、永不刷新；
      // 缺省=多板巡检，距上次拉取超过 5 分钟（或首轮）重新 getBoards——新板自动纳入、
      // 拉取失败沿用已知清单下轮再试。
      const decision = nextBoardsToPoll(knownBoards.ids, {
        explicitBoard: CFG.board || undefined,
        now: Date.now(),
        lastRefresh: knownBoards.lastRefresh,
      });
      if (decision.refreshDue) {
        try {
          const ids = (await worker.getBoards()).map((b) => b.id);
          const prev = knownBoards.ids.join(',');
          knownBoards.ids = ids;
          knownBoards.lastRefresh = Date.now();
          if (ids.join(',') !== prev) log(`看板清单更新（${ids.length} 块）：${ids.join('、') || '（空）'}`);
        } catch (err) {
          log('拉取看板清单失败，沿用已知清单：', err instanceof Error ? err.message : err);
        }
      }

      // 取活三通道，逐板按序尝试（多板巡检时命中即止——一次只做一张卡）：
      // 被退回重做（InProgress 归我）＞ 派给我的 Ready ＞ 未指派池 next。
      // 某板 403（非参与者）→ 该板本轮跳过，只 log 一次（Set 防刷屏）；下轮自然再试，
      // 参与者在页面里被勾上后无需任何处理即自动恢复。
      let reworkNotes: string[] = [];
      let task: Task | undefined;
      let rpcStopBoard: string | null = null;
      for (const boardId of decision.poll) {
        try {
          const reworks = await listMine(boardId, 'InProgress'); // 只读查询，不触发领取/写入
          const meta = await boardMeta(boardId);
          // 仅持久 repo 工作区有跨任务 RPC 上下文；scratch / managed 每任务独立临时目录，无旧上下文可预检。
          let gate: 'ready' | 'stop' = 'ready';
          if (meta.repoMode === 'remote-legacy' && meta.repo) {
            gate = await gateRpcSessionBeforeClaim(join(CFG.workdirRoot, 'projects', boardId), model);
          }
          if (gate === 'stop') {
            rpcStopBoard = boardId;
            if (reworks.length > 0) {
              const blocked = reworks[0]!;
              await worker.checkpoint(blocked.id, `RPC 上下文达到 STOP ${CFG.ctxThresholds.stop}%：任务暂缓，未启动新执行；请等待当前 worker 会话整理或联系设备所有者。`);
              log(`RPC STOP：重做任务 ${blocked.id} 保持 InProgress 并已 checkpoint，未重新执行`);
            }
            continue; // 不 claim/next；其他板仍可独立巡检
          }
          if (reworks.length > 0) {
            task = reworks[0];
            reworkNotes = await taskFeedback(boardId, task.id);
            log(`重做被退回的任务 ${task.id}`);
            break;
          }
          const mine = await listMine(boardId, 'Ready');
          if (mine.length > 0) {
            task = await worker.claim(mine[0].id);
            break;
          }
          task = (await worker.next(boardId)) ?? undefined;
          if (task) break;
        } catch (err) {
          if (err instanceof SdkError && err.status === 403) {
            if (firstSkip(skipped403, boardId)) log(`板 ${boardId} 非参与者，已跳过`);
            continue;
          }
          throw err;
        }
      }
      if (!task) {
        if (rpcStopBoard) log(`RPC 上下文 STOP：暂停看板 ${rpcStopBoard} 的取活；会话整理后下轮自动恢复`);
        return;
      }
      log(`领取任务 ${task.id}：${task.title}`);

      // 工作区准备（T15 / §9.4 / managed 模式）：
      // managed 模式=临时快照（从服务器拉 bundle、本地执行、结果 bundle 回传、最后清理临时目录）；
      // remote-legacy repo 模式=持久项目工作区（clone/pull --rebase/任务分支）；
      // scratch 模式=一次性目录。
      let ws: PreparedWorkspace;
      const meta = await boardMeta(task.boardId);
      try {
        ws = await prepareWorkspace({
          workdirRoot: CFG.workdirRoot,
          boardId: task.boardId,
          taskId: task.id,
          repo: meta.repo,
          repoMode: meta.repoMode,
          worker,
          push: CFG.push,
          log,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`工作区准备失败：${reason}`);
        try {
          await worker.checkpoint(task.id, `工作区准备失败：${reason}`);
          await worker.release(task.id, `工作区准备失败：${reason}`);
        } catch (reportErr) {
          log('失败上报/释放出错：', reportErr instanceof Error ? reportErr.message : reportErr);
        }
        return;
      }
      if (ws.cloned) log(`已 clone 项目工作区：${ws.dir}`);
      if (ws.pulled) log(`已同步远端（pull --rebase）：${ws.dir}`);

      const cp1 = await worker.checkpoint(task.id, reworkNotes.length ? '收到退回反馈，开始重做' : '开始执行');
      logPending(cp1.pendingMessages);

      const startTime = Date.now();
      const keepAliveIntervalMs = 60000;
      const keepAliveTimer = setInterval(() => {
        const mins = Math.max(1, Math.round((Date.now() - startTime) / 60000));
        void worker.checkpoint(task.id, `进行中：任务持续执行（已耗时约 ${mins} 分钟）`).then((cp) => {
          logPending(cp.pendingMessages);
        }).catch((err) => {
          log('保活心跳发送失败（非致命）：', err instanceof Error ? err.message : err);
        });
      }, keepAliveIntervalMs);

      let execRes: { stdout: string; code: number | null };
      try {
        execRes = await executeTask(buildPrompt(task, ws, reworkNotes), ws.dir, model, {
          taskId: task.id,
          // hive_checkpoint 落点：模型在里程碑/受阻时主动汇报，服务器的干预消息原样带回
          checkpoint: (note) => worker.checkpoint(task.id, note),
        });
      } finally {
        clearInterval(keepAliveTimer);
      }
      const { stdout, code } = execRes;
      log(`执行结束（exit=${code}），输出 ${stdout.length} 字符`);
      const cp2 = await worker.checkpoint(task.id, code === 0 ? '执行完毕，整理证据' : `执行异常退出（${code}），仍上交现场`);
      logPending(cp2.pendingMessages);

      // 成果提交：repo / managed 模式统一由 commitWorkspace 处理
      let commitNote = '';
      let evidence = collectEvidence(ws.dir);
      if (ws.mode === 'repo' || ws.mode === 'managed') {
        try {
          const hash = await commitWorkspace(ws, task.title);
          if (hash) {
            commitNote = `\n[workspace] 本地提交 ${ws.branch}@${hash}（${ws.changedFiles?.length ?? 0} 个文件${ws.mode === 'managed' ? '，已回传服务器仓库' : ws.push ? '，已推送 origin' : '，未推送'}）`;
            evidence = (ws.changedFiles ?? []).map((p) => ({ path: p, machine: hostname() }));
            evidence.push({ path: `git:${ws.branch}@${hash}`, machine: hostname() });
          } else {
            commitNote = '\n[workspace] 工作区无文件变更，未产生提交';
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          commitNote = `\n[workspace] 提交失败：${reason}`;
          log(`提交失败（仍上交现场）：${reason}`);
        }
      }

      const summary = (stdout.trim().split('\n').slice(-6).join('\n') || '(无输出)') + commitNote;
      await worker.submit(task.id, summary, evidence);
      log(`已上交 ${task.id}，证据 ${evidence.length} 项`);

      // managed 模式：成功交活后销毁本机临时目录
      if (ws.mode === 'managed' && ws.cleanup) {
        try {
          ws.cleanup();
          log(`已清理临时工作区：${ws.dir}`);
        } catch (err) {
          log('清理临时工作区警告：', err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      log('轮询/执行出错：', err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };

  log(
    `worker ${CFG.handle} 就绪，轮询 ${CFG.url} ` +
      `${CFG.board ? `板 ${CFG.board}` : '全部看板（多板巡检，非参与者板自动跳过）'}（${CFG.pollMs}ms）`,
  );
  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pollTimer) clearInterval(pollTimer);
    void Promise.all([...rpcSessions.values()].map((session) => session.kill())).finally(() => {
      rpcSessions.clear();
      log('worker 已停止，RPC 会话已全部关闭');
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await poll();
  // --once（push 启动器形态）：单轮领活执行完毕即退出——最多执行一张卡；
  // 无任务也正常退出（退出码 0），由调用方（未来的 push Runner / cron）决定何时再拉起
  if (process.argv.includes('--once')) {
    log('--once 模式：单轮领活完毕，进程退出');
    process.exitCode = 0;
    return;
  }
  if (!shuttingDown) pollTimer = setInterval(() => { if (!shuttingDown) void poll(); }, CFG.pollMs);
}

void main();
