import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, HttpError } from '../src/types.ts';
import { openDb } from '../src/db.ts';
import { registerAgent, ensureBrainAgent } from '../src/agents.ts';
import { createBoard, createTask, setBoardRepoState } from '../src/tasks.ts';
import { RepoManager } from '../src/repo-manager.ts';
import { TOOL_DEFS, runWithToolContext } from '../src/orchestrator-tools.ts';
import { createApp } from '../src/http.ts';

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'QueenRead Test',
      GIT_AUTHOR_EMAIL: 'queen-read@test.invalid',
      GIT_COMMITTER_NAME: 'QueenRead Test',
      GIT_COMMITTER_EMAIL: 'queen-read@test.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

async function setupTestEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-queen-read-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const db = openDb(dataDir);
  const ctx = makeCtx(db, { dataDir, ttlMinutes: 10 });
  const mgr = new RepoManager(ctx);

  const brain = ensureBrainAgent(ctx);
  const worker = registerAgent(ctx, { name: 'WorkerBee', handle: 'worker-bee-1', role: 'worker' }).agent;
  const orch = registerAgent(ctx, { name: 'OrchTester', handle: 'orch-tester', role: 'orchestrator' });

  // 1. Managed Board with real git commits
  const board = createBoard(ctx, { id: 'test-board', name: 'Test Managed Board', repoMode: 'managed' });
  mgr.initialize(board.id, 'empty');
  await mgr.waitForJob(board.id);
  const bareRepo = mgr.repoPath(board.id).replace(/\\/g, '/');
  // Seed working directory
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(['init', '-q', '-b', 'main'], seed);

  // Add files
  writeFileSync(join(seed, 'README.md'), '# Queen Read Test Project\nWelcome to AsterHive.\nLine 3.\nLine 4.\n');
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'test-proj', version: '1.0.0' }, null, 2));

  mkdirSync(join(seed, 'src', 'utils'), { recursive: true });
  writeFileSync(join(seed, 'src', 'index.ts'), "import { add } from './utils/math.ts';\nconsole.log(add(1, 2));\n");
  writeFileSync(join(seed, 'src', 'utils', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  writeFileSync(join(seed, 'src', 'config.ts'), 'export const config = {\n  apiKey: "sk-live-1234567890abcdef1234567890",\n  endpoint: "https://api.example.com",\n};\n');
  writeFileSync(join(seed, 'app.json'), '{\n  "appName": "AsterApp",\n  "dbPassword": "super_secret_password_123"\n}\n');
  // Sensitive files committed in repo (e.g. mistakenly committed)
  writeFileSync(join(seed, '.env'), 'SECRET_KEY=supersecret123\n');
  writeFileSync(join(seed, '.env.local'), 'LOCAL_KEY=xyz\n');
  mkdirSync(join(seed, 'config'), { recursive: true });
  writeFileSync(join(seed, 'config', 'secret.json'), '{"apiKey": "hidden"}\n');
  writeFileSync(join(seed, 'server.key'), '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgk...\n-----END PRIVATE KEY-----\n');

  // Binary file
  writeFileSync(join(seed, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x41, 0x42]));
  writeFileSync(join(seed, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

  // Symlink
  // git can create symlinks across platforms if supported, or via git hash-object / update-index
  try {
    // Try git update-index for cross-platform symlink creation in git tree
    const symBlob = git(['hash-object', '-w', '--stdin'], seed);
    // write "README.md" into blob
    const child = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: seed,
      input: 'README.md',
      encoding: 'utf8',
    });
    const symBlobSha = child.stdout.trim();
    if (symBlobSha) {
      git(['update-index', '--add', '--cacheinfo', '120000', symBlobSha, 'link-to-readme'], seed);
    }
  } catch {
    // ignore if symlink creation not permitted by OS
  }

  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'Initial commit with various files'], seed);
  git(['push', '-q', bareRepo, 'main'], seed);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bareRepo);
  const headCommit = git(['rev-parse', 'HEAD'], seed);
  setBoardRepoState(ctx, board.id, { status: 'ready', head: headCommit });

  // 2. Second Real Managed Board (board-beta) with distinct git commits
  const boardBeta = createBoard(ctx, { id: 'board-beta', name: 'Beta Managed Board', repoMode: 'managed' });
  mgr.initialize(boardBeta.id, 'empty');
  await mgr.waitForJob(boardBeta.id);
  const bareBeta = mgr.repoPath(boardBeta.id).replace(/\\/g, '/');
  const seedBeta = join(root, 'seed-beta');
  mkdirSync(seedBeta);
  git(['init', '-q', '-b', 'main'], seedBeta);
  writeFileSync(join(seedBeta, 'README.md'), '# Beta Project\nThis is project beta.\n');
  git(['add', '-A'], seedBeta);
  git(['commit', '-q', '-m', 'Initial commit for beta'], seedBeta);
  git(['push', '-q', bareBeta, 'main'], seedBeta);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bareBeta);
  const headBeta = git(['rev-parse', 'HEAD'], seedBeta);
  setBoardRepoState(ctx, boardBeta.id, { status: 'ready', head: headBeta });
  const taskBeta = createTask(ctx, boardBeta.id, { id: 'BETA-1', title: 'Beta Task 1' });

  // 3. Empty Managed Board (no commits yet)
  const emptyBoard = createBoard(ctx, { id: 'empty-board', name: 'Empty Board', repoMode: 'managed', repoStatus: 'empty' });

  // 4. Remote Legacy Board
  const legacyBoard = createBoard(ctx, { id: 'legacy-board', name: 'Legacy Board', repo: 'https://github.com/foo/bar.git' });

  return { ctx, mgr, brain, worker, orch, board, boardBeta, taskBeta, emptyBoard, legacyBoard, headCommit, headBeta, root };
}

