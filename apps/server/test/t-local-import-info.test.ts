import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { getBoard, createBoard, listBoards } from '../src/tasks.ts';

test('managed local import preserves requested remote without claiming it was imported', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const response = await app.request('/boards', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'local-project', name: 'Local project', repoMode: 'managed', repoInit: 'empty', repo: 'https://github.com/example/source.git' }),
    });
    assert.equal(response.status, 201);
    const { board } = await response.json();
    assert.equal(board.repo, 'https://github.com/example/source.git');
    assert.equal(board.repoSource, '');
    assert.equal(board.repoHead, '');
    assert.equal(getBoard(rig.ctx, board.id).repo, board.repo);
    assert.equal(listBoards(rig.ctx).find(b => b.id === board.id)?.repo, board.repo);
  } finally { rig.cleanup(); }
});

test('board repository credentials are refused without being persisted or echoed', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    for (const repo of ['https://alice:private-password@example.com/project.git', 'https://example.com/project.git?token=private-token']) {
      const response = await app.request('/boards', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'private-project', name: 'Private project', repoMode: 'managed', repoInit: 'empty', repo }),
      });
      assert.equal(response.status, 422);
      assert.doesNotMatch(await response.text(), /private-password|private-token/);
    }
    assert.equal(listBoards(rig.ctx).length, 0);
  } finally { rig.cleanup(); }
});

test('historical repository URLs do not disclose embedded credentials through board reads', () => {
  const rig = mkRig();
  try {
    createBoard(rig.ctx, { id: 'historical', name: 'Historical' });
    rig.ctx.holder.db.prepare('UPDATE board SET repo = ?, repo_source = ? WHERE id = ?').run(
      'https://alice:private-password@example.com/project.git?token=private-token',
      'https://alice:private-password@example.com/project.git?token=private-token', 'historical');
    for (const board of [getBoard(rig.ctx, 'historical'), ...listBoards(rig.ctx)]) {
      assert.equal(board.repo, 'https://example.com/project.git');
      assert.equal(board.repoSource, 'https://example.com/project.git');
    }
  } finally { rig.cleanup(); }
});
