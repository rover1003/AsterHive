// Server-owned bare Git repositories. Only fixed, structured operations reach this module;
// callers never pass shell fragments or server filesystem paths.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { getBoard, getTask, setBoardRepoState, updateTask, type Board, type Task } from './tasks.ts';
import type { Agent } from './agents.ts';
import { withWrite, logEvent } from './write.ts';
import { withTaskIntegrationLock } from './task-integration-lock.ts';

export type RepoInitMode = 'empty' | 'clone';

export interface RepoTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'submodule';
  size?: number;
  mode: string;
}

export interface RepoTreeResult {
  boardId: string;
  commit: string;
  path: string;
  entries: RepoTreeEntry[];
  truncated: boolean;
  total: number;
}

export interface RepoFileContent {
  boardId: string;
  commit: string;
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  totalLines: number;
}

const BINARY_EXTENSIONS: Record<string, true> = {
  '.png': true, '.jpg': true, '.jpeg': true, '.gif': true, '.ico': true, '.webp': true, '.bmp': true, '.tiff': true,
  '.pdf': true, '.zip': true, '.tar': true, '.gz': true, '.tgz': true, '.7z': true, '.rar': true, '.bz2': true, '.xz': true,
  '.exe': true, '.dll': true, '.so': true, '.dylib': true, '.bin': true, '.iso': true, '.dmg': true, '.class': true,
  '.jar': true, '.war': true, '.pyc': true, '.pyo': true, '.wasm': true, '.mp3': true, '.mp4': true, '.wav': true,
  '.ogg': true, '.flac': true, '.avi': true, '.mov': true, '.mkv': true, '.db': true, '.sqlite': true, '.sqlite3': true,
  '.ttf': true, '.woff': true, '.woff2': true, '.eot': true,
};

export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : '';
  return Boolean(BINARY_EXTENSIONS[ext]);
}

export function hasNullBytes(sample: string): boolean {
  return sample.includes('\0');
}

export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const baseName = parts[parts.length - 1] ?? '';

  // .env and variations
  if (baseName === '.env' || baseName.startsWith('.env.')) return true;

  // Private keys and certificates
  if (/\.(pem|key|pkcs12|pfx|p12|kdbx)$/i.test(baseName)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i.test(baseName)) {
    return true;
  }

  // Common secret configuration files
  if (
    /^(credentials|secret|secrets|token|tokens|masterkey)(\..+)?$/i.test(baseName) ||
    /(credentials|secrets?|tokens?|api[-_]?keys?)\.(json|ya?ml|toml|txt|conf|ini|properties)$/i.test(baseName)
  ) {
    return true;
  }

  // Password files
  if (baseName === '.htpasswd' || baseName === 'htpasswd') return true;

  // Sensitive hidden directory names
  if (parts.some((p) => p === '.aws' || p === '.ssh' || p === '.gnupg' || p === '.git')) return true;

  return false;
}

/**
 * 基于常见凭据格式与键值特征的启发式输出遮蔽。
 * 注意：本函数针对通用凭据模式（私钥块、特定前缀 Token、常见密码与 API 密钥键值等）提供纵深防御，
 * 无法保证对所有隐蔽、混淆或未知编码凭据的 100% 绝对通用检测。
 */
export function maskSensitiveContent(rawText: string): { content: string; redactedCount: number } {
  let redactedCount = 0;
  let text = rawText;

  // 1. PEM 格式私钥块
  const privateKeyPattern = /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]*PRIVATE KEY-----/g;
  text = text.replace(privateKeyPattern, () => {
    redactedCount++;
    return '[REDACTED_PRIVATE_KEY]';
  });

  // 2. 特征前缀 API Key / Token（如 sk-..., ghp_..., AKIA...）
  const prefixedTokens = /\b(?:(?:sk|pk|rk)-(?:live|test|proj|ant)?[a-zA-Z0-9_-]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]{20,}|xox[baprs]-[0-9a-zA-Z]{10,48}|(?:AKIA|ASIA|AROA)[0-9A-Z]{16})\b/g;
  text = text.replace(prefixedTokens, () => {
    redactedCount++;
    return '[REDACTED_TOKEN]';
  });

  // 3. Bearer Token
  const bearerPattern = /\bBearer\s+([a-zA-Z0-9._~+/-]{20,})/gi;
  text = text.replace(bearerPattern, () => {
    redactedCount++;
    return 'Bearer [REDACTED_TOKEN]';
  });

  // 4. JSON / YAML / 代码中常见密码与密钥键值对（支持嵌套、单双引号与不同分隔符）
  const keyValueSecretPattern = /(["']?(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|db[_-]?password|private[_-]?key)["']?\s*[:=]\s*)(["'])(?:(?!\2).){6,}\2/gi;
  text = text.replace(keyValueSecretPattern, (_match, prefix, quote) => {
    redactedCount++;
    return `${prefix}${quote}[REDACTED_SECRET]${quote}`;
  });

  return { content: text, redactedCount };
}