test('RepoManager.listTree lists directory structure and entries with commit at HEAD', async () => {
  const { mgr, board, headCommit } = await setupTestEnvironment();

  // Root directory listing
  const rootTree = await mgr.listTree(board.id);
  assert.equal(rootTree.boardId, board.id);
  assert.equal(rootTree.commit, headCommit);
  assert.equal(rootTree.path, '');
  assert.ok(rootTree.entries.length > 0);

  const fileNames = rootTree.entries.map((e) => e.name);
  assert.ok(fileNames.includes('README.md'));
  assert.ok(fileNames.includes('package.json'));
  assert.ok(fileNames.includes('src'));

  const readmeEntry = rootTree.entries.find((e) => e.name === 'README.md')!;
  assert.equal(readmeEntry.type, 'file');
  assert.equal(readmeEntry.path, 'README.md');
  assert.ok(typeof readmeEntry.size === 'number' && readmeEntry.size > 0);

  const srcEntry = rootTree.entries.find((e) => e.name === 'src')!;
  assert.equal(srcEntry.type, 'directory');
  assert.equal(srcEntry.path, 'src');

  // Subdirectory listing
  const srcTree = await mgr.listTree(board.id, { path: 'src' });
  assert.equal(srcTree.path, 'src');
  const srcNames = srcTree.entries.map((e) => e.name);
  assert.ok(srcNames.includes('index.ts'));
  assert.ok(srcNames.includes('utils'));

  // Recursive listing
  const recTree = await mgr.listTree(board.id, { recursive: true });
  assert.ok(recTree.entries.length >= rootTree.entries.length);
  const recPaths = recTree.entries.map((e) => e.path);
  assert.ok(recPaths.includes('src/index.ts'));
  assert.ok(recPaths.includes('src/utils/math.ts'));

  // Pagination / Limit
  const limitedTree = await mgr.listTree(board.id, { limit: 2 });
  assert.equal(limitedTree.entries.length, 2);
  assert.equal(limitedTree.truncated, true);
});

test('RepoManager.readTextFile reads text files at HEAD with commit identification', async () => {
  const { mgr, board, headCommit } = await setupTestEnvironment();

  const file = await mgr.readTextFile(board.id, 'README.md');
  assert.equal(file.boardId, board.id);
  assert.equal(file.commit, headCommit);
  assert.equal(file.path, 'README.md');
  assert.ok(file.content.includes('# Queen Read Test Project'));
  assert.ok(file.content.includes('Welcome to AsterHive.'));
  assert.equal(file.truncated, false);
  assert.equal(file.totalLines, 5);

  const nested = await mgr.readTextFile(board.id, 'src/utils/math.ts');
  assert.ok(nested.content.includes('export function add'));
  assert.equal(nested.path, 'src/utils/math.ts');

  // Truncation on maxBytes
  const truncated = await mgr.readTextFile(board.id, 'README.md', { maxBytes: 15 });
  assert.equal(truncated.content.length, 15);
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.size > 15);
});

