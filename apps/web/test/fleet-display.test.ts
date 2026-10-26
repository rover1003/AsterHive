import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fleet = readFileSync(new URL('../src/views/fleet.ts', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('Agent 总览 UI 仅列 worker，状态文案区分在线空闲与心跳过期', () => {
  assert.match(fleet, /ov\.agents\.filter\(\(a\) => a\.role !== 'orchestrator'\)/);
  assert.match(fleet, /idle:\s*'在线·空闲'/);
  assert.match(fleet, /stale:\s*'心跳过期\/疑似离线'/);
  assert.match(fleet, /fleet-status-label/);
  assert.match(nav, /agentsCache\s*\n\s*\.filter\(\(a\) => a\.role !== 'orchestrator'\)/);
});

test('idle 圆点使用绿色 token；stale 黄点明确表示心跳过期', () => {
  assert.match(css, /\.status-dot\.idle\s*\{\s*background:\s*var\(--ok\)/);
  assert.match(css, /\.status-dot\.stale\s*\{\s*background:\s*var\(--warn\)/);
});
