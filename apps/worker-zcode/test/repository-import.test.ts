import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../../packages/sdk/src/cli.ts', import.meta.url));

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Import Test',
      GIT_AUTHOR_EMAIL: 'import@test.invalid',
      GIT_COMMITTER_NAME: 'Import Test',
      GIT_COMMITTER_EMAIL: 'import@test.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function runCli(args: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.once('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr }); });
  });
}

async function startImportServer(target: string, bareRepoDir: string): Promise<{ url: string; close: () => Promise<void>; uploaded: () => { bytes: number; hash: string; head: string; refs: string[] } | undefined }> {
  let result: { bytes: number; hash: string; head: string; refs: string[] } | undefined;
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/boards/import-board/repo/import') {
      res.writeHead(404); res.end(); return;
    }
    if (req.headers.authorization !== 'Bearer import-token') { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const bundle = Buffer.concat(chunks);
      const hash = createHash('sha256').update(bundle).digest('hex');
      try {
        writeFileSync(target, bundle);
        const verify = git(['bundle', 'verify', target], bareRepoDir);
        const heads = git(['bundle', 'list-heads', target], bareRepoDir).split(/\r?\n/).filter(Boolean);
        const branchLine = heads.find((line) => line.endsWith('refs/heads/main')) ?? heads.find((line) => line.includes('refs/heads/'));
        const head = branchLine?.split(/\s+/)[0] ?? '';
        result = { bytes: bundle.length, hash, head, refs: heads };
        assert.ok(verify.includes('The bundle'), 'bundle verify must accept uploaded archive');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'imported', head, refs: heads.map((x) => x.split(/\s+/)[1]) }));
      } catch (err) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), uploaded: () => result };
}

test('CLI repo import uploads a clean source Git bundle with history and SHA-256', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-import-cli-'));
  const home = join(root, 'home');
  const source = join(root, 'source');
  const bareRepo = join(root, 'server.git');
  const received = join(root, 'received.bundle');
  mkdirSync(home); mkdirSync(source);
  git(['init', '--bare', bareRepo], root);
  try {
    git(['init', '-q', '-b', 'main'], source);
    writeFileSync(join(source, 'README.md'), '# imported project\n');
    git(['add', '-A'], source); git(['commit', '-q', '-m', 'initial'], source);
    const sourceHead = git(['rev-parse', 'HEAD'], source);
    const server = await startImportServer(received, bareRepo);
    const identityDir = join(home, '.asterhive');
    mkdirSync(identityDir);
    writeFileSync(join(identityDir, 'worker.json'), JSON.stringify({ url: server.url, token: 'import-token', handle: 'omp-test' }));
    try {
      const run = await runCli(['repo', 'import', '--board', 'import-board', '--path', source], home);
      assert.equal(run.code, 0, run.stdout + run.stderr);
      assert.equal(run.stdout.includes('"status":"imported"'), true);
      const upload = server.uploaded();
      assert.ok(upload);
      assert.ok(upload.bytes > 0);
      assert.equal(upload.hash, createHash('sha256').update(readFileSync(received)).digest('hex'));
      assert.equal(upload.head, sourceHead);
      assert.ok(upload.refs.some((r) => r.endsWith('refs/heads/main')));
      assert.equal(git(['status', '--porcelain'], source), '', '源工作树保持干净且未被修改');
    } finally { await server.close(); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});

test('CLI repo import refuses a dirty source worktree before upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-import-dirty-'));
  const home = join(root, 'home'), source = join(root, 'source');
  mkdirSync(home); mkdirSync(source);
  try {
    git(['init', '-q', '-b', 'main'], source);
    writeFileSync(join(source, 'README.md'), 'clean\n'); git(['add', '-A'], source); git(['commit', '-q', '-m', 'initial'], source);
    writeFileSync(join(source, 'README.md'), 'dirty\n');
    const identityDir = join(home, '.asterhive'); mkdirSync(identityDir);
    writeFileSync(join(identityDir, 'worker.json'), JSON.stringify({ url: 'http://127.0.0.1:8067', token: 'import-token', handle: 'omp-test' }));
    const run = await runCli(['repo', 'import', '--board', 'import-board', '--path', source], home);
    assert.equal(run.code, 1);
    assert.match(run.stdout, /工作树不干净/);
    assert.equal(readFileSync(join(source, 'README.md'), 'utf8'), 'dirty\n', '拒绝导入不修改源项目');
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }); }
});
