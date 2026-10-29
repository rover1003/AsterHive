import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import type { Agent } from './agents.ts';
import type { Execution, ExecutionState, ExecutionActivity } from '../../../packages/sdk/src/execution.ts';


type StoredExecution = { id: string; task_id: string; board_id: string; worker_id: string; attempt: number; base_commit: string | null; executor: string | null; state: ExecutionState; waiting_for: string | null; phase_since: number; created_at: number; accepted_at: number | null; started_at: number | null; ended_at: number | null; last_activity_at: number | null; last_milestone_at: number | null; last_sequence: number };

export function initializeExecutions(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, board_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, attempt INTEGER NOT NULL, base_commit TEXT, executor TEXT,
      state TEXT NOT NULL, waiting_for TEXT, phase_since INTEGER NOT NULL, created_at INTEGER NOT NULL,
      accepted_at INTEGER, started_at INTEGER, ended_at INTEGER,
      last_activity_at INTEGER, last_milestone_at INTEGER, last_sequence INTEGER NOT NULL DEFAULT 0,
      UNIQUE(task_id, attempt)
    );
    CREATE TABLE IF NOT EXISTS execution_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL,
      sequence INTEGER, kind TEXT NOT NULL, phase TEXT, tool_name TEXT, call_id TEXT,
      received_at INTEGER NOT NULL, source_event_id INTEGER UNIQUE,
      UNIQUE(execution_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_event_cursor ON execution_event(execution_id, id);
  `);
  // Historical tasks have no trustworthy per-phase timing; retain their known round as unknown.
  const legacy = db.prepare("SELECT * FROM task WHERE assignee != 'unassigned' AND lane IN ('InProgress','Review','Done') AND NOT EXISTS (SELECT 1 FROM execution WHERE task_id = task.id AND attempt = task.attempt)").all() as { id: string; board_id: string; assignee: string; attempt: number; created_at: number; lane: string }[];
  for (const task of legacy) {
    db.prepare('INSERT INTO execution (id,task_id,board_id,worker_id,attempt,state,phase_since,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), task.id, task.board_id, task.assignee, task.attempt, 'unknown', task.created_at, task.created_at);
  }
}

function toExecution(row: StoredExecution): Execution {
  return { id: row.id, taskId: row.task_id, boardId: row.board_id, workerId: row.worker_id, attempt: row.attempt, baseCommit: row.base_commit, executor: row.executor, state: row.state, waitingFor: row.waiting_for, phaseSince: row.phase_since, createdAt: row.created_at, acceptedAt: row.accepted_at, startedAt: row.started_at, endedAt: row.ended_at, lastActivityAt: row.last_activity_at, lastMilestoneAt: row.last_milestone_at, lastSequence: row.last_sequence };
}

function currentExecution(db: DatabaseSync, taskId: string, state: ExecutionState, now: number): StoredExecution | undefined {
  const task = db.prepare('SELECT id,board_id,assignee,attempt,workspace FROM task WHERE id = ?').get(taskId) as { id: string; board_id: string; assignee: string; attempt: number; workspace: string } | undefined;
  if (!task || task.assignee === 'unassigned') return undefined;
  let row = db.prepare('SELECT * FROM execution WHERE task_id = ? AND attempt = ?').get(taskId, task.attempt) as StoredExecution | undefined;
  if (!row) {
    const board = db.prepare('SELECT repo_head FROM board WHERE id = ?').get(task.board_id) as { repo_head: string };
    const agent = db.prepare('SELECT specs FROM agent WHERE id = ? OR handle = ?').get(task.assignee, task.assignee) as { specs: string } | undefined;
    const workspace = JSON.parse(task.workspace) as { baseCommit?: string };
    const specs = agent ? JSON.parse(agent.specs) as { executor?: string } : {};
    db.prepare('INSERT INTO execution (id,task_id,board_id,worker_id,attempt,base_commit,executor,state,phase_since,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), task.id, task.board_id, task.assignee, task.attempt, workspace.baseCommit || board.repo_head || null, specs.executor ?? null, state, now, now);
    row = db.prepare('SELECT * FROM execution WHERE task_id = ? AND attempt = ?').get(taskId, task.attempt) as StoredExecution;
  }
  return row;
}

/** Called inside the existing task write transaction, before publication. */
export function projectExecutionEvent(db: DatabaseSync, eventId: number, type: string, payload: Record<string, unknown>, now: number): void {
  if (typeof payload.taskId !== 'string') return;
  const kinds = ['task.dispatched', 'task.claimed', 'task.checkpoint', 'task.submitted', 'task.review_returned', 'task.review_rejected', 'task.cancelled', 'task.review_passed', 'task.released', 'task.control_released'];
  if (!kinds.includes(type)) return;
  const initial: ExecutionState = type === 'task.claimed' ? 'accepted' : type === 'task.dispatched' || type === 'task.review_returned' || type === 'task.review_rejected' ? 'dispatched' : 'unknown';
  const row = currentExecution(db, payload.taskId, initial, now);
  if (!row) return;
  if (typeof payload.attempt === 'number' && payload.attempt !== row.attempt) return;
  let state = row.state;
  let accepted = row.accepted_at;
  let started = row.started_at;
  let ended = row.ended_at;
  let activity = row.last_activity_at;
  let milestone = row.last_milestone_at;
  if (type === 'task.claimed') { state = 'accepted'; accepted = now; }
  if (type === 'task.checkpoint') {
    if (['error', 'timeout', 'environment_blocked'].includes(String(payload.kind))) { state = 'failed'; ended = now; }
    else if (row.waiting_for !== 'abort_settle' && ['accepted', 'dispatched', 'unknown', 'running'].includes(state)) { state = 'running'; started ??= now; }
    activity = now;
    if (payload.kind === 'milestone') milestone = now;
  }
  if (type === 'task.submitted') { state = 'awaiting_review'; ended = now; }
  if (type === 'task.cancelled') state = 'cancelling';
  if (type === 'task.review_passed') state = 'completed';
  if (type === 'task.released' || type === 'task.control_released') { state = 'unknown'; ended = now; }
  db.prepare('UPDATE execution SET state=?,phase_since=?,accepted_at=?,started_at=?,ended_at=?,last_activity_at=?,last_milestone_at=? WHERE id=?').run(state, state === row.state ? row.phase_since : now, accepted, started, ended, activity, milestone, row.id);
  db.prepare('INSERT INTO execution_event (execution_id,kind,received_at,source_event_id) VALUES (?,?,?,?)').run(row.id, type, now, eventId);
}

export function listExecutions(ctx: Ctx, taskId: string): Execution[] {
  return (ctx.holder.db.prepare('SELECT * FROM execution WHERE task_id = ? ORDER BY attempt DESC').all(taskId) as StoredExecution[]).map(toExecution);
}

export function executionEvents(ctx: Ctx, taskId: string, executionId: string, after = 0): { events: Record<string, unknown>[]; cursor: number } {
  const execution = ctx.holder.db.prepare('SELECT id FROM execution WHERE id=? AND task_id=?').get(executionId, taskId);
  if (!execution) throw new HttpError(404, 'execution not found for task');
  const rows = ctx.holder.db.prepare('SELECT id,sequence,kind,phase,tool_name AS toolName,call_id AS callId,received_at AS receivedAt FROM execution_event WHERE execution_id=? AND id>? ORDER BY id LIMIT 200').all(executionId, after) as Record<string, unknown>[];
  return { events: rows, cursor: rows.length ? Number(rows[rows.length - 1].id) : after };
}


/** Validated once by the HTTP boundary; task/owner/attempt remain authoritative here. */
export function recordExecutionActivity(ctx: Ctx, actor: Agent, taskId: string, attempt: number, input: ExecutionActivity): Execution {
  const db = ctx.holder.db;
  const task = db.prepare('SELECT assignee,attempt,status,lane FROM task WHERE id=?').get(taskId) as { assignee: string; attempt: number; status: string; lane: string } | undefined;
  if (!task) throw new HttpError(404, 'task not found');
  if (actor.role !== 'worker' || ![actor.id, actor.handle].includes(task.assignee)) throw new HttpError(403, 'execution belongs to another worker');
  if (task.attempt !== attempt) throw new HttpError(409, 'stale execution attempt');
  if (task.status === 'cancelled' && input.kind !== 'cancelled') throw new HttpError(409, 'task cancellation pending');
  const now = Date.now();
  const row = currentExecution(db, taskId, 'accepted', now)!;
  if (input.sequence <= row.last_sequence) return toExecution(row);
  if (input.kind === 'started' && row.last_sequence > 0) throw new HttpError(409, 'execution already started; controlled recovery requires a new attempt');
  if (['completed', 'awaiting_review', 'failed', 'cancelled'].includes(row.state)) throw new HttpError(409, 'execution already ended');
  let state: ExecutionState = row.state;
  let waitingFor: string | null = row.waiting_for;
  let phaseSince = row.phase_since;
  if (input.kind === 'tool' || input.kind === 'model' || input.kind === 'user') {
    state = input.phase === 'start' ? `waiting_${input.kind}` as ExecutionState : 'running';
    waitingFor = input.phase === 'start' ? input.toolName ?? input.kind : null;
  } else if (input.kind === 'failed' || input.kind === 'cancelled') { state = input.kind; waitingFor = null; }
  else if (input.kind === 'completed') { state = 'awaiting_review'; waitingFor = null; }
  else if (input.kind === 'gap') { state = 'unknown'; waitingFor = null; }
  else if (input.kind === 'cancel_requested') { state = 'unknown'; waitingFor = 'abort_settle'; }
  else state = 'running';
  if (input.sequence > row.last_sequence + 1) {
    db.prepare('INSERT INTO execution_event (execution_id,sequence,kind,received_at) VALUES (?,?,?,?)').run(row.id, input.sequence - 1, 'gap', now);
  }
  db.prepare('INSERT INTO execution_event (execution_id,sequence,kind,phase,tool_name,call_id,received_at) VALUES (?,?,?,?,?,?,?)').run(row.id, input.sequence, input.kind, input.phase ?? null, input.toolName ?? null, input.callId ?? null, now);
  if (input.kind === 'tool') {
    const pending = db.prepare(`SELECT tool_name,received_at FROM execution_event AS started
      WHERE execution_id=? AND kind='tool' AND phase='start'
        AND sequence > COALESCE((SELECT MAX(sequence) FROM execution_event WHERE execution_id=started.execution_id AND kind='gap'), 0)
        AND NOT EXISTS (SELECT 1 FROM execution_event AS finished
          WHERE finished.execution_id=started.execution_id AND finished.kind='tool'
            AND finished.phase='end' AND finished.call_id=started.call_id AND finished.sequence>started.sequence)
      ORDER BY sequence DESC LIMIT 1`).get(row.id) as { tool_name: string; received_at: number } | undefined;
    state = pending ? 'waiting_tool' : 'running';
    waitingFor = pending?.tool_name ?? null;
    phaseSince = pending?.received_at ?? now;
  }
  if (input.kind === 'started' && row.last_sequence === 0) {
    db.prepare('UPDATE execution SET base_commit=?,executor=?,accepted_at=COALESCE(accepted_at,?) WHERE id=?').run(input.baseCommit ?? row.base_commit, input.executor ?? row.executor, now, row.id);
  }
  if (row.waiting_for === 'abort_settle' && input.kind !== 'cancelled' && input.kind !== 'failed') {
    state = 'unknown';
    waitingFor = 'abort_settle';
    phaseSince = row.phase_since;
  }
  if (input.kind !== 'tool' && (state !== row.state || waitingFor !== row.waiting_for)) phaseSince = now;
  db.prepare('UPDATE execution SET state=?,waiting_for=?,phase_since=?,last_sequence=?,last_activity_at=?,started_at=COALESCE(started_at,?),ended_at=?,last_milestone_at=? WHERE id=?').run(state, waitingFor, phaseSince, input.sequence, now, now, state === 'failed' || state === 'cancelled' ? now : row.ended_at, input.kind === 'milestone' ? now : row.last_milestone_at, row.id);
  if (input.kind !== 'gap') {
    const activityKind = input.kind === 'failed' ? 'error' : input.kind;
    db.prepare(`UPDATE task SET last_activity_at=?,last_real_activity_at=?,last_activity_kind=?,
      last_progress_at=CASE WHEN ?='milestone' THEN ? ELSE last_progress_at END WHERE id=? AND attempt=?`)
      .run(now, now, activityKind, input.kind, now, taskId, attempt);
  }
  return toExecution(db.prepare('SELECT * FROM execution WHERE id=?').get(row.id) as StoredExecution);
}
