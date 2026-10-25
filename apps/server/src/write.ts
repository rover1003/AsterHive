import type { Ctx } from './types.ts';
import { snapshotNow, auditWrite } from './backup.ts';

export function logEvent(
  ctx: Ctx,
  type: string,
  payload: Record<string, unknown> = {},
): number {
  const result = ctx.holder.db
    .prepare('INSERT INTO event (type, payload, time_created) VALUES (?, ?, ?)')
    .run(type, JSON.stringify(payload), Date.now());
  const id = Number(result.lastInsertRowid);
  ctx.pending.push({ id, type, payload });
  return id;
}

// 结构化写管线（立项计划 §7）：快照 → 事务 → 校验 → 提交 → 审计；失败回滚并审计。
// 成功提交后，本次写入产生的事件经总线发布（SSE / 主脑唤醒用）。
export function withWrite<T>(ctx: Ctx, label: string, fn: () => T): T {
  const { db } = ctx.holder;
  snapshotNow(db, ctx.cfg.dataDir, ctx.cfg.keepSnapshots);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok') throw new Error(`integrity check failed: ${check.quick_check}`);
    db.exec('COMMIT');
    auditWrite(ctx.cfg.dataDir, { time: Date.now(), label, result: 'ok' });
    const events = ctx.pending;
    ctx.pending = [];
    for (const e of events) ctx.bus.publish(e.type, e.payload, e.id);
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    auditWrite(ctx.cfg.dataDir, {
      time: Date.now(),
      label,
      result: 'rollback',
      detail: err instanceof Error ? err.message : String(err),
    });
    ctx.pending = [];
    throw err;
  }
}

export function listEvents(
  ctx: Ctx,
  opts: { type?: string; before?: number; limit?: number } = {},
): { id: number; type: string; payload: Record<string, unknown>; time_created: number }[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = opts.type
    ? ctx.holder.db
          .prepare(
            'SELECT id, type, payload, time_created FROM event WHERE type = ? AND id < ? ORDER BY id DESC LIMIT ?',
          )
          .all(opts.type, opts.before ?? Number.MAX_SAFE_INTEGER, limit)
    : ctx.holder.db
          .prepare(
            'SELECT id, type, payload, time_created FROM event WHERE id < ? ORDER BY id DESC LIMIT ?',
          )
          .all(opts.before ?? Number.MAX_SAFE_INTEGER, limit);
  return (
    rows as { id: number; type: string; payload: string; time_created: number }[]
  ).map((r) => ({
    id: r.id,
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    time_created: r.time_created,
  }));
}
