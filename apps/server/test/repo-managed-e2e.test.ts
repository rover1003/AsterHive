import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http.ts';
import { makeCtx } from '../src/types.ts';
import { openDb } from '../src/db.ts';
import { registerAgent, setAgentEnabled } from '../src/agents.ts';
import { createBoard, createTask, setBoardRepoState } from '../src/tasks.ts';
import { RepoManager } from '../src/repo-manager.ts';
import { claimTask } from '../src/verbs.ts';
import { TOOL_DEFS } from '../src/orchestrator-tools.ts';

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E Test',
      GIT_AUTHOR_EMAIL: 'e2e@test.invalid',
      GIT_COMMITTER_NAME: 'E2E Test',
      GIT_COMMITTER_EMAIL: 'e2e@test.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

test('Managed repository end-to-end: snapshot -> worker commit -> upload -> brain inspect -> integrate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asterhive-managed-e2e-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const db = openDb(dataDir);
  const ctx = makeCtx(db, { dataDir, ttlMinutes: 10, keepSnapshots: 2 });
  const app = createApp(ctx);
  const mgr = new RepoManager(ctx);

  try {
    // 1. 注册主脑、worker
    const brain = registerAgent(ctx, { name: 'Master', handle: 'asterhive-brain', role: 'orchestrator' });
    const worker = registerAgent(ctx, { name: 'Worker', handle: 'worker-node', role: 'worker' });

    // 2. 建 managed 板与初始 bare 仓库
    const board = createBoard(ctx, { id: 'proj-managed', name: 'Managed Project', repoMode: 'managed' });
    mgr.initialize(board.id, 'empty');
    await mgr.waitForJob(board.id);

    // 3. 在服务器主仓里打一个初始提交
    const bareRepo = mgr.repoPath(board.id);
    const seed = join(root, 'seed');
    mkdirSync(seed);
    git(['init', '-q', '-b', 'main'], seed);
    writeFileSync(join(seed, 'README.md'), '# Managed Project Initial\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'Initial commit'], seed);
    git(['push', '-q', bareRepo, 'main'], seed);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bareRepo);
    const initialHead = git(['rev-parse', 'HEAD'], seed);
    setBoardRepoState(ctx, board.id, { status: 'ready', head: initialHead });

    // 4. 立项一个任务
    const task = createTask(ctx, board.id, {
      id: 'TASK-1',
      title: 'Add feature file',
      detail: 'Create feature.txt',
      lane: 'Ready',
      assignee: worker.agent.id,
    });
    claimTask(ctx, worker.agent, task.id);

    // 5. Worker 请求 snapshot bundle 端点
    const snapRes = await app.request(`/tasks/${task.id}/repo-snapshot`, {
      headers: { authorization: `Bearer ${worker.token}` },
    });
    assert.equal(snapRes.status, 200);
    const snapBuf = Buffer.from(await snapRes.arrayBuffer());
    assert.ok(snapBuf.length > 0);

    // 6. Worker 在本地临时工作区解包、修改并打包结果 bundle
    const workerBase = join(root, 'worker-worktree');
    mkdirSync(workerBase);
    const snapFile = join(workerBase, 'snapshot.bundle');
    writeFileSync(snapFile, snapBuf);
    const workerDir = join(workerBase, 'src');
    git(['clone', snapFile, workerDir], workerBase);
    git(['checkout', '-b', 'asterhive/TASK-1'], workerDir);
    writeFileSync(join(workerDir, 'feature.txt'), 'hello from managed worker\n');
    git(['add', '-A'], workerDir);
    git(['commit', '-m', 'asterhive(TASK-1): add feature file'], workerDir);
    const workerCommit = git(['rev-parse', 'HEAD'], workerDir);

    const resBundle = join(workerBase, 'result.bundle');
    git(['bundle', 'create', resBundle, 'asterhive/TASK-1'], workerDir);
    const resBuf = readFileSync(resBundle);
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(resBuf).digest('hex');

    // 7. Worker 回传任务结果 bundle
    const uploadRes = await app.request(`/tasks/${task.id}/repo-result`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${worker.token}`,
        'content-type': 'application/vnd.git.bundle',
        'content-length': String(resBuf.length),
        'x-content-sha256': sha256,
      },
      body: resBuf,
    });
    if (uploadRes.status !== 200) {
      const errText = await uploadRes.text();
      assert.fail(`upload failed HTTP ${uploadRes.status}: ${errText}`);
    }
    assert.equal(uploadRes.status, 200);
    const uploadJson = (await uploadRes.json()) as { status: string; taskRef: string; headCommit: string };
    assert.equal(uploadJson.status, 'saved');
    assert.equal(uploadJson.headCommit, workerCommit);

    // 8. 主脑通过受限工具检查差异与证据
    const inspectTool = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_inspect_task')!;
    const inspection = (await inspectTool.handle(ctx, brain, { taskId: task.id })) as {
      base: string;
      head: string;
      changedFiles: string[];
    };
    assert.equal(inspection.head, workerCommit);
    assert.ok(inspection.changedFiles.includes('feature.txt'));

    // 9. 主脑验收并调用 integrate 工具合并到主干
    const integrateTool = TOOL_DEFS.find((t) => t.name === 'asterhive_repo_integrate_task')!;
    const integration = (await integrateTool.handle(ctx, brain, { taskId: task.id })) as {
      mergedCommit: string;
    };
    assert.ok(integration.mergedCommit);

    // 10. 验证服务器 bare repo 的 main 分支已推进，包含 worker 的改动
    const finalHead = git(['rev-parse', 'refs/heads/main'], bareRepo);
    assert.equal(finalHead, integration.mergedCommit);
    const show = git(['log', '-1', '--oneline', finalHead], bareRepo);
    assert.ok(show.includes('Integrate task TASK-1 into main'));
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
});
