import type { DatabaseSync } from 'node:sqlite';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import type { Agent } from './agents.ts';
import type { SessionObservationEvent } from '../../../packages/sdk/src/execution.ts';
import { redactExecutionText } from '../../../packages/sdk/src/execution-report.ts';

export const SESSION_RETENTION_MS = 24 * 60 * 60_000;
export const SESSION_MAX_BYTES = 262144;
const KINDS = ['session_start', 'assistant_start', 'assistant_text', 'assistant_end', 'tool_start', 'tool_end', 'session_end', 'redacted', 'gap'];

export function initializeSessionObservation(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_observation (
      execution_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_observation_event (
      execution_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL,
      byte_length INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY (execution_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS session_observation_consent (
      task_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );`);
}

export function getSessionObservation(ctx: Ctx, taskId: string): { enabled: boolean; updatedAt: number | null } {
  const row = ctx.holder.db.prepare('SELECT enabled,updated_at FROM session_observation_consent WHERE task_id=?').get(taskId) as { enabled: number; updated_at: number } | undefined;
  return { enabled: row?.enabled === 1, updatedAt: row?.updated_at ?? null };
}

export function setSessionObservation(ctx: Ctx, actor: Agent, taskId: string, enabled: boolean): { enabled: boolean; updatedAt: number } {
  if (actor.role !== 'user') throw new HttpError(403, 'only the user can authorize session observation');
  const now = Date.now();
  ctx.holder.db.prepare(`INSERT INTO session_observation_consent(task_id,enabled,updated_at) VALUES (?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`).run(taskId, enabled ? 1 : 0, now);
  return { enabled, updatedAt: now };
}

export function parseSessionBatch(body: unknown): SessionObservationEvent[] {
  const raw = body as { events?: unknown } | null;
  if (!raw || !Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 16) throw new HttpError(422, 'session batch must contain 1–16 events');
  return raw.events.map((value: unknown) => {
    const event = value as SessionObservationEvent | null;
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !KINDS.includes(event.kind) ||
      (event.text !== undefined && (event.kind !== 'assistant_text' || typeof event.text !== 'string' || event.text.length > 4096)) ||
      (event.kind === 'assistant_text' && typeof event.text !== 'string') ||
      (event.messageId !== undefined && (typeof event.messageId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(event.messageId))) ||
      (event.contentIndex !== undefined && (!Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0 || event.contentIndex >= 8)) ||
      (event.callId !== undefined && (typeof event.callId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.callId))) ||
      (event.toolName !== undefined && !['read', 'write', 'edit', 'bash', 'powershell', 'hive_checkpoint', 'unknown'].includes(event.toolName)) ||
      (event.failed !== undefined && typeof event.failed !== 'boolean')) throw new HttpError(422, 'invalid session observation event');
    // Construct a whitelist; raw SDK fields such as args/result/thinking never reach storage or SSE.
    const text = event.text;
    const hidden = text !== undefined && (redactExecutionText(text) !== text || /(?:api[_-]?key|password|passwd|secret|token)\s*["']?\s*[:=]|-----BEGIN .*PRIVATE KEY-----/i.test(text));
    return { sequence: event.sequence, kind: hidden ? 'redacted' : event.kind,
      messageId: event.messageId, contentIndex: event.contentIndex,
      text: hidden ? undefined : text, callId: event.callId, toolName: event.toolName, failed: event.failed };
  });
}

/** The caller owns the surrounding transaction; all frames belong to one worker/attempt. */
export function storeSessionBatch(ctx: Ctx, actor: Agent, taskId: string, attempt: number, events: SessionObservationEvent[]): { executionId: string; cursor: number } {
  const db = ctx.holder.db;
  const task = db.prepare('SELECT assignee,attempt,status FROM task WHERE id=?').get(taskId) as { assignee: string; attempt: number; status: string } | undefined;
  if (!task) throw new HttpError(404, 'task not found');
  if (actor.role !== 'worker' || ![actor.id, actor.handle].includes(task.assignee)) throw new HttpError(403, 'session belongs to another worker');
  if (attempt !== task.attempt) throw new HttpError(409, 'stale execution attempt');
  if (!getSessionObservation(ctx, taskId).enabled) throw new HttpError(409, 'session observation is not enabled by the user');
  if (task.status === 'cancelled' && events.some(event => event.kind !== 'session_end')) throw new HttpError(409, 'task cancellation pending');
  const execution = db.prepare('SELECT id,executor FROM execution WHERE task_id=? AND attempt=?').get(taskId, attempt) as { id: string; executor: string | null } | undefined;
  if (!execution) throw new HttpError(409, 'execution has not been accepted');
  if (execution.executor !== 'pi') throw new HttpError(409, 'executor does not support session observation');
  const now = Date.now();
  db.prepare('DELETE FROM session_observation_event WHERE received_at < ?').run(now - SESSION_RETENTION_MS);
  const previous = db.prepare('SELECT last_sequence,ended FROM session_observation WHERE execution_id=?').get(execution.id) as { last_sequence: number; ended: number } | undefined;
  let cursor = previous?.last_sequence ?? 0;
  let ended = previous?.ended ?? 0;
  for (const event of events) {
    if (event.sequence <= cursor) continue;
    if (ended) throw new HttpError(409, 'session already ended');
    const payload = JSON.stringify({ ...event, gapBefore: event.sequence > cursor + 1 });
    db.prepare('INSERT INTO session_observation_event (execution_id,sequence,payload,byte_length,received_at) VALUES (?,?,?,?,?)').run(execution.id, event.sequence, payload, Buffer.byteLength(payload), now);
    cursor = event.sequence;
    if (event.kind === 'session_end') ended = 1;
  }
  db.prepare(`INSERT INTO session_observation (execution_id,last_sequence,ended,received_at) VALUES (?,?,?,?)
    ON CONFLICT(execution_id) DO UPDATE SET last_sequence=excluded.last_sequence,ended=excluded.ended,received_at=excluded.received_at`).run(execution.id, cursor, ended, now);
  db.prepare(`DELETE FROM session_observation_event WHERE execution_id=? AND sequence NOT IN
    (SELECT sequence FROM session_observation_event WHERE execution_id=? ORDER BY sequence DESC LIMIT 512)`).run(execution.id, execution.id);
  db.prepare(`DELETE FROM session_observation_event WHERE execution_id=? AND sequence IN
    (SELECT sequence FROM (SELECT sequence,SUM(byte_length) OVER (ORDER BY sequence DESC) AS retained
      FROM session_observation_event WHERE execution_id=?) WHERE retained>?)`).run(execution.id, execution.id, SESSION_MAX_BYTES);
  return { executionId: execution.id, cursor };
}

export function readSessionSnapshot(ctx: Ctx, taskId: string, executionId: string, after: number): {
  availability: 'not_enabled' | 'unsupported' | 'not_started' | 'streaming' | 'ended' | 'expired';
  executionId: string; events: SessionObservationEvent[]; cursor: number; oldestSequence: number | null; gap: boolean; receivedAt: number | null;
} {
  const db = ctx.holder.db;
  const execution = db.prepare('SELECT executor FROM execution WHERE id=? AND task_id=?').get(executionId, taskId) as { executor: string | null } | undefined;
  if (!execution) throw new HttpError(404, 'execution not found for task');
  const state = db.prepare('SELECT last_sequence,ended,received_at FROM session_observation WHERE execution_id=?').get(executionId) as { last_sequence: number; ended: number; received_at: number } | undefined;
  const oldest = db.prepare('SELECT MIN(sequence) AS sequence FROM session_observation_event WHERE execution_id=? AND received_at>=?').get(executionId, Date.now() - SESSION_RETENTION_MS) as { sequence: number | null };
  const rows = db.prepare('SELECT payload FROM session_observation_event WHERE execution_id=? AND sequence>? AND received_at>=? ORDER BY sequence LIMIT 512').all(executionId, after, Date.now() - SESSION_RETENTION_MS) as { payload: string }[];
  const events = rows.map(row => JSON.parse(row.payload) as SessionObservationEvent);
  const enabled = getSessionObservation(ctx, taskId).enabled;
  const availability = !enabled ? 'not_enabled' : execution.executor !== 'pi' ? 'unsupported' : !state ? 'not_started' : state.received_at < Date.now() - SESSION_RETENTION_MS || oldest.sequence === null ? 'expired' : state.ended ? 'ended' : 'streaming';
  const cursor = state?.last_sequence ?? 0;
  return { availability, executionId, events: enabled ? events : [], cursor, oldestSequence: oldest.sequence,
    gap: (oldest.sequence !== null && after < oldest.sequence - 1) || events.some(event => event.kind === 'gap' || event.gapBefore) || (cursor > after && events.length === 0), receivedAt: state?.received_at ?? null };
}