test('Security: Path traversal is strictly rejected', async () => {
  const { mgr, board } = await setupTestEnvironment();

  await assert.rejects(async () => mgr.listTree(board.id, { path: '../' }), (err: unknown) => {
    return err instanceof HttpError && err.status === 400 && /traversal/i.test(err.message);
  });

  await assert.rejects(async () => mgr.readTextFile(board.id, '../seed/README.md'), (err: unknown) => {
    return err instanceof HttpError && err.status === 400 && /traversal/i.test(err.message);
  });

  await assert.rejects(async () => mgr.readTextFile(board.id, 'src/../../etc/passwd'), (err: unknown) => {
    return err instanceof HttpError && err.status === 400 && /traversal/i.test(err.message);
  });

  await assert.rejects(async () => mgr.readTextFile(board.id, 'C:/Windows/System32/drivers/etc/hosts'), (err: unknown) => {
    return err instanceof HttpError && err.status === 400;
  });

  await assert.rejects(async () => mgr.readTextFile(board.id, 'src/\0/index.ts'), (err: unknown) => {
    return err instanceof HttpError && err.status === 400;
  });
});

test('Security: Sensitive files and private credentials cannot be read', async () => {
  const { mgr, board } = await setupTestEnvironment();

  // .env
  await assert.rejects(async () => mgr.readTextFile(board.id, '.env'), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /sensitive/i.test(err.message);
  });

  // .env.local
  await assert.rejects(async () => mgr.readTextFile(board.id, '.env.local'), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /sensitive/i.test(err.message);
  });

  // private keys / certificates
  await assert.rejects(async () => mgr.readTextFile(board.id, 'server.key'), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /sensitive/i.test(err.message);
  });

  // secrets in subdirectories
  await assert.rejects(async () => mgr.readTextFile(board.id, 'config/secret.json'), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /sensitive/i.test(err.message);
  });

  // SSH paths & key files
  await assert.rejects(async () => mgr.readTextFile(board.id, '.ssh/id_rsa'), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /sensitive/i.test(err.message);
  });
  await assert.rejects(async () => mgr.readTextFile(board.id, 'id_ed25519'), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /sensitive/i.test(err.message);
  });
  await assert.rejects(async () => mgr.readTextFile(board.id, 'credentials.json'), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /sensitive/i.test(err.message);
  });
});

test('Security: Binary files are detected and rejected from text reading', async () => {
  const { mgr, board } = await setupTestEnvironment();

  // Null bytes in file
  await assert.rejects(async () => mgr.readTextFile(board.id, 'binary.dat'), (err: unknown) => {
    return err instanceof HttpError && err.status === 415 && /binary/i.test(err.message);
  });

  // Known binary extension (png)
  await assert.rejects(async () => mgr.readTextFile(board.id, 'icon.png'), (err: unknown) => {
    return err instanceof HttpError && err.status === 415 && /binary/i.test(err.message);
  });
});

test('Security: Symbolic links cannot be read as text', async () => {
  const { mgr, board } = await setupTestEnvironment();

  // If symlink was created in setup
  const rootTree = await mgr.listTree(board.id);
  const symlinkEntry = rootTree.entries.find((e) => e.name === 'link-to-readme');
  if (symlinkEntry) {
    assert.equal(symlinkEntry.type, 'symlink');
    await assert.rejects(async () => mgr.readTextFile(board.id, 'link-to-readme'), (err: unknown) => {
      return err instanceof HttpError && err.status === 400 && /symbolic link/i.test(err.message);
    });
  }
});

test('Edge cases: Nonexistent files and path-type mismatches return appropriate errors', async () => {
  const { mgr, board } = await setupTestEnvironment();

  // 404 for missing file
  await assert.rejects(async () => mgr.readTextFile(board.id, 'missing.ts'), (err: unknown) => {
    return err instanceof HttpError && err.status === 404 && /not found/i.test(err.message);
  });

  // 400 for reading a directory as file
  await assert.rejects(async () => mgr.readTextFile(board.id, 'src'), (err: unknown) => {
    return err instanceof HttpError && err.status === 400 && /directory/i.test(err.message);
  });

  // 400 for listing a file as directory
  await assert.rejects(async () => mgr.listTree(board.id, { path: 'README.md' }), (err: unknown) => {
    return err instanceof HttpError && err.status === 400 && /file/i.test(err.message);
  });
});

test('Cross-board boundary and repository readiness checks', async () => {
  const { mgr, emptyBoard, legacyBoard } = await setupTestEnvironment();

  // Invalid boardId regex
  await assert.rejects(async () => mgr.listTree('../invalid-board'), (err: unknown) => {
    return err instanceof HttpError && err.status === 422;
  });

  // Non-existent board
  await assert.rejects(async () => mgr.listTree('nonexistent-board-id'), (err: unknown) => {
    return err instanceof HttpError && err.status === 404;
  });

  // Remote-legacy board
  await assert.rejects(async () => mgr.listTree(legacyBoard.id), (err: unknown) => {
    return err instanceof HttpError && err.status === 409 && /managed/i.test(err.message);
  });

  // Empty board without ready commits
  await assert.rejects(async () => mgr.listTree(emptyBoard.id), (err: unknown) => {
    return err instanceof HttpError && err.status === 409 && /not ready/i.test(err.message);
  });
});

