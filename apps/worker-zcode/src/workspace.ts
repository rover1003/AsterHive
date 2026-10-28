// 项目工作区持久化（ROADMAP T15 / 立项计划 §9.4：git 仓库为唯一事实源，各设备自持克隆）
//
// 两种模式：
//   repo 模式    —— 看板填了 board.repo：每台设备对每个项目持有一个持久工作区
//                   <WORKER_WORKDIR>/projects/<看板id>。首次 clone，之后每次领活 pull --rebase，
//                   干活前切任务分支 asterhive/<任务号>，任务结束后由 commitWorkspace 以本地 commit 留痕。
//                   push 永不自动（WORKER_PUSH=1 显式开启，凭据完全用设备 git 自身配置）。
//   scratch 模式 —— 看板没填 repo：一次性任务目录 <WORKER_WORKDIR>/<任务号>，mkdir 即用（旧行为原样保留）。
//
// 失败语义：repo 模式下 clone 失败 / pull 冲突一律抛错阻塞上报，绝不静默改道 scratch——
// 用户明确要 repo 语义，静默降级会让"项目在工作区层面有连续性"变成假象。
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Worker } from './sdk.ts';

export interface TaskSnapshot {
  buffer: ArrayBuffer;
  baseCommit: string;
  reworkCommit?: string;
  reworkBranch?: string;
}

export interface WorkerSnapshotClient {
  downloadTaskSnapshot(taskId: string, attempt?: number): Promise<TaskSnapshot>;
  uploadTaskResult(taskId: string, bundle: Uint8Array, sha256: string, attempt?: number): Promise<{ taskRef: string; headCommit: string }>;
}

export interface PreparedWorkspace {
  dir: string;                         // 实际执行 cwd
  mode: 'repo' | 'scratch' | 'managed'; // repo=持久克隆；scratch=无 repo 一次性目录；managed=服务端托管临时快照
  taskId: string;                      // 所属任务号
  attempt?: number;                    // 任务当前执行代次
  branch?: string;                     // 任务分支
  baseCommit?: string;                 // 任务原始基线提交 hash
  initialCommit?: string;              // 本次领活检出的初始提交 hash（重做场景下为上一轮任务成果 commit）
  commitHash?: string;                 // 执行后提交的 hash
  pulled?: boolean;                    // 是否执行了 pull --rebase
  cloned?: boolean;                    // 是否新 clone
  changedFiles?: string[];             // 变更文件
  push?: boolean;
  worker?: Worker | WorkerSnapshotClient; // managed 模式回传 bundle 用
  cleanup?: () => void;                // 临时目录销毁钩子
  log?: (s: string) => void;
}

export interface PrepareWorkspaceOptions {
  workdirRoot: string;
  boardId: string;
  taskId: string;
  attempt?: number;
  isRework?: boolean;                  // 是否为重做任务（显式指定 false 则不切历史成果，防止全新任务被旧 ref 污染）
  noCode?: boolean;
  repo?: string | null;                // legacy repo URL
  repoMode?: 'managed' | 'remote-legacy';
  worker?: Worker | WorkerSnapshotClient;
  push?: boolean;
  log?: (s: string) => void;
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// 跑一条 git 命令（照 main.ts 的 spawn 包 Promise 风格）。
// GIT_TERMINAL_PROMPT=0：headless worker 没人应答凭据交互，需要用户名/密码时让 git 快速失败
// 而不是挂到任务超时——凭据本就应完全走设备自己的 git 配置（credential manager / ssh 等）。
function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((res) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => res({ code, stdout, stderr }));
    child.on('error', (err) => res({ code: -1, stdout, stderr: stderr + String(err) }));
  });
}

// 错误信息只带 stderr 尾部 200 字符（git 报错的关键行几乎都在尾部，全量太吵）
function tail(s: string, n = 200): string {
  const t = s.trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}

