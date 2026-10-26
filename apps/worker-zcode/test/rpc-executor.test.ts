import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OmpRpcSession, contextAction, DEFAULT_THRESHOLDS } from '../src/rpc-executor.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fake-omp-rpc.mjs');

function makeSession(mode = 'success') {
  const sessionDir = mkdtempSync(join(tmpdir(), 'asterhive-rpc-test-'));
  const session = new OmpRpcSession({
    ompBin: process.execPath,
    args: [fake],
    env: { FAKE_RPC_MODE: mode },
    cwd: here,
    sessionDir,
    timeoutMs: 1_000,
    log: () => {},
  });
  return { session, cleanup: () => { session.kill(); rmSync(sessionDir, { recursive: true, force: true }); } };
}

test('RPC context boundaries: unknown/idle/shake/compact/stop', () => {
  assert.equal(contextAction(undefined, DEFAULT_THRESHOLDS), 'none');
  assert.equal(contextAction(59, DEFAULT_THRESHOLDS), 'none');
  assert.equal(contextAction(60, DEFAULT_THRESHOLDS), 'shake');
  assert.equal(contextAction(80, DEFAULT_THRESHOLDS), 'compact');
  assert.equal(contextAction(90, DEFAULT_THRESHOLDS), 'stop');
});

test('RPC actual envelope: ready → response.data → prompt_result → get_state settled → last text', async () => {
  const { session, cleanup } = makeSession();
  try {
    await session.start();
    const state = await session.getState();
    assert.equal(state.sessionId, 'fake-session');
    assert.equal(state.contextPercent, 12);
    assert.equal(state.settled, true);
    const result = await session.runPrompt('one isolated task');
    assert.equal(result.status, 'completed');
    assert.match(result.text, /fake completed result/);
  } finally { cleanup(); }
});

test('RPC prompt error is not success', async () => {
  const { session, cleanup } = makeSession('prompt-error');
  try {
    await session.start();
    const result = await session.runPrompt('fail safely');
    assert.equal(result.status, 'error');
    assert.notEqual(result.status, 'completed');
  } finally { cleanup(); }
});

test('RPC missing last-assistant text refuses false completion', async () => {
  const { session, cleanup } = makeSession('no-last-text');
  try {
    await session.start();
    await assert.rejects(session.runPrompt('no result text'), /无文本/);
  } finally { cleanup(); }
});

test('RPC compact uses response envelope and reports success', async () => {
  const { session, cleanup } = makeSession();
  try {
    await session.start();
    assert.equal(await session.compact('keep task scope and evidence'), true);
  } finally { cleanup(); }
});