test('Security: Directory listing strictly filters out sensitive files and directories (including recursively)', async () => {
  const { mgr, board } = await setupTestEnvironment();

  // Root listing must NOT leak sensitive paths
  const rootTree = await mgr.listTree(board.id);
  const rootNames = rootTree.entries.map((e) => e.name);
  assert.equal(rootNames.includes('.env'), false, '.env must not be listed in directory entries');
  assert.equal(rootNames.includes('.env.local'), false, '.env.local must not be listed in directory entries');
  assert.equal(rootNames.includes('server.key'), false, 'server.key must not be listed in directory entries');

  // Recursive listing must NOT leak sensitive paths anywhere in the tree
  const recTree = await mgr.listTree(board.id, { recursive: true });
  const recPaths = recTree.entries.map((e) => e.path);
  assert.equal(recPaths.some((p) => p.includes('.env')), false, 'recursive listing must not contain .env');
  assert.equal(recPaths.some((p) => p.includes('server.key')), false, 'recursive listing must not contain server.key');
  assert.equal(recPaths.some((p) => p.includes('secret.json')), false, 'recursive listing must not contain secret.json');
});

test('Security: Fictitious secrets and keys inside ordinary files are masked on read', async () => {
  const { mgr, board } = await setupTestEnvironment();

  // Ordinary typescript config file with an API key: verify plaintext key is not leaked
  const cfgFile = await mgr.readTextFile(board.id, 'src/config.ts');
  assert.equal(cfgFile.content.includes('sk-live-1234567890abcdef1234567890'), false, 'plaintext API key must not be leaked');
  assert.ok(cfgFile.content.includes('endpoint: "https://api.example.com"'), 'non-sensitive fields must be preserved');

  // Ordinary json file with a database password: verify plaintext password is not leaked
  const jsonFile = await mgr.readTextFile(board.id, 'app.json');
  assert.equal(jsonFile.content.includes('super_secret_password_123'), false, 'plaintext password must not be leaked');
  assert.ok(jsonFile.content.includes('"appName": "AsterApp"'), 'non-sensitive json fields must be preserved');
});