/** 跑 git 并要求成功；失败抛出带「人工处理提示 + stderr 尾部」的错误 */
async function git(args: string[], cwd: string, hint: string): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} 失败（${hint}，exit=${r.code}）：${tail(r.stderr)}`);
  }
  return r.stdout;
}

async function ensureGitIdentity(cwd: string): Promise<void> {
  const [name, email] = await Promise.all([
    runGit(['config', '--get', 'user.name'], cwd),
    runGit(['config', '--get', 'user.email'], cwd),
  ]);
  if ((name.code !== 0 && name.code !== 1) || (email.code !== 0 && email.code !== 1)) {
    throw new Error('读取 Git 提交身份配置失败');
  }
  if (!name.stdout.trim()) await git(['config', '--local', 'user.name', 'AsterHive Worker'], cwd, '设置工作区提交名称失败');
  if (!email.stdout.trim()) await git(['config', '--local', 'user.email', 'worker@asterhive.invalid'], cwd, '设置工作区提交邮箱失败');
}

/** 解析 `git status --porcelain -z` 输出为文件路径列表（NUL 分隔、路径不转义，中文文件名安全；重命名项跳过原始路径段） */
export function parseStatusZ(out: string): string[] {
  const items = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    files.push(it.slice(3)); // 前缀 "XY " 共 3 字符
    const xy = it.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++; // 重命名/复制：下一段是原始路径，跳过
  }
  return files;
}

/** 领到任务后准备工作区：repo 模式 clone/pull + 切任务分支；scratch 模式建一次性目录 */
export async function prepareWorkspace(opts: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
  const log = opts.log ?? (() => {});
  const repo = opts.repo?.trim() || null;

  // ---- managed 模式：从服务器下载代码快照 bundle，在临时工作目录执行，完成后销毁 ----
  if (opts.repoMode === 'managed') {
    if (!opts.worker) throw new Error('managed repository mode requires worker instance for snapshot download');
    const baseDir = join(opts.workdirRoot, 'ephemeral', `${opts.boardId}-${opts.taskId}`);
    const bundleFile = join(baseDir, 'snapshot.bundle');
    const worktreeDir = join(baseDir, 'src');
    const branch = `asterhive/${opts.taskId}`;
    if (existsSync(join(worktreeDir, '.git'))) {
      const currentBranch = (await git(['branch', '--show-current'], worktreeDir, '读取恢复工作区分支失败')).trim();
      if (currentBranch !== branch) throw new Error(`managed 临时工作区已存在但分支为 ${currentBranch || 'detached'}（期望 ${branch}）；为保护现场，不覆盖。`);
      await ensureGitIdentity(worktreeDir);

      // 复用工作区时向服务器拉取快照元数据以对齐基线与重做参考，不覆盖本地现有文件
      log(`managed 模式：检测到现有临时工作区，向服务器获取任务 ${opts.taskId} 的快照元数据...`);
      const snap = await opts.worker.downloadTaskSnapshot(opts.taskId, opts.attempt);

      const isTrueRework = opts.isRework === true || (opts.isRework === undefined && Boolean(snap.reworkCommit || snap.reworkBranch));
      const baseCommit = snap.baseCommit;
      if (isTrueRework && !snap.reworkCommit && !opts.noCode) throw new Error('重做快照缺少上一轮任务提交，已保留本地工作区');
      const initialCommit = (isTrueRework && snap.reworkCommit) ? snap.reworkCommit : snap.baseCommit;

      const headRes = await runGit(['rev-parse', 'HEAD'], worktreeDir);
      if (headRes.code !== 0 || !headRes.stdout.trim()) throw new Error('读取恢复工作区当前 HEAD 失败');
      const currentHead = headRes.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(initialCommit)) throw new Error('任务快照基线无效，已保留本地工作区');
      const ancestry = await runGit(['merge-base', '--is-ancestor', initialCommit, currentHead], worktreeDir);
      if (ancestry.code !== 0) throw new Error('本地任务分支不包含服务器记录的执行基线，已保留工作区，请人工核对');

      const status = await git(['status', '--porcelain', '-z'], worktreeDir, '读取恢复工作区状态失败');
      const dirtyFiles = parseStatusZ(status);
      if (dirtyFiles.length > 0) {
        log(`managed 模式：现有任务分支 ${branch} 包含未提交的在途改动（${dirtyFiles.slice(0, 12).join(', ')}），保留并复用临时工作区。`);
      } else {
        log(`managed 模式：现有任务分支 ${branch} 工作区干净（HEAD: ${currentHead.slice(0, 8)}，对比起点: ${initialCommit.slice(0, 8)}），保留并复用临时工作区。`);
      }

      return {
        dir: worktreeDir,
        mode: 'managed',
        taskId: opts.taskId,
        attempt: opts.attempt,
        branch,
        baseCommit,
        initialCommit,
        worker: opts.worker,
        cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
        log,
      };
    }
    if (existsSync(baseDir) && readdirSync(baseDir).length > 0) {
      throw new Error(`managed 临时路径存在但没有可验证的任务仓库，拒绝覆盖并保留现场：${baseDir}`);
    }
    mkdirSync(baseDir, { recursive: true });
    log(`managed 模式：从服务器下载任务 ${opts.taskId} 的代码快照...`);
    const snap = await opts.worker.downloadTaskSnapshot(opts.taskId, opts.attempt);
    if (opts.isRework === true && !snap.reworkCommit && !opts.noCode) throw new Error('重做快照缺少上一轮任务提交，拒绝从主干重新开始');
    writeFileSync(bundleFile, Buffer.from(snap.buffer));
    log(`快照下载完毕（${snap.buffer.byteLength} 字节，基线 ${snap.baseCommit.slice(0, 8)}），解包工作树...`);
    await git(['clone', bundleFile, worktreeDir], baseDir, '解包快照 bundle 失败');
    let initialCommit = snap.baseCommit;
    const isTrueRework = opts.isRework === true || (opts.isRework === undefined && Boolean(snap.reworkCommit || snap.reworkBranch));
    if (isTrueRework && (snap.reworkCommit || snap.reworkBranch)) {
      const target = snap.reworkCommit || snap.reworkBranch;
      if (target) {
        log(`managed 模式：检测到重做快照（基线 ${snap.baseCommit.slice(0, 8)}，签出上一轮成果 ${target.slice(0, 8)}）...`);
        await git(['checkout', '-B', branch, target], worktreeDir, '签出上一轮重做提交失败');
        const head = await runGit(['rev-parse', 'HEAD'], worktreeDir);
        if (head.code === 0 && head.stdout.trim()) {
          initialCommit = head.stdout.trim();
        }
      }
    } else {
      if (snap.reworkCommit || snap.reworkBranch) {
        log(`managed 模式：非重做任务（isRework=${opts.isRework}），忽略快照中的历史任务 ref，从基线 HEAD 新建任务分支...`);
      }
      await git(['checkout', '-B', branch, snap.baseCommit], worktreeDir, '创建任务分支失败');
      const head = await runGit(['rev-parse', 'HEAD'], worktreeDir);
      if (head.code === 0 && head.stdout.trim()) {
        initialCommit = head.stdout.trim();
      }
    }
    await ensureGitIdentity(worktreeDir);
    return {
      dir: worktreeDir,
      mode: 'managed',
      taskId: opts.taskId,
      attempt: opts.attempt,
      branch,
      baseCommit: snap.baseCommit,
      initialCommit,
      worker: opts.worker,
      cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
      log,
    };
  }

  // ---- scratch 模式（现状行为原样保留）：无 repo 的一次性任务目录，mkdir 即用 ----
  if (!repo) {
    const dir = join(opts.workdirRoot, opts.taskId);
    mkdirSync(dir, { recursive: true });
    return { dir, mode: 'scratch', taskId: opts.taskId, attempt: opts.attempt };
  }

  // ---- repo 模式：持久项目工作区 <workdirRoot>/projects/<boardId> ----
  const dir = join(opts.workdirRoot, 'projects', opts.boardId);
  const branch = `asterhive/${opts.taskId}`;
  // 只在真的发生时才置位（可选字段语义：没发生 = undefined，便于调用方/测试区分）
  let cloned: boolean | undefined;
  let pulled: boolean | undefined;

  if (existsSync(join(dir, '.git'))) {
    // 已有工作区：先切回默认分支再同步远端。上次任务把工作区留在了 asterhive/<任务号> 分支上
    //（该分支无 upstream，直接 pull 会报 no tracking information），origin/HEAD 指向远端默认分支。
    const oh = await runGit(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], dir);
    if (oh.code === 0 && oh.stdout.trim()) {
      const def = oh.stdout.trim().replace(/^origin\//, '');
      await git(['checkout', def], dir, '切回默认分支失败，需人工处理');
    }
    log(`工作区已存在，同步远端（pull --rebase）：${dir}`);
    await git(['pull', '--rebase'], dir, '设备工作区与远端冲突，需人工处理');
    pulled = true;
  } else {
    if (existsSync(dir)) {
      // 目录在但没有 .git：来历不明的残留，宁可阻塞也不往里 clone / 也不改道 scratch
      throw new Error(`工作区目录已存在但不是 git 仓库（缺 .git），需人工清理后重试：${dir}`);
    }
    log(`首次接入该项目，clone ${repo} → ${dir}`);
    await git(['clone', repo, dir], opts.workdirRoot, 'clone 失败（检查网络/仓库地址/设备 git 凭据）');
    cloned = true;
  }

  const baseCommit = (await git(['rev-parse', 'HEAD'], dir, '读取基线提交失败')).trim();

  // 干活前切任务分支：新建；同名分支已存在（同任务重做/续做）则复用并提示
  const co = await runGit(['checkout', '-b', branch], dir);
  if (co.code !== 0) {
    log(`分支 ${branch} 已存在，复用现有分支（${tail(co.stderr)}）`);
    await git(['checkout', branch], dir, '切换任务分支失败，需人工处理');
  }
  await ensureGitIdentity(dir);

  return { dir, mode: 'repo', taskId: opts.taskId, attempt: opts.attempt, branch, baseCommit, cloned, pulled, push: opts.push, log };
}

/** Execution succeeded; code work additionally needs a stored commit before it may be submitted. */
export function canSubmitExecution(input: {
  exitCode: number | null;
  commitHash?: string;
  commitFailed?: boolean;
  noCode: boolean;
}): boolean {
  if (input.exitCode !== 0 || input.commitFailed) return false;
  return input.noCode || Boolean(input.commitHash);
}

/** 任务结束后提交成果（repo/managed 模式）：有变更才 commit，返回 hash；无变更返回 undefined。永不自动 push 除非 ws.push */
export async function commitWorkspace(ws: PreparedWorkspace, message: string): Promise<string | undefined> {
  if (ws.mode === 'scratch') return undefined; // scratch 模式无 git 语义
  const log = ws.log ?? (() => {});
  const branch = ws.branch!;

  // 1. 检查是否有未暂存/未提交变更
  const st = await git(['status', '--porcelain', '-z'], ws.dir, '读取工作区状态失败');
  const changed = parseStatusZ(st);
  let commitMade = false;
  if (changed.length > 0) {
    await git(['add', '-A'], ws.dir, '暂存变更失败');
    await git(['commit', '-m', `asterhive(${ws.taskId}): ${message}`], ws.dir, '提交失败');
    commitMade = true;
  }

  // 2. 检查任务分支当前 HEAD 与基线
  const hash = (await git(['rev-parse', 'HEAD'], ws.dir, '读取提交 hash 失败')).trim();
  const startingCommit = ws.initialCommit ?? ws.baseCommit;
  const isNewCommit = startingCommit
    ? (hash !== startingCommit && hash !== ws.commitHash)
    : (commitMade || (ws.commitHash ? hash !== ws.commitHash : false));
  const hasNewCommits = commitMade || isNewCommit;

  if (!hasNewCommits && changed.length === 0) {
    log('工作区无文件变更，且任务分支无新增提交，不产生提交');
    return undefined;
  }

  // 汇总本轮起点至当前提交的全部文件，包含模型自行提交的改动。
  if (startingCommit && hash !== startingCommit) {
    const diffOut = await git(['diff', '--name-only', '-z', startingCommit, 'HEAD'], ws.dir, '读取任务变更清单失败');
    ws.changedFiles = diffOut.split('\0').filter(Boolean);
  } else {
    ws.changedFiles = changed;
  }

  ws.commitHash = hash;
  log(`已确认提交 ${hash.slice(0, 10)}（${ws.changedFiles?.length ?? 0} 个文件）到分支 ${branch}`);

  // managed 模式：打包当前任务分支并回传给服务器
  if (ws.mode === 'managed') {
    if (!ws.worker || typeof ws.worker.uploadTaskResult !== 'function') throw new Error('managed mode requires worker to upload result bundle');
    const tempBundle = join(dirname(ws.dir), `.upload-${ws.taskId}-${randomUUID()}.bundle`);
    log(`managed 模式：正在为任务 ${ws.taskId} 生成结果 bundle...`);
    try {
      await git(['bundle', 'create', tempBundle, branch], ws.dir, '生成任务结果 bundle 失败');
      const buf = readFileSync(tempBundle);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      log(`正在上传任务 ${ws.taskId} 的结果 bundle（${buf.byteLength} 字节）...`);
      const res = await ws.worker.uploadTaskResult(ws.taskId, buf, sha256, ws.attempt);
      log(`任务结果已存入服务器仓库：${res.taskRef}@${res.headCommit.slice(0, 8)}`);
      return hash;
    } finally {
      rmSync(tempBundle, { force: true });
    }
  }
  // legacy repo 模式：push 默认关闭；WORKER_PUSH=1 时推送任务分支
  if (ws.push) {
    const p = await runGit(['push', '-u', 'origin', branch], ws.dir);
    if (p.code === 0) log(`已推送分支 ${branch} → origin`);
    else log(`push 失败（成果仍在本地工作区，可稍后手动推送）：${tail(p.stderr)}`);
  }
  return hash;
}
