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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Worker } from '@asterhive/sdk';

export interface PreparedWorkspace {
  dir: string;                         // 实际执行 cwd
  mode: 'repo' | 'scratch' | 'managed'; // repo=持久克隆；scratch=无 repo 一次性目录；managed=服务端托管临时快照
  taskId: string;                      // 所属任务号
  branch?: string;                     // 任务分支
  commitHash?: string;                 // 执行后提交的 hash
  pulled?: boolean;                    // 是否执行了 pull --rebase
  cloned?: boolean;                    // 是否新 clone
  changedFiles?: string[];             // 变更文件
  push?: boolean;
  worker?: Worker;                     // managed 模式回传 bundle 用
  cleanup?: () => void;                // 临时目录销毁钩子
  log?: (s: string) => void;
}

export interface PrepareWorkspaceOptions {
  workdirRoot: string;
  boardId: string;
  taskId: string;
  repo?: string | null;                // legacy repo URL
  repoMode?: 'managed' | 'remote-legacy';
  worker?: Worker;
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
    mkdirSync(baseDir, { recursive: true });
    const bundleFile = join(baseDir, 'snapshot.bundle');
    const worktreeDir = join(baseDir, 'src');
    log(`managed 模式：从服务器下载任务 ${opts.taskId} 的代码快照...`);
    const snap = await opts.worker.downloadTaskSnapshot(opts.taskId);
    writeFileSync(bundleFile, Buffer.from(snap.buffer));
    log(`快照下载完毕（${snap.buffer.byteLength} 字节，基线 ${snap.baseCommit.slice(0, 8)}），解包工作树...`);
    await git(['clone', bundleFile, worktreeDir], baseDir, '解包快照 bundle 失败');
    const branch = `asterhive/${opts.taskId}`;
    await git(['checkout', '-b', branch], worktreeDir, '创建任务分支失败');
    return {
      dir: worktreeDir,
      mode: 'managed',
      taskId: opts.taskId,
      branch,
      worker: opts.worker,
      cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
      log,
    };
  }

  // ---- scratch 模式（现状行为原样保留）：无 repo 的一次性任务目录，mkdir 即用 ----
  if (!repo) {
    const dir = join(opts.workdirRoot, opts.taskId);
    mkdirSync(dir, { recursive: true });
    return { dir, mode: 'scratch', taskId: opts.taskId };
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

  // 干活前切任务分支：新建；同名分支已存在（同任务重做/续做）则复用并提示
  const co = await runGit(['checkout', '-b', branch], dir);
  if (co.code !== 0) {
    log(`分支 ${branch} 已存在，复用现有分支（${tail(co.stderr)}）`);
    await git(['checkout', branch], dir, '切换任务分支失败，需人工处理');
  }

  return { dir, mode: 'repo', taskId: opts.taskId, branch, cloned, pulled, push: opts.push, log };
}

/** 任务结束后提交成果（repo/managed 模式）：有变更才 commit，返回 hash；无变更返回 undefined。永不自动 push 除非 ws.push */
export async function commitWorkspace(ws: PreparedWorkspace, message: string): Promise<string | undefined> {
  if (ws.mode === 'scratch') return undefined; // scratch 模式无 git 语义
  const log = ws.log ?? (() => {});
  const branch = ws.branch!;

  // 先看有没有变更（此时还没 add，porcelain 覆盖未跟踪/已修改/已暂存/已删除）
  const st = await git(['status', '--porcelain', '-z'], ws.dir, '读取工作区状态失败');
  const changed = parseStatusZ(st);
  if (changed.length === 0) {
    log('工作区无文件变更，不产生提交');
    return undefined;
  }

  // author 用设备 git 全局配置，不代设（没有配置时 commit 失败并带出原因）
  await git(['add', '-A'], ws.dir, '暂存变更失败');
  await git(['commit', '-m', `asterhive(${ws.taskId}): ${message}`], ws.dir, '提交失败（检查设备 git 全局 user.name/email 配置）');
  const hash = (await git(['rev-parse', 'HEAD'], ws.dir, '读取提交 hash 失败')).trim();
  ws.commitHash = hash;
  ws.changedFiles = changed;
  log(`已提交 ${hash.slice(0, 10)}（${changed.length} 个文件）到分支 ${branch}`);

  // managed 模式：打包当前任务分支并回传给服务器
  if (ws.mode === 'managed') {
    if (!ws.worker) throw new Error('managed mode requires worker to upload result bundle');
    const resultBundle = join(ws.dir, 'result.bundle');
    log(`managed 模式：正在为任务 ${ws.taskId} 生成结果 bundle...`);
    await git(['bundle', 'create', resultBundle, branch], ws.dir, '生成任务结果 bundle 失败');
    const buf = readFileSync(resultBundle);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    log(`正在上传任务 ${ws.taskId} 的结果 bundle（${buf.byteLength} 字节）...`);
    const res = await ws.worker.uploadTaskResult(ws.taskId, buf, sha256);
    log(`任务结果已存入服务器仓库：${res.taskRef}@${res.headCommit.slice(0, 8)}`);
    return hash;
  }

  // legacy repo 模式：push 默认关闭；WORKER_PUSH=1 时推送任务分支
  if (ws.push) {
    const p = await runGit(['push', '-u', 'origin', branch], ws.dir);
    if (p.code === 0) log(`已推送分支 ${branch} → origin`);
    else log(`push 失败（成果仍在本地工作区，可稍后手动推送）：${tail(p.stderr)}`);
  }
  return hash;
}