export function sanitizeRepoPath(rawPath?: string): string {
  if (!rawPath) return '';
  if (typeof rawPath !== 'string') throw new HttpError(400, 'path must be a string');
  if (rawPath.includes('\0')) throw new HttpError(400, 'path contains illegal null character');

  const normalized = rawPath.replace(/\\/g, '/').trim();
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new HttpError(400, 'absolute paths with drive letters are not allowed');
  }

  const clean = normalized.replace(/^\/+|\/+$/g, '');
  if (!clean || clean === '.') return '';

  const segments = clean.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      throw new HttpError(400, 'path traversal (..) is not allowed');
    }
    if (seg.startsWith('-')) {
      throw new HttpError(400, 'path segments starting with hyphen are not allowed');
    }
    if (seg.length > 255) {
      throw new HttpError(400, 'path segment exceeds maximum length');
    }
    resolved.push(seg);
  }
  return resolved.join('/');
}

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

function runGit(args: string[], cwd?: string, allowLocalTransport = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: allowLocalTransport ? 'https:ssh:file' : 'https:ssh',
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
    const maxBytes = Number(process.env.ASTERHIVE_MAX_IMPORT_BYTES ?? 2 * 1024 * 1024 * 1024); // 默认允许至 2GiB
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
      const fetched = await runGit(['fetch', bundle, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], repo, true);
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

  async exportTaskSnapshot(
    boardId: string,
    taskId: string,
  ): Promise<{ bundlePath: string; baseCommit: string; reworkCommit?: string; reworkBranch?: string; cleanup: () => void }> {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    if (board.repoStatus !== 'ready') throw new HttpError(409, `server repository is not ready (${board.repoStatus})`);
    const repo = this.repoPath(boardId);
    if (!existsSync(repo)) throw new HttpError(409, 'server repository does not exist');

    // 1. 保留任务原始 baseCommit：若已存在则直接沿用，绝不可用当前最新 HEAD 覆盖旧 base
    const baseRef = `refs/asterhive/task-bases/${taskId}`;
    let baseCommit = '';
    const storedBase = await runGit(['rev-parse', '--verify', baseRef], repo);
    if (storedBase.code === 0 && storedBase.stdout.trim()) {
      baseCommit = storedBase.stdout.trim();
    } else {
      const rev = await runGit(['rev-parse', 'HEAD'], repo);
      if (rev.code !== 0 || !rev.stdout.trim()) throw new HttpError(422, 'server repository has no resolvable HEAD');
      baseCommit = rev.stdout.trim();
      const saveBase = await runGit(['update-ref', baseRef, baseCommit], repo);
      if (saveBase.code !== 0) {
        throw new HttpError(500, `failed to record task snapshot base: ${safeError(saveBase.stderr)}`);
      }
    }

    // 2. 检查是否存在上一轮执行提交的 task ref (refs/asterhive/tasks/${taskId})
    const taskRef = `refs/asterhive/tasks/${taskId}`;
    let reworkCommit: string | undefined;
    let reworkBranch: string | undefined;
    const taskRefCheck = await runGit(['rev-parse', '--verify', taskRef], repo);
    if (taskRefCheck.code === 0 && taskRefCheck.stdout.trim()) {
      reworkCommit = taskRefCheck.stdout.trim();
      reworkBranch = `asterhive/${taskId}`;
      // 同时在裸仓保留/更新 refs/heads/asterhive/${taskId}，使得 git clone 时工蜂可直接检出分支
      const updated = await runGit(['update-ref', `refs/heads/asterhive/${taskId}`, reworkCommit], repo);
      if (updated.code !== 0) throw new HttpError(500, `failed to prepare rework branch: ${safeError(updated.stderr)}`);
    }

    const tempDir = join(this.root, `.snap-${boardId}-${taskId}-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    const bundle = join(tempDir, 'snapshot.bundle');

    // 3. 构建 bundle：包含 HEAD 以及上一代 task ref / branch
    const bundleArgs = ['bundle', 'create', bundle, 'HEAD', baseRef];
    if (reworkCommit) {
      bundleArgs.push(taskRef, `refs/heads/asterhive/${taskId}`);
    }
    const created = await runGit(bundleArgs, repo);
    if (created.code !== 0) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new HttpError(500, `failed to generate task snapshot bundle: ${safeError(created.stderr)}`);
    }

    return {
      bundlePath: bundle,
      baseCommit,
      reworkCommit,
      reworkBranch,
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
    const maxBytes = Number(process.env.ASTERHIVE_MAX_IMPORT_BYTES ?? 2 * 1024 * 1024 * 1024); // 默认允许至 2GiB
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
      const fetched = await runGit(['fetch', bundle, `+${refName}:${targetRef}`], repo, true);
      if (fetched.code !== 0) throw new HttpError(422, `failed to store task result ref: ${safeError(fetched.stderr)}`);
      const update = await runGit(['update-ref', targetRef, commit], repo);
      if (update.code !== 0) throw new HttpError(422, `failed to finalize task result ref: ${safeError(update.stderr)}`);

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

  async inspectTask(boardId: string, taskId: string): Promise<{ base: string; head: string; diffStat: string; changedFiles: string[]; diffText: string; diffTruncated: boolean }> {
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    const repo = this.repoPath(boardId);
    const targetRef = `refs/asterhive/tasks/${taskId}`;
    const headRes = await runGit(['rev-parse', targetRef], repo);
    if (headRes.code !== 0 || !headRes.stdout.trim()) {
      throw new HttpError(404, `task ref ${targetRef} not found; confirm the worker successfully uploaded a task result bundle via POST /tasks/${taskId}/repo-result (HTTP 200), then retry review`);
    }
    const head = headRes.stdout.trim();
    const taskRow = this.#ctx.holder.db.prepare('SELECT review_summary, submit_summary, review_status FROM task WHERE id=? AND board_id=?').get(taskId, boardId) as { review_summary: string; submit_summary: string; review_status: string } | undefined;
    if (!taskRow) throw new HttpError(404, `task not found: ${taskId}`);
    const baseRef = `refs/asterhive/task-bases/${taskId}`;
    let base = '';
    const storedBase = await runGit(['rev-parse', '--verify', baseRef], repo);
    if (storedBase.code === 0 && storedBase.stdout.trim()) {
      base = storedBase.stdout.trim();
    } else {
      const parentRes = await runGit(['rev-list', '--max-parents=0', head], repo);
      if (parentRes.code !== 0 || !parentRes.stdout.trim()) throw new HttpError(422, 'task branch has no verifiable base commit');
      base = parentRes.stdout.trim();
    }
    const statRes = await runGit(['diff', '--stat', base, head], repo);
    const filesRes = await runGit(['diff', '--name-only', base, head], repo);
    const diffRes = await runGit(['diff', '-p', base, head], repo);
    const diffText = diffRes.stdout.slice(0, 50_000);
    return {
      base,
      head,
      diffStat: statRes.stdout.slice(-2000),
      changedFiles: filesRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean),
      diffText,
      diffTruncated: diffRes.stdout.length > diffText.length,
    };
  }

  async integrateTask(boardId: string, taskId: string): Promise<{ mergedCommit: string }> {
    return withTaskIntegrationLock(taskId, () => this.#integrateTask(boardId, taskId));
  }

  async acceptManualTask(taskId: string, actor: Agent): Promise<{ task: Task; mergedCommit: string | null }> {
    if (actor.role !== 'user') throw new HttpError(403, '人工验收仅允许用户操作');
    return withTaskIntegrationLock(taskId, async () => {
      const task = getTask(this.#ctx, taskId);
      if (task.status !== 'active' || task.lane !== 'Review') throw new HttpError(409, '任务不在待验收状态');
      if (task.reviewStatus === 'reviewing') throw new HttpError(409, '独立审核正在进行，请等待审核结束');
      const board = getBoard(this.#ctx, task.boardId);
      const repo = this.repoPath(board.id);
      const targetRef = `refs/asterhive/tasks/${task.id}`;
      const hasTaskRef = board.repoMode === 'managed' && existsSync(repo)
        ? (await runGit(['rev-parse', '--verify', targetRef], repo)).code === 0
        : false;
      const shouldIntegrate = board.repoMode === 'managed' && task.workspace.noCode !== true && hasTaskRef;
      const mergedCommit = shouldIntegrate
        ? (await this.#integrateTask(task.boardId, task.id)).mergedCommit
        : null;
      const done = updateTask(this.#ctx, actor, task.id, { lane: 'Done' }, { integratedManagedCode: mergedCommit !== null, manualAcceptance: true });
      return { task: done, mergedCommit };
    });
  }

  async #integrateTask(boardId: string, taskId: string): Promise<{ mergedCommit: string }> {
    const board = getBoard(this.#ctx, boardId);
    const task = getTask(this.#ctx, taskId);
    if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
    if (task.lane !== 'Review') throw new HttpError(409, `task ${taskId} is not in Review`);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    const repo = this.repoPath(boardId);
    const targetRef = `refs/asterhive/tasks/${taskId}`;
    const headRes = await runGit(['rev-parse', targetRef], repo);
    if (headRes.code !== 0 || !headRes.stdout.trim()) {
      throw new HttpError(404, `task ref ${targetRef} not found; confirm the worker successfully uploaded a task result bundle via POST /tasks/${taskId}/repo-result (HTTP 200), then retry integration`);
    }
    const taskCommit = headRes.stdout.trim();

    // 结构化合并：在临时工作树中尝试 merge 到 bare 仓库 HEAD 指向的默认分支
    const tempWork = join(this.root, `.integrate-${boardId}-${taskId}-${randomUUID()}`);
    mkdirSync(tempWork, { recursive: true, mode: 0o700 });
    try {
      const defaultRefRes = await runGit(['symbolic-ref', 'HEAD'], repo);
      if (defaultRefRes.code !== 0 || !defaultRefRes.stdout.trim().startsWith('refs/heads/')) {
        throw new HttpError(409, 'server repository default branch is not configured');
      }
      const defaultRef = defaultRefRes.stdout.trim();
      const defaultBranch = defaultRef.slice('refs/heads/'.length);
      const clone = await runGit(['clone', '--local', repo, tempWork], undefined, true);
      if (clone.code !== 0) throw new HttpError(500, `integrate workspace setup failed: ${safeError(clone.stderr)}`);
      const fetchTask = await runGit(['fetch', 'origin', `+${targetRef}:refs/remotes/origin/task-${taskId}`], tempWork, true);
      if (fetchTask.code !== 0) throw new HttpError(500, `integrate task fetch failed: ${safeError(fetchTask.stderr)}`);
      const checkout = await runGit(['checkout', defaultBranch], tempWork);
      if (checkout.code !== 0) throw new HttpError(500, `could not checkout default branch ${defaultBranch}: ${safeError(checkout.stderr)}`);
      
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
      const push = await runGit(['push', 'origin', `HEAD:${defaultRef}`], tempWork, true);
      if (push.code !== 0) throw new HttpError(500, `failed to push integrated default branch: ${safeError(push.stderr)}`);
      const newHeadRes = await runGit(['rev-parse', defaultRef], repo);
      const mergedCommit = newHeadRes.stdout.trim();
      setBoardRepoState(this.#ctx, boardId, { status: 'ready', head: mergedCommit });
      withWrite(this.#ctx, 'repo.task_integrated', () => logEvent(this.#ctx, 'repo.task_integrated', { boardId, taskId, taskCommit, mergedCommit }));
      return { mergedCommit };
    } finally {
      rmSync(tempWork, { recursive: true, force: true });
    }
  }

  async listTree(
    boardId: string,
    options?: { path?: string; recursive?: boolean; limit?: number },
  ): Promise<RepoTreeResult> {
    const repo = this.repoPath(boardId);
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    if (board.repoStatus !== 'ready') throw new HttpError(409, `server repository is not ready (${board.repoStatus})`);
    if (!existsSync(repo)) throw new HttpError(409, 'server repository does not exist');

    const rev = await runGit(['rev-parse', 'HEAD'], repo);
    if (rev.code !== 0 || !rev.stdout.trim()) {
      throw new HttpError(409, 'server repository has no resolvable HEAD (repository may be empty)');
    }
    const headCommit = rev.stdout.trim();

    const cleanPath = sanitizeRepoPath(options?.path);
    if (cleanPath && isSensitivePath(cleanPath)) {
      throw new HttpError(403, `access to sensitive path '${cleanPath}' is prohibited`);
    }

    if (cleanPath) {
      const typeRes = await runGit(['cat-file', '-t', `HEAD:${cleanPath}`], repo);
      if (typeRes.code !== 0 || !typeRes.stdout.trim()) {
        throw new HttpError(404, `path '${cleanPath}' not found in repository HEAD`);
      }
      const objType = typeRes.stdout.trim();
      if (objType === 'blob') {
        throw new HttpError(400, `path '${cleanPath}' is a file, not a directory`);
      }
      if (objType !== 'tree') {
        throw new HttpError(400, `path '${cleanPath}' is not a directory (${objType})`);
      }
    }

    const lsArgs = ['ls-tree', '-l'];
    if (options?.recursive) {
      lsArgs.push('-r', '-t');
    }
    lsArgs.push(cleanPath ? `HEAD:${cleanPath}` : 'HEAD');

    const lsRes = await runGit(lsArgs, repo);
    if (lsRes.code !== 0) {
      throw new HttpError(500, `failed to list repository tree: ${safeError(lsRes.stderr)}`);
    }

    const allEntries: RepoTreeEntry[] = [];
    const lines = lsRes.stdout.split('\n');
    for (const line of lines) {
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) continue;
      const meta = line.slice(0, tabIdx).trim();
      const rawEntryPath = line.slice(tabIdx + 1);
      const tokens = meta.split(/\s+/);
      if (tokens.length < 3) continue;
      const mode = tokens[0]!;
      const objType = tokens[1]!;
      const sizeStr = tokens[3];

      let entryType: RepoTreeEntry['type'] = 'file';
      if (mode === '120000') {
        entryType = 'symlink';
      } else if (objType === 'tree') {
        entryType = 'directory';
      } else if (objType === 'commit') {
        entryType = 'submodule';
      } else {
        entryType = 'file';
      }

      const entryRelPath = cleanPath ? `${cleanPath}/${rawEntryPath}` : rawEntryPath;
      const entryName = rawEntryPath.includes('/') ? rawEntryPath.slice(rawEntryPath.lastIndexOf('/') + 1) : rawEntryPath;
      // 严格拒绝在目录树中暴露敏感路径（如 .env、.ssh、private keys 等，含递归）
      if (isSensitivePath(entryRelPath) || isSensitivePath(entryName) || isSensitivePath(rawEntryPath)) {
        continue;
      }


      const entry: RepoTreeEntry = {
        name: entryName,
        path: entryRelPath,
        type: entryType,
        mode,
      };

      if (sizeStr && sizeStr !== '-') {
        const size = parseInt(sizeStr, 10);
        if (Number.isFinite(size)) entry.size = size;
      }

      allEntries.push(entry);
    }

    const limit = options?.limit !== undefined ? Math.max(1, options.limit) : 1000;
    const total = allEntries.length;
    const truncated = total > limit;
    const entries = truncated ? allEntries.slice(0, limit) : allEntries;

    return {
      boardId,
      commit: headCommit,
      path: cleanPath,
      entries,
      truncated,
      total,
    };
  }

  async readTextFile(
    boardId: string,
    filePath: string,
    options?: { maxBytes?: number },
  ): Promise<RepoFileContent> {
    const repo = this.repoPath(boardId);
    const board = getBoard(this.#ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    if (board.repoStatus !== 'ready') throw new HttpError(409, `server repository is not ready (${board.repoStatus})`);
    if (!existsSync(repo)) throw new HttpError(409, 'server repository does not exist');

    const rev = await runGit(['rev-parse', 'HEAD'], repo);
    if (rev.code !== 0 || !rev.stdout.trim()) {
      throw new HttpError(409, 'server repository has no resolvable HEAD (repository may be empty)');
    }
    const headCommit = rev.stdout.trim();

    const cleanPath = sanitizeRepoPath(filePath);
    if (!cleanPath) throw new HttpError(400, 'file path cannot be empty');

    if (isSensitivePath(cleanPath)) {
      throw new HttpError(403, `access to sensitive file '${cleanPath}' is prohibited`);
    }

    const typeRes = await runGit(['cat-file', '-t', `HEAD:${cleanPath}`], repo);
    if (typeRes.code !== 0 || !typeRes.stdout.trim()) {
      throw new HttpError(404, `path '${cleanPath}' not found in repository HEAD`);
    }
    const objType = typeRes.stdout.trim();
    if (objType === 'tree') {
      throw new HttpError(400, `path '${cleanPath}' is a directory, not a file; use asterhive_repo_list_files to list directories`);
    }
    if (objType !== 'blob') {
      throw new HttpError(400, `path '${cleanPath}' is not a readable file (${objType})`);
    }

    const lsTree = await runGit(['ls-tree', '-l', 'HEAD', '--', cleanPath], repo);
    if (lsTree.code === 0 && lsTree.stdout.trim()) {
      const firstLine = lsTree.stdout.trim().split('\n')[0]!;
      const mode = firstLine.split(/\s+/)[0];
      if (mode === '120000') {
        throw new HttpError(400, `path '${cleanPath}' is a symbolic link; symbolic links cannot be read`);
      }
    }

    if (hasBinaryExtension(cleanPath)) {
      throw new HttpError(415, `file '${cleanPath}' appears to be binary and cannot be read as text`);
    }

    const sizeRes = await runGit(['cat-file', '-s', `HEAD:${cleanPath}`], repo);
    const size = parseInt(sizeRes.stdout.trim(), 10) || 0;
    const HARD_MAX_BYTES = 10 * 1024 * 1024; // 10MB
    if (size > HARD_MAX_BYTES) {
      throw new HttpError(413, `file '${cleanPath}' (${size} bytes) exceeds maximum allowable size of 10MB`);
    }

    const contentRes = await runGit(['cat-file', '-p', `HEAD:${cleanPath}`], repo);
    if (contentRes.code !== 0) {
      throw new HttpError(500, `failed to read object content: ${safeError(contentRes.stderr)}`);
    }
    const rawContent = contentRes.stdout;

    if (hasNullBytes(rawContent)) {
      throw new HttpError(415, `file '${cleanPath}' appears to be binary and cannot be read as text`);
    }

    // 输出前敏感内容纵深遮蔽保护
    const { content: sanitizedContent } = maskSensitiveContent(rawContent);

    const DEFAULT_MAX_BYTES = 256 * 1024; // 256KB
    const requestedMax = options?.maxBytes ? Math.min(options.maxBytes, 1024 * 1024) : DEFAULT_MAX_BYTES;
    let truncated = false;
    let content = sanitizedContent;
    if (sanitizedContent.length > requestedMax) {
      content = sanitizedContent.slice(0, requestedMax);
      truncated = true;
    }
    const totalLines = sanitizedContent.length ? sanitizedContent.split('\n').length : 0;
    return {
      boardId,
      commit: headCommit,
      path: cleanPath,
      size,
      content,
      truncated,
      totalLines,
    };
  }
  async waitForJob(boardId: string): Promise<void> {
    await this.#jobs.get(boardId);
  }
}
