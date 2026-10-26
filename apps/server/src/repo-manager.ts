// Server-owned bare Git repositories. Only fixed, structured operations reach this module;
// callers never pass shell fragments or server filesystem paths.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { getBoard, setBoardRepoState, type Board } from './tasks.ts';
import { withWrite, logEvent } from './write.ts';

export type RepoInitMode = 'empty' | 'clone';

function validRemote(remote: string): boolean {
  if (!remote || remote.length > 2048 || /[\u0000-\u001f\u007f]/.test(remote) || remote.startsWith('-')) return false;
  if (/^https:\/\//i.test(remote)) {
    try {
      const u = new URL(remote);
      return !u.username && !u.password && !!u.hostname && !u.search && !u.hash;
    } catch { return false; }
  }
  if (/^ssh:\/\//i.test(remote)) {
    try {
      const u = new URL(remote);
      return !!u.hostname && !!u.username && !u.password && !u.search && !u.hash;
    } catch { return false; }
  }
  return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(remote);
}

function runGit(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'https:ssh:file',
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'AsterHive Server',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'server@asterhive.internal',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'AsterHive Server',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'server@asterhive.internal',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function safeError(stderr: string): string {
  // Remote URL 可能含组织私有信息；错误只回脱敏摘要，不原样回显 URL/凭据。
  return stderr.replace(/https?:\/\/\S+/gi, '[remote]').replace(/git@[A-Za-z0-9.-]+:\S+/gi, '[remote]').slice(-1200);
}

export class RepoManager {
  readonly root: string;
  #jobs = new Map<string, Promise<void>>();
  #ctx: Ctx;

  constructor(ctx: Ctx) {
    this.#ctx = ctx;
    this.root = join(ctx.cfg.dataDir, 'repos');
    mkdirSync(this.root, { recursive: true });
  }

  recoverQueuedJobs(): void {
    // 仅由生产 main.ts 在 server startup 调用一次；createApp 测试/嵌入时不副作用恢复。
    for (const board of this.#ctx.holder.db.prepare("SELECT id, repo_source FROM board WHERE repo_mode='managed' AND repo_status='queued'").all() as { id: string; repo_source: string }[]) {
      const dest = this.repoPath(board.id);
      if (existsSync(dest) || this.#jobs.has(board.id)) continue;
      const mode: RepoInitMode = board.repo_source ? 'clone' : 'empty';
      const temp = join(this.root, `.tmp-${board.id}-${randomUUID()}.git`);
      const job = Promise.resolve().then(() => this.#initializeJob(board.id, mode, board.repo_source || undefined, temp, dest)).finally(() => {
        if (this.#jobs.get(board.id) === job) this.#jobs.delete(board.id);
      });
      this.#jobs.set(board.id, job);
    }
  }

  status(boardId: string): Board { return getBoard(this.#ctx, boardId); }

  repoPath(boardId: string): string {
    // board id 仅接受数据库已规范化 id，并拒绝路径元字符。
    if (!/^[a-z0-9-]{1,120}$/.test(boardId)) throw new HttpError(422, 'invalid board id for repository');
    return join(this.root, `${boardId}.git`);
  }

  initialize(boardId: string, mode: RepoInitMode, remote?: string): { status: 'queued' | 'ready' } {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    if (mode === 'clone' && (!remote || !validRemote(remote))) throw new HttpError(422, 'remote must be a valid HTTPS or SSH Git URL without embedded credentials');
    const destination = this.repoPath(boardId);
    if (this.#jobs.has(boardId)) throw new HttpError(409, 'repository initialization already running');
    if (existsSync(destination)) throw new HttpError(409, 'server repository already exists');
    setBoardRepoState(this.#ctx, boardId, { status: 'queued', error: '', head: '' });
    const temp = join(this.root, `.tmp-${boardId}-${randomUUID()}.git`);
    const job = Promise.resolve().then(() => this.#initializeJob(boardId, mode, remote, temp, destination)).finally(() => {
      if (this.#jobs.get(boardId) === job) this.#jobs.delete(boardId);
    });
    this.#jobs.set(boardId, job);
    return { status: 'queued' };
  }

  async #initializeJob(boardId: string, mode: RepoInitMode, remote: string | undefined, temp: string, destination: string): Promise<void> {
    try {
      setBoardRepoState(this.#ctx, boardId, { status: 'running' });
      if (mode === 'empty') {
        const init = await runGit(['init', '--bare', '--initial-branch=main', temp]);
        if (init.code !== 0) throw new Error(safeError(init.stderr));
      } else {
        const clone = await runGit(['clone', '--bare', '--', remote!, temp]);
        if (clone.code !== 0) throw new Error(safeError(clone.stderr));
      }
      if (existsSync(destination)) throw new Error('repository destination already exists; refusing to overwrite');
      renameSync(temp, destination);
      const head = await runGit(['rev-parse', 'HEAD'], destination);
      const candidateHead = head.code === 0 ? head.stdout.trim() : '';
      const headHash = /^[0-9a-f]{40,64}$/i.test(candidateHead) ? candidateHead : '';
      setBoardRepoState(this.#ctx, boardId, { status: 'ready', head: headHash });
      withWrite(this.#ctx, 'repo.initialized', () => logEvent(this.#ctx, 'repo.initialized', { boardId, mode, head: headHash }));
    } catch (err) {
      rmSync(temp, { recursive: true, force: true });
      const reason = safeError(err instanceof Error ? err.message : String(err));
      setBoardRepoState(this.#ctx, boardId, { status: 'failed', error: reason });
      withWrite(this.#ctx, 'repo.initialization_failed', () => logEvent(this.#ctx, 'repo.initialization_failed', { boardId, mode, reason }));
    }
  }

  async importBundle(
    boardId: string,
    chunks: AsyncIterable<Uint8Array>,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<{ head: string; refs: string[] }> {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    if (board.repoStatus !== 'empty' && board.repoStatus !== 'failed' && board.repoStatus !== 'ready') {
      throw new HttpError(409, 'server repository must be empty, ready or failed before import');
    }
    const repo = this.repoPath(boardId);
    if (!existsSync(repo)) {
      // 允许对直接切换为 managed 的老看板自动补齐 bare repo
      mkdirSync(repo, { recursive: true, mode: 0o700 });
      const init = await runGit(['init', '--bare', '--initial-branch=main', repo]);
      if (init.code !== 0) throw new HttpError(500, `failed to initialize bare repo for migration: ${safeError(init.stderr)}`);
    }
    const maxBytes = Number(process.env.ASTERHIVE_MAX_IMPORT_BYTES ?? 536_870_912);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) {
      throw new HttpError(413, `Git bundle size must be 1..${maxBytes} bytes`);
    }
    if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new HttpError(422, 'x-content-sha256 must be 64 hex characters');

    const tempDir = join(this.root, `.upload-${boardId}-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const bundle = join(tempDir, 'import.bundle');
    const output = createWriteStream(bundle, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of chunks) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes || bytes > expectedBytes) throw new HttpError(413, 'Git bundle exceeds declared size limit');
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'finish');
      if (bytes !== expectedBytes) throw new HttpError(400, 'Git bundle length does not match Content-Length');
      if (hash.digest('hex').toLowerCase() !== expectedSha256.toLowerCase()) throw new HttpError(400, 'Git bundle SHA-256 mismatch');

      const verify = await runGit(['bundle', 'verify', bundle], repo);
      if (verify.code !== 0) throw new HttpError(422, `invalid or non-self-contained Git bundle: ${safeError(verify.stderr)}`);
      const listed = await runGit(['bundle', 'list-heads', bundle], repo);
      if (listed.code !== 0) throw new HttpError(422, 'Git bundle contains no readable refs');
      const refs = listed.stdout.split('\n').map((line) => line.trim().split(/\s+/)[1]).filter((ref): ref is string => {
        if (!ref || (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))) return false;
        return ref.split('/').every((part) => /^[A-Za-z0-9._-]+$/.test(part));
      });
      const branches = refs.filter((ref) => ref.startsWith('refs/heads/'));
      if (!branches.length) throw new HttpError(422, 'Git bundle must contain at least one branch');
      const fetched = await runGit(['fetch', bundle, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], repo);
      if (fetched.code !== 0) throw new HttpError(422, `Git bundle import failed: ${safeError(fetched.stderr)}`);
      const defaultBranch = branches.includes('refs/heads/main') ? 'main'
        : branches.includes('refs/heads/master') ? 'master'
          : branches[0]!.slice('refs/heads/'.length);
      const symbolic = await runGit(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], repo);
      if (symbolic.code !== 0) throw new HttpError(422, 'could not set imported default branch');
      const headResult = await runGit(['rev-parse', 'HEAD'], repo);
      if (headResult.code !== 0) throw new HttpError(422, 'imported repository has no resolvable HEAD');
      const head = headResult.stdout.trim();
      setBoardRepoState(this.#ctx, boardId, { status: 'ready', head, source: '' });
      withWrite(this.#ctx, 'repo.imported', () => logEvent(this.#ctx, 'repo.imported', { boardId, head, refs, bytes }));
      return { head, refs };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `Git bundle import failed: ${safeError(err instanceof Error ? err.message : String(err))}`);
    } finally {
      output.destroy();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async exportTaskSnapshot(boardId: string, taskId: string): Promise<{ bundlePath: string; baseCommit: string; cleanup: () => void }> {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    if (board.repoStatus !== 'ready') throw new HttpError(409, `server repository is not ready (${board.repoStatus})`);
    const repo = this.repoPath(boardId);
    if (!existsSync(repo)) throw new HttpError(409, 'server repository does not exist');
    const rev = await runGit(['rev-parse', 'HEAD'], repo);
    if (rev.code !== 0 || !rev.stdout.trim()) throw new HttpError(422, 'server repository has no resolvable HEAD');
    const baseCommit = rev.stdout.trim();
    const tempDir = join(this.root, `.snap-${boardId}-${taskId}-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const bundle = join(tempDir, 'snapshot.bundle');
    const created = await runGit(['bundle', 'create', bundle, 'HEAD'], repo);
    if (created.code !== 0) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new HttpError(500, `failed to generate task snapshot bundle: ${safeError(created.stderr)}`);
    }
    return {
      bundlePath: bundle,
      baseCommit,
      cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  async importTaskResult(
    boardId: string,
    taskId: string,
    chunks: AsyncIterable<Uint8Array>,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<{ taskRef: string; headCommit: string }> {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    const repo = this.repoPath(boardId);
    if (!existsSync(repo)) throw new HttpError(409, 'server repository does not exist');
    const maxBytes = Number(process.env.ASTERHIVE_MAX_IMPORT_BYTES ?? 536_870_912);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes) {
      throw new HttpError(413, `Git bundle size must be 1..${maxBytes} bytes`);
    }
    if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new HttpError(422, 'x-content-sha256 must be 64 hex characters');

    const tempDir = join(this.root, `.task-res-${boardId}-${taskId}-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const bundle = join(tempDir, 'result.bundle');
    const output = createWriteStream(bundle, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of chunks) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes || bytes > expectedBytes) throw new HttpError(413, 'Git bundle exceeds declared size limit');
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'finish');
      if (bytes !== expectedBytes) throw new HttpError(400, 'Git bundle length does not match Content-Length');
      if (hash.digest('hex').toLowerCase() !== expectedSha256.toLowerCase()) throw new HttpError(400, 'Git bundle SHA-256 mismatch');

      const verify = await runGit(['bundle', 'verify', bundle], repo);
      if (verify.code !== 0) throw new HttpError(422, `invalid or non-self-contained result bundle: ${safeError(verify.stderr)}`);
      const listed = await runGit(['bundle', 'list-heads', bundle], repo);
      if (listed.code !== 0) throw new HttpError(422, 'result bundle contains no readable refs');
      const lines = listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      // 提取分支并统一存入 refs/asterhive/tasks/<taskId>
      const taskBranch = lines.find((l) => l.includes(`refs/heads/asterhive/${taskId}`)) ?? lines[0];
      if (!taskBranch) throw new HttpError(422, `bundle must contain a task ref or branch for ${taskId}`);
      const [commit, refName] = taskBranch.split(/\s+/);
      if (!commit || !refName) throw new HttpError(422, 'malformed ref line in bundle');

      const targetRef = `refs/asterhive/tasks/${taskId}`;
      const fetched = await runGit(['fetch', bundle, `+${refName}:${targetRef}`], repo);
      if (fetched.code !== 0) throw new HttpError(422, `failed to store task result ref: ${safeError(fetched.stderr)}`);

      withWrite(this.#ctx, 'repo.task_stored', () => logEvent(this.#ctx, 'repo.task_stored', { boardId, taskId, targetRef, commit }));
      return { taskRef: targetRef, headCommit: commit };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `Task result bundle import failed: ${safeError(err instanceof Error ? err.message : String(err))}`);
    } finally {
      output.destroy();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async inspectTask(boardId: string, taskId: string): Promise<{ base: string; head: string; diffStat: string; changedFiles: string[] }> {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    const repo = this.repoPath(boardId);
    const targetRef = `refs/asterhive/tasks/${taskId}`;
    const headRes = await runGit(['rev-parse', targetRef], repo);
    if (headRes.code !== 0 || !headRes.stdout.trim()) throw new HttpError(404, `task ref ${targetRef} not found`);
    const head = headRes.stdout.trim();
    const baseRes = await runGit(['merge-base', 'HEAD', targetRef], repo);
    if (baseRes.code !== 0 || !baseRes.stdout.trim()) throw new HttpError(422, 'no common ancestor between master and task');
    const base = baseRes.stdout.trim();
    const statRes = await runGit(['diff', '--stat', base, head], repo);
    const filesRes = await runGit(['diff', '--name-only', base, head], repo);
    return {
      base,
      head,
      diffStat: statRes.stdout.slice(-2000),
      changedFiles: filesRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean),
    };
  }

  async integrateTask(boardId: string, taskId: string): Promise<{ mergedCommit: string }> {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    const repo = this.repoPath(boardId);
    const targetRef = `refs/asterhive/tasks/${taskId}`;
    const headRes = await runGit(['rev-parse', targetRef], repo);
    if (headRes.code !== 0 || !headRes.stdout.trim()) throw new HttpError(404, `task ref ${targetRef} not found`);
    const taskCommit = headRes.stdout.trim();

    // 结构化合并：在临时工作树中尝试 merge，无冲突则推进 master 并打审计日志
    const tempWork = join(this.root, `.integrate-${boardId}-${taskId}-${randomUUID()}`);
    mkdirSync(tempWork, { recursive: true, mode: 0o700 });
    try {
      const clone = await runGit(['clone', '--local', repo, tempWork]);
      if (clone.code !== 0) throw new HttpError(500, `integrate workspace setup failed: ${safeError(clone.stderr)}`);
      const fetchTask = await runGit(['fetch', 'origin', `+${targetRef}:refs/remotes/origin/task-${taskId}`], tempWork);
      if (fetchTask.code !== 0) throw new HttpError(500, `integrate task fetch failed: ${safeError(fetchTask.stderr)}`);
      
      const merge = await runGit([
        'merge',
        '--no-ff',
        '-m',
        `Integrate task ${taskId} into main`,
        `refs/remotes/origin/task-${taskId}`,
      ], tempWork);
      if (merge.code !== 0) {
        const status = await runGit(['status', '--short'], tempWork);
        throw new HttpError(409, `Merge conflict integrating task ${taskId} (merge code ${merge.code}): ${merge.stderr}\n${status.stdout.slice(-1500)}`);
      }
      const push = await runGit(['push', 'origin', 'HEAD:refs/heads/main'], tempWork);
      if (push.code !== 0) throw new HttpError(500, `failed to push integrated master: ${safeError(push.stderr)}`);
      const newHeadRes = await runGit(['rev-parse', 'HEAD'], repo);
      const mergedCommit = newHeadRes.stdout.trim();
      setBoardRepoState(this.#ctx, boardId, { status: 'ready', head: mergedCommit });
      withWrite(this.#ctx, 'repo.task_integrated', () => logEvent(this.#ctx, 'repo.task_integrated', { boardId, taskId, taskCommit, mergedCommit }));
      return { mergedCommit };
    } finally {
      rmSync(tempWork, { recursive: true, force: true });
    }
  }

  async waitForJob(boardId: string): Promise<void> {
    await this.#jobs.get(boardId);
  }
}
