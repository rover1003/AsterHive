import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, clearAgentTelemetry } from '../src/agents.ts';
import { createBoard } from '../src/tasks.ts';

interface SseFrame {
  event: string;
  id: string;
  data: string;
}

/** 从累计文本中解析出完整 SSE 帧（丢弃不完整尾部）。 */
function parseSseFrames(text: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = text;
  for (;;) {
    const idx = rest.indexOf('\n\n');
    if (idx === -1) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const frame: SseFrame = { event: '', id: '', data: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) frame.event = line.slice(7);
      else if (line.startsWith('id: ')) frame.id = line.slice(4);
      else if (line.startsWith('data: ')) frame.data += line.slice(6);
    }
    frames.push(frame);
  }
  return { frames, rest };
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  dec: TextDecoder,
  timeoutMs: number,
): Promise<{ done: boolean; text: string }> {
  const result = await Promise.race([
    reader.read().then(
      (r) => ({ done: r.done, text: r.done ? '' : dec.decode(r.value, { stream: true }) }),
      (e) => ({ done: true, text: `__error__:${e?.message ?? String(e)}` }),
    ),
    new Promise<{ done: boolean; text: string }>((resolve) =>
      setTimeout(() => resolve({ done: false, text: '' }), timeoutMs),
    ),
  ]);
  return result;
}

/**
 * 持续读取直到收集到目标类型事件或超过总时长。返回收集到的帧。
 * 用于验证“合并后只推最新帧”等行为，避免依赖单次 chunk 边界。
 */
async function collectEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  dec: TextDecoder,
  targetTypes: string[],
  totalMs: number,
  quietMs = 150,
): Promise<SseFrame[]> {
  const collected: SseFrame[] = [];
  let buf = '';
  const deadline = Date.now() + totalMs;
  let lastDataAt = Date.now();
  while (Date.now() < deadline) {
    const { done, text } = await readChunk(reader, dec, Math.min(200, deadline - Date.now()));
    if (text) {
      lastDataAt = Date.now();
      buf += text;
      const { frames, rest } = parseSseFrames(buf);
      buf = rest;
      collected.push(...frames);
    }
    if (done) break;
    // 目标类型已收集到且出现安静期（无新数据），视为本轮推送结束
    if (collected.some((f) => targetTypes.includes(f.event)) && Date.now() - lastDataAt >= quietMs) {
      break;
    }
  }
  return collected;
}

test('SSE 慢消费者队列有界：队列满必须终止真实流（真实断开），而非无界堆积', async () => {
  const rig = mkRig();
  clearAgentTelemetry(rig.ctx);
  try {
    const app = createApp(rig.ctx);

    const res = await app.request('/events');
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // 消费 hello 帧，确认连接建立
    const hello = await readChunk(reader, dec, 1000);
    assert.equal(hello.done, false, '应收到 hello 帧');
    assert.ok(hello.text.includes('hello'), '首帧应为 hello');

    // 慢消费者：不消费，通过真实总线发布远超队列上限的非遥测事件。
    // （agent.telemetry 同节点会合并为最新帧，不会触发溢出；用不可合并事件验证队列上界）
    for (let i = 0; i < 1500; i++) {
      rig.ctx.bus.publish('task.updated', { taskId: `T${i}`, boardId: 'b-overflow' });
    }

    // 队列满后流必须终止（读到 DONE），而不是无限保持打开、内存无界增长
    let terminated = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { done } = await readChunk(reader, dec, 300);
      if (done) {
        terminated = true;
        break;
      }
    }
    assert.equal(terminated, true, '慢消费者队列满后 SSE 流必须真实终止（读到流结束），不得无界堆积');
  } finally {
    clearAgentTelemetry(rig.ctx);
    rig.cleanup();
  }
});

test('SSE 遥测合并：同节点最新帧合并推送，非遥测事件保持逐条', async () => {
  const rig = mkRig();
  clearAgentTelemetry(rig.ctx);
  try {
    const app = createApp(rig.ctx);
    createBoard(rig.ctx, { id: 'b-coalesce', name: '合并看板' });
    const { agent: bee } = registerAgent(rig.ctx, { name: '合并节点', handle: 'bee-coalesce' });

    const res = await app.request('/events');
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const hello = await readChunk(reader, dec, 1000);
    assert.equal(hello.done, false, '应收到 hello 帧');

    // 快速连续发布 3 帧同节点遥测（不消费），应合并为最新一帧（cpuPercent 30）
    rig.ctx.bus.publish('agent.telemetry', { agentId: bee.id, telemetry: { cpuPercent: 10, timestamp: Date.now() } });
    rig.ctx.bus.publish('agent.telemetry', { agentId: bee.id, telemetry: { cpuPercent: 20, timestamp: Date.now() } });
    rig.ctx.bus.publish('agent.telemetry', { agentId: bee.id, telemetry: { cpuPercent: 30, timestamp: Date.now() } });
    // 非遥测事件必须逐条保留
    rig.ctx.bus.publish('task.created', { taskId: 'T1', boardId: 'b-coalesce' });

    const frames = await collectEvents(reader, dec, ['agent.telemetry', 'task.created'], 2000);

    const telem = frames.filter((f) => f.event === 'agent.telemetry');
    const tasks = frames.filter((f) => f.event === 'task.created');

    // 同节点遥测只推最新一帧（cpuPercent 30），不得逐帧全推
    assert.equal(telem.length, 1, `同节点遥测应合并为最新一帧，实际 ${telem.length} 帧`);
    const payload = JSON.parse(telem[0].data) as { agentId: string; telemetry: { cpuPercent: number } };
    assert.equal(payload.agentId, bee.id);
    assert.equal(payload.telemetry.cpuPercent, 30, '应推送最新一帧而非中间帧');

    // 非遥测事件不受合并影响，逐条保留
    assert.equal(tasks.length, 1, '非遥测事件应逐条保留');
  } finally {
    clearAgentTelemetry(rig.ctx);
    rig.cleanup();
  }
});

test('SSE 兼容性：不同节点遥测各自独立推送，不互相合并', async () => {
  const rig = mkRig();
  clearAgentTelemetry(rig.ctx);
  try {
    const app = createApp(rig.ctx);
    const { agent: a } = registerAgent(rig.ctx, { name: '节点A', handle: 'bee-a' });
    const { agent: b } = registerAgent(rig.ctx, { name: '节点B', handle: 'bee-b' });

    const res = await app.request('/events');
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await readChunk(reader, dec, 1000); // hello

    // 两个不同节点各推一帧，必须都送达（合并仅针对同节点）
    rig.ctx.bus.publish('agent.telemetry', { agentId: a.id, telemetry: { cpuPercent: 11, timestamp: Date.now() } });
    rig.ctx.bus.publish('agent.telemetry', { agentId: b.id, telemetry: { cpuPercent: 22, timestamp: Date.now() } });

    const frames = await collectEvents(reader, dec, ['agent.telemetry'], 2000);
    const telem = frames.filter((f) => f.event === 'agent.telemetry');
    assert.equal(telem.length, 2, `两个不同节点各一帧应都送达，实际 ${telem.length}`);
    const agentIds = telem.map((f) => (JSON.parse(f.data) as { agentId: string }).agentId).sort();
    assert.deepEqual(agentIds, [a.id, b.id].sort());
  } finally {
    clearAgentTelemetry(rig.ctx);
    rig.cleanup();
  }
});