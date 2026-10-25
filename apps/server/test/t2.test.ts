import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { withWrite, logEvent, listEvents } from '../src/write.ts';
import { listSnapshots, readAudit, restoreSnapshot } from '../src/backup.ts';

test('T2: 结构化写先快照、事件落库、审计记录', () => {
  const rig = mkRig();
  try {
    withWrite(rig.ctx, 'test.write1', () => {
      logEvent(rig.ctx, 'note.created', { text: 'a' });
    });
    const events = listEvents(rig.ctx);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'note.created');
    assert.equal(events[0].payload.text, 'a');
    const snaps = listSnapshots(rig.ctx.cfg.dataDir);
    assert.equal(snaps.length, 1, '写前快照已生成');
    const audit = readAudit(rig.ctx.cfg.dataDir, 10);
    assert.equal(audit.at(-1)?.label, 'test.write1');
    assert.equal(audit.at(-1)?.result, 'ok');
  } finally {
    rig.cleanup();
  }
});

test('T2: 快照轮换只保留最近 3 份', () => {
  const rig = mkRig();
  try {
    for (let i = 0; i < 5; i++) {
      withWrite(rig.ctx, `test.write${i}`, () => {
        logEvent(rig.ctx, 'note.created', { i });
      });
    }
    assert.equal(listSnapshots(rig.ctx.cfg.dataDir).length, 3);
    assert.equal(listEvents(rig.ctx).length, 5, '事件本身不受轮换影响');
  } finally {
    rig.cleanup();
  }
});

test('T2: 写入失败回滚——事件不落库、审计记 rollback、待发事件清空', () => {
  const rig = mkRig();
  try {
    withWrite(rig.ctx, 'test.ok', () => logEvent(rig.ctx, 'note.created', { i: 1 }));
    assert.throws(
      () =>
        withWrite(rig.ctx, 'test.bad', () => {
          logEvent(rig.ctx, 'note.created', { i: 2 });
          throw new Error('boom');
        }),
      /boom/,
    );
    const events = listEvents(rig.ctx);
    assert.equal(events.length, 1, '失败写入的事件已回滚');
    const audit = readAudit(rig.ctx.cfg.dataDir, 10);
    assert.equal(audit.at(-1)?.result, 'rollback');
    assert.equal(rig.ctx.pending.length, 0, '待发布事件已清空');
  } finally {
    rig.cleanup();
  }
});

test('T2: 快照恢复——库回到快照时点，且恢复后可继续写', () => {
  const rig = mkRig();
  try {
    for (let i = 0; i < 3; i++) {
      withWrite(rig.ctx, `test.write${i}`, () => logEvent(rig.ctx, 'note.created', { i }));
    }
    // 三次写产生三份快照（分别对应写前 0/1/2 条事件），最新的快照 = 写第 3 条前的状态
    const snaps = listSnapshots(rig.ctx.cfg.dataDir);
    assert.equal(snaps.length, 3);
    restoreSnapshot(rig.ctx.holder, rig.ctx.cfg.dataDir, snaps[0].name);
    assert.equal(listEvents(rig.ctx).length, 2, '恢复到写第 3 条之前');
    withWrite(rig.ctx, 'test.afterRestore', () => logEvent(rig.ctx, 'note.created', { i: 99 }));
    assert.equal(listEvents(rig.ctx).length, 3, '恢复后可继续写入');
  } finally {
    rig.cleanup();
  }
});

test('T2: 事务提交后事件经总线发布（供 SSE）', () => {
  const rig = mkRig();
  try {
    const seen: { type: string; id: number }[] = [];
    const unsub = rig.ctx.bus.subscribe((type, _payload, id) => seen.push({ type, id }));
    withWrite(rig.ctx, 'test.bus', () => logEvent(rig.ctx, 'note.created', { x: 1 }));
    unsub();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'note.created');
    assert.ok(seen[0].id > 0, '事件带自增 id');
  } finally {
    rig.cleanup();
  }
});
