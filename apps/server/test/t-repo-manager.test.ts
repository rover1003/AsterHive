import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkRig } from './helpers.ts';
import { createBoard, getBoard } from '../src/tasks.ts';
import { RepoManager } from '../src/repo-manager.ts';

function git(args: string[], cwd?: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

test('RepoManager initializes a server-owned managed bare repository', async () => {
  const rig = mkRig();
  try {
    const board = createBoard(rig.ctx, { id: 'managed-b', name: 'Managed B', repoMode: 'managed', repoStatus: 'empty' });
    const manager = new RepoManager(rig.ctx);
    assert.deepEqual(manager.initialize(board.id, 'empty'), { status: 'queued' });
    await manager.waitForJob(board.id);
    const updated = getBoard(rig.ctx, board.id);
    assert.equal(updated.repoMode, 'managed');
    assert.equal(updated.repoStatus, 'ready');
    assert.equal(updated.repoError, '');
    assert.equal(existsSync(manager.repoPath(board.id)), true);
    assert.equal(git(['rev-parse', '--is-bare-repository'], manager.repoPath(board.id)), 'true');
    assert.equal(git(['symbolic-ref', 'HEAD'], manager.repoPath(board.id)), 'refs/heads/main');
  } finally { rig.cleanup(); }
});

test('RepoManager rejects unsafe remotes and does not initialize remote-legacy boards', async () => {
  const rig = mkRig();
  try {
    const managed = createBoard(rig.ctx, { id: 'managed-r', name: 'Managed R', repoMode: 'managed', repoStatus: 'empty' });
    const legacy = createBoard(rig.ctx, { id: 'legacy-r', name: 'Legacy R', repo: 'https://example.invalid/repo.git' });
    const manager = new RepoManager(rig.ctx);
    assert.throws(() => manager.initialize(managed.id, 'clone', 'file:///etc/passwd'), /HTTPS or SSH/);
    assert.throws(() => manager.initialize(legacy.id, 'empty'), /not in managed/);
    assert.equal(existsSync(manager.repoPath(managed.id)), false);
  } finally { rig.cleanup(); }
});