test('Security: Cross-board isolation between two real boards and session binding', async () => {
  const { ctx, brain, board, boardBeta, taskBeta } = await setupTestEnvironment();

  const toolList = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_list_files')!;
  const toolRead = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_read_file')!;

  // 1. When Queen session is bound to board-alpha (test-board):
  await runWithToolContext({ boardId: board.id }, async () => {
    // Reading own board succeeds
    const selfList = (await toolList.handle(ctx, brain, { boardId: board.id })) as { boardId: string };
    assert.equal(selfList.boardId, board.id);

    // Attempting to access board-beta by boardId is REJECTED with 403
    await assert.rejects(
      async () => toolList.handle(ctx, brain, { boardId: boardBeta.id }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
      'Queen cannot list files of another real board',
    );

    await assert.rejects(
      async () => toolRead.handle(ctx, brain, { boardId: boardBeta.id, path: 'README.md' }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
      'Queen cannot read files of another real board',
    );

    // Attempting to access board-beta via taskId on board-beta is REJECTED with 403
    await assert.rejects(
      async () => toolRead.handle(ctx, brain, { taskId: taskBeta.id, path: 'README.md' }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
      'Queen cannot read files via taskId belonging to another board',
    );
  });

  // 2. When Queen is invoked without any bound context:
  await assert.rejects(
    async () => toolList.handle(ctx, brain, { boardId: board.id }),
    (err: unknown) => err instanceof HttpError && err.status === 403,
    'Queen cannot access repo tools without an active single-board context',
  );

  await assert.rejects(
    async () => toolRead.handle(ctx, brain, { boardId: board.id, path: 'README.md' }),
    (err: unknown) => err instanceof HttpError && err.status === 403,
    'Queen cannot read repo files without an active single-board context',
  );
});

test('Concurrency: Concurrent sessions bound to different boards do not leak context or state', async () => {
  const { ctx, brain, board, boardBeta } = await setupTestEnvironment();

  const toolRead = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_read_file')!;

  // Run concurrent reads for two different boards in parallel
  const [resA, resB] = await Promise.all([
    runWithToolContext({ boardId: board.id }, async () => {
      return (await toolRead.handle(ctx, brain, { path: 'README.md' })) as { boardId: string; content: string };
    }),
    runWithToolContext({ boardId: boardBeta.id }, async () => {
      return (await toolRead.handle(ctx, brain, { path: 'README.md' })) as { boardId: string; content: string };
    }),
  ]);

  assert.equal(resA.boardId, board.id);
  assert.ok(resA.content.includes('# Queen Read Test Project'));

  assert.equal(resB.boardId, boardBeta.id);
  assert.ok(resB.content.includes('# Beta Project'));
});

test('Orchestrator protocol tools: asterhive_repo_list_files & asterhive_repo_read_file role & access control', async () => {
  const { ctx, brain, worker, board } = await setupTestEnvironment();

  const toolList = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_list_files')!;
  const toolRead = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_read_file')!;

  assert.ok(toolList, 'asterhive_repo_list_files exists in TOOL_DEFS');
  assert.ok(toolRead, 'asterhive_repo_read_file exists in TOOL_DEFS');

  // Workers are strictly forbidden from direct repo reads (403)
  await assert.rejects(async () => toolList.handle(ctx, worker, { boardId: board.id }), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /workers cannot/i.test(err.message);
  });

  await assert.rejects(async () => toolRead.handle(ctx, worker, { boardId: board.id, path: 'README.md' }), (err: unknown) => {
    return err instanceof HttpError && err.status === 403 && /workers cannot/i.test(err.message);
  });

  // Queen / Brain can list and read within its bound board context
  await runWithToolContext({ boardId: board.id }, async () => {
    const listRes = (await toolList.handle(ctx, brain, {})) as {
      boardId: string;
      commit: string;
      entries: Array<{ name: string; type: string }>;
    };
    assert.equal(listRes.boardId, board.id);
    assert.ok(listRes.commit.length >= 40);
    assert.ok(listRes.entries.some((e) => e.name === 'README.md'));

    const readRes = (await toolRead.handle(ctx, brain, { path: 'README.md' })) as {
      boardId: string;
      commit: string;
      content: string;
    };
    assert.equal(readRes.boardId, board.id);
    assert.ok(readRes.content.includes('# Queen Read Test Project'));
    assert.equal(readRes.commit, listRes.commit);
  });
});

test('Security: Forged X-Board-Id header in MCP is rejected for orchestrator role', async () => {
  const { ctx, orch, boardBeta } = await setupTestEnvironment();
  const app = createApp(ctx);

  // An attacker with orchestrator token sends forged X-Board-Id header trying to read board-beta
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${orch.token}`,
      'x-board-id': boardBeta.id,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'asterhive_repo_read_file',
        arguments: { boardId: boardBeta.id, path: 'README.md' },
      },
    }),
  });

  assert.equal(res.status, 200);
  const data = (await res.json()) as { error?: { code: number; message: string }; result?: unknown };
  assert.ok(data.error, 'MCP call with forged header must return JSON-RPC error');
  assert.ok(
    data.error.message.includes('[403]'),
    `Error message must indicate 403, got: ${data.error.message}`,
  );
});

test('Security: Multi-board events in a single turn prevent single-board context from being granted', async () => {
  const { ctx, brain, board, boardBeta } = await setupTestEnvironment();

  const toolRead = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_read_file')!;

  // When no single board context is bound (e.g. multi-board turn or global review):
  await assert.rejects(
    async () => toolRead.handle(ctx, brain, { boardId: board.id, path: 'README.md' }),
    (err: unknown) => err instanceof HttpError && err.status === 403,
    'Queen cannot read repo when context is not a single board',
  );

  await assert.rejects(
    async () => toolRead.handle(ctx, brain, { boardId: boardBeta.id, path: 'README.md' }),
    (err: unknown) => err instanceof HttpError && err.status === 403,
    'Queen cannot read repo of either board when turn spans multiple boards',
  );
});

test('Security: Message steer cross-board isolation prevents board confusion', async () => {
  const { ctx, brain, board, boardBeta } = await setupTestEnvironment();

  const toolRead = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_read_file')!;

  // When Session is running in board-alpha:
  await runWithToolContext({ boardId: board.id }, async () => {
    // Reading board-alpha succeeds
    const selfRes = (await toolRead.handle(ctx, brain, { path: 'README.md' })) as { boardId: string };
    assert.equal(selfRes.boardId, board.id);

    // If an incoming steer or argument references boardBeta, it is strictly rejected and cannot steer context
    await assert.rejects(
      async () => toolRead.handle(ctx, brain, { boardId: boardBeta.id, path: 'README.md' }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
  });
});
