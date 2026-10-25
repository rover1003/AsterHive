// brain.stream 节流发布纯函数测试（t14 流式显示）：
// 注入 fake publish + 假时钟/手动定时器队列，不睡真实时间——
// 断言 300ms 窗口内多次增量只发布一次、末次含全文、超长文本截断、end 相位补发余量、无产出轮不发帧。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttledStreamPublish, type BrainStreamFrame } from '../src/brain.ts';

// ---- 假时钟：手动推进 + 按到期顺序执行定时器（fire 里再排的定时器继续参与排序）----
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): unknown => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer: (handle: unknown): void => void timers.delete(handle as number),
    /** 推进时钟 ms，执行全部到期定时器（按到期时间排序，逐个驱动） */
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
    },
    pendingCount: (): number => timers.size,
  };
}

// fake publish：收集发布帧
function fakePublish() {
  const frames: BrainStreamFrame[] = [];
  return { frames, publish: (frame: BrainStreamFrame) => frames.push(frame) };
}

test('节流：300ms 窗口内多次增量只发布一次，末次含全文；下一窗口照常发布', () => {
  const clock = fakeClock();
  const { frames, publish } = fakePublish();
  const s = throttledStreamPublish(publish, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  // 窗口内连续增量：只累积，不发布
  s.push('你');
  s.push('你好');
  s.push('你好，世界');
  assert.equal(frames.length, 0, '窗口未到期不应发布');

  // 窗口到期：合并为一次发布，内容为窗口末最新全文
  clock.advance(300);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { phase: 'streaming', text: '你好，世界' });

  // 下一窗口：新增量照常在新窗口发布
  s.push('你好，世界。');
  assert.equal(frames.length, 1, '新窗口未到期不应发布');
  clock.advance(300);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[1], { phase: 'streaming', text: '你好，世界。' });
});

test('节流：发布文本超限截断尾部加 …（累积不受影响）', () => {
  const clock = fakeClock();
  const { frames, publish } = fakePublish();
  const s = throttledStreamPublish(publish, {
    maxChars: 10,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  s.push('0123456789');
  s.push('0123456789ABCDEF'); // 窗口内的第二次增量：全文 16 字
  clock.advance(300);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].phase, 'streaming');
  assert.equal((frames[0] as { text: string }).text, '0123456789…', '应截断到 10 字并加省略号');
});

test('节流：end 补发未到期余量全文 + end 相位', () => {
  const clock = fakeClock();
  const { frames, publish } = fakePublish();
  const s = throttledStreamPublish(publish, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  s.push('收到，开始拆解');
  // 不推进时钟直接 end：挂起窗口的余量全文先补发，再发 end
  s.end();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { phase: 'streaming', text: '收到，开始拆解' });
  assert.deepEqual(frames[1], { phase: 'end' });
  assert.equal(clock.pendingCount(), 0, '挂起定时器应被清理');
});

test('节流：end 时窗口已发布过 → 只发 end 相位，不重发旧全文', () => {
  const clock = fakeClock();
  const { frames, publish } = fakePublish();
  const s = throttledStreamPublish(publish, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  s.push('a');
  clock.advance(300); // 余量已随窗口发出
  s.end();
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { phase: 'streaming', text: 'a' });
  assert.deepEqual(frames[1], { phase: 'end' });
});

test('节流：无产出轮（从未 push）end 一帧不发', () => {
  const clock = fakeClock();
  const { frames, publish } = fakePublish();
  const s = throttledStreamPublish(publish, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  s.end();
  assert.equal(frames.length, 0, '纯工具轮/无产出轮不应产生任何 brain.stream 帧');
});

test('节流：end 清掉挂起定时器后不重复发布', () => {
  const clock = fakeClock();
  const { frames, publish } = fakePublish();
  const s = throttledStreamPublish(publish, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  s.push('x');
  s.end(); // 清挂起定时器并补发
  clock.advance(300); // 被清掉的定时器不应再触发
  assert.equal(frames.length, 2, 'end 补发全文 + end 相位各一帧，无重复');
  assert.deepEqual(frames[1], { phase: 'end' });
});
