import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import type { SQLInputValue } from 'node:sqlite';
import { withWrite, logEvent } from './write.ts';
import type { Agent } from './agents.ts';
import { getTask, getBoard, requireParticipant, type Task } from './tasks.ts';
import { messageInner } from './messages.ts';

function requireExecutingRole(actor: Agent): void {
  // 主脑绝不执行任务（§8.2）——结构性约束，不是 prompt 自觉
  if (actor.role === 'orchestrator') {
    throw new HttpError(403, 'orchestrator never executes tasks (dispatch only)');
  }
}

function requireTaskRow(ctx: Ctx, id: string): Task {
  return getTask(ctx, id); // 404 if missing
}

function isElevated(actor: Agent): boolean {
  return actor.role === 'orchestrator' || actor.role === 'user';
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

// 认领文件清单互斥（交接协议）：任意两份活跃认领的文件清单不允许重叠。
// 全局生效（跨 board），按归一化路径比较；通配符条目按前缀段近似处理。
function fileConflicts(ctx: Ctx, files: string[], selfActorId: string): string[] {
  const mine = new Set(files.map(normalizePath).filter(Boolean));
  if (mine.size === 0) return [];
  const rows = ctx.holder.db
    .prepare("SELECT id, assignee, files FROM task WHERE status='active' AND lane = 'InProgress'")
    .all() as { id: string; assignee: string; files: string }[];
  const conflicts: string[] = [];
  for (const r of rows) {
    if (r.assignee === selfActorId) continue;
    const theirs = (JSON.parse(r.files) as string[]).map(normalizePath);
    if (theirs.some((f) => mine.has(f))) conflicts.push(r.id);
  }
  return conflicts;
}

function assertClaimable(ctx: Ctx, task: Task, actor: Agent, files: string[]): void {
  requireExecutingRole(actor);
  if (task.lane !== 'Ready') throw new HttpError(409, `task ${task.id} not in Ready (lane: ${task.lane})`);
  // 主脑 dispatch 预指派的卡，仅指派对象本人（或管理员）可认领执行；未指派或指派给他人均不可认领
  if (
    task.assignee !== actor.id &&
    task.assignee !== actor.handle &&
    !isElevated(actor)
  ) {
    throw new HttpError(409, `task ${task.id} assigned to ${task.assignee}`);
  }
  const conflicts = fileConflicts(ctx, files, actor.id);
  if (conflicts.length > 0) {
    throw new HttpError(409, `files overlap with active claims: ${conflicts.join(', ')}`);
  }
}

// 内层认领动作（不自行开事务）：claimTask 与 nextTask 各自在自己的 withWrite 里调用
function claimInner(ctx: Ctx, task: Task, actor: Agent, files: string[] | null, via: string): Task {
  const now = Date.now();
  const isFirstClaim = (task.attempt ?? 0) <= 1 && task.claimedAt === null && (task.reviewReworks ?? 0) === 0;
  const nextAttempt = isFirstClaim ? 1 : (task.attempt ?? 1) + 1;
  let sql =
    "UPDATE task SET assignee = ?, lane = 'InProgress', attempt = ?, claimed_at = ?, last_activity_at = ?, last_real_activity_at = NULL, last_activity_kind = NULL, last_progress_at = NULL, updated_at = ?";
  const args: SQLInputValue[] = [actor.id, nextAttempt, now, now, now];
  if (files !== null) {
    sql += ', files = ?';
    args.push(JSON.stringify(files));
  }
  sql += ' WHERE id = ?';
  args.push(task.id);
  ctx.holder.db.prepare(sql).run(...args);
  logEvent(ctx, 'task.claimed', { taskId: task.id, by: actor.id, via, files: files ?? task.files });
  return getTask(ctx, task.id);
}

export function claimTask(ctx: Ctx, actor: Agent, taskId: string, files?: string[]): Task {
  const task = requireTaskRow(ctx, taskId);
  requireParticipant(ctx, task.boardId, actor); // 看板参与限制（worker 须在参与者列表内）
  if (task.status === 'cancelled') throw new HttpError(409, `task ${task.id} is cancelled`);
  assertClaimable(ctx, task, actor, files ?? task.files);
  return withWrite(ctx, 'task.claim', () => claimInner(ctx, task, actor, files === undefined ? null : files, 'claim'));
}

// TTL 断线判定（交接协议，计划 §4.3.6）：
// 网络断开或超时时，保留 InProgress、工作区及文件所有权，禁止自动释放或盲目重派；
// 仅记录审计事件与雷达预警，只有经物理确认停止或显式解绑栅栏才能重派。
function sweepStale(ctx: Ctx, boardId: string): string[] {
  const cutoff = Date.now() - ctx.cfg.ttlMinutes * 60_000;
  const rows = ctx.holder.db
    .prepare("SELECT id, assignee FROM task WHERE board_id = ? AND status='active' AND lane = 'InProgress' AND last_activity_at < ?")
    .all(boardId, cutoff) as { id: string; assignee: string }[];
  for (const r of rows) {
    logEvent(ctx, 'task.stale_detected', { taskId: r.id, assignee: r.assignee, ttlMinutes: ctx.cfg.ttlMinutes });
  }
  return [];
}

// next 动态拉取（Hermes + Nomad 调度增强）：
// next 动态拉取：仅认领明确定向指派给当前工蜂的任务卡（assignee === actor.id || assignee === actor.handle）
// 禁止公共池抢活与盲抢未指派卡；未指派任务或无本工蜂任务安全返回 { task: null }
export function nextTask(
  ctx: Ctx,
  actor: Agent,
  boardId: string,
): { task: Task | null; swept: string[] } {
  getBoard(ctx, boardId); // 404 if missing
  requireExecutingRole(actor);
  requireParticipant(ctx, boardId, actor); // 看板参与限制（worker 须在参与者列表内）
  return withWrite(ctx, 'task.next', () => {
    const swept = sweepStale(ctx, boardId);
    const candidate = ctx.holder.db
      .prepare(
        `SELECT id FROM task
         WHERE board_id = ? AND status='active' AND lane = 'Ready'
           AND (assignee = ? OR assignee = ?)
         ORDER BY priority, created_at, id
         LIMIT 1`,
      )
      .get(boardId, actor.id, actor.handle) as { id: string } | undefined;
    if (!candidate) return { task: null, swept };
    const task = getTask(ctx, candidate.id);
    const wip = ctx.holder.db
      .prepare("SELECT COUNT(*) AS n FROM task WHERE board_id = ? AND status='active' AND lane = 'InProgress'")
      .get(boardId) as { n: number };
    const board = getBoard(ctx, boardId);
    const limit = board.wip.InProgress ?? 3;
    if (wip.n >= limit) return { task: null, swept };
    const claimed = claimInner(ctx, task, actor, null, 'next');
    return { task: claimed, swept };
  });
}
export interface CheckpointInput {
  note: string;
  kind?: string;
  isKeepalive?: boolean;
  attempt?: number;
}

export function checkpointTask(
  ctx: Ctx,
  actor: Agent,
  taskId: string,
  input: string | CheckpointInput,
): { task: Task; pendingMessages: unknown[] } {
  const note = (typeof input === 'string' ? input : input?.note)?.trim();
  if (!note) throw new HttpError(422, 'note required');
  const task = requireTaskRow(ctx, taskId);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${task.id} is cancelled`);
  if (task.lane !== 'InProgress') throw new HttpError(409, `task ${task.id} not InProgress (lane: ${task.lane})`);
  if (task.assignee !== actor.id && task.assignee !== actor.handle && !isElevated(actor)) {
    throw new HttpError(403, `only assignee (${task.assignee}) or orchestrator/user may checkpoint`);
  }
  const taskAttempt = task.attempt ?? 1;
  if (taskAttempt > 1) {
    const reqAttempt = typeof input === 'object' && input !== null ? input.attempt : undefined;
    if (reqAttempt === undefined) {
      throw new HttpError(
        409,
        `stale or unversioned execution attempt: task ${taskId} has been re-dispatched (attempt ${taskAttempt}); request must include current attempt (upgrade worker SDK)`,
      );
    }
    if (reqAttempt !== taskAttempt) {
      throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${reqAttempt}`);
    }
  } else if (typeof input === 'object' && input !== null && input.attempt !== undefined && input.attempt !== taskAttempt) {
    throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${input.attempt}`);
  }

  // T105: 识别保活心跳与真实活动
  const isExplicitKeepalive = typeof input === 'object' && input !== null && (input.isKeepalive === true || input.kind === 'keepalive');
  const isLegacyKeepalive = /进行中[：:]\s*任务持续执行/i.test(note) || /^keepalive/i.test(note);
  const isKeepalive = isExplicitKeepalive || isLegacyKeepalive;

  const now = Date.now();
  const inputKind = typeof input === 'object' && input !== null ? input.kind : undefined;
  const activityKind = isKeepalive ? 'keepalive' : (inputKind || 'milestone');

  withWrite(ctx, isKeepalive ? 'task.keepalive' : 'task.checkpoint', () => {
    if (isKeepalive) {
      ctx.holder.db
        .prepare('UPDATE task SET last_activity_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, taskId);
      logEvent(ctx, 'task.keepalive', { taskId, by: actor.id, note });
    } else {
      ctx.holder.db
        .prepare('UPDATE task SET last_activity_at = ?, last_real_activity_at = ?, last_activity_kind = ?, last_progress_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, activityKind, now, now, taskId);
      logEvent(ctx, 'task.checkpoint', { taskId, by: actor.id, note, kind: activityKind });
    }
  });

  ctx.holder.db.prepare('UPDATE agent SET last_seen_at = ? WHERE id = ?').run(now, actor.id);
  const pendingMessages = deliverPending(ctx, actor);
  return { task: getTask(ctx, taskId), pendingMessages };
}

interface PendingMessage {
  id: number;
  author: string;
  mentions: string[];
  taskRef: string | null;
  content: string;
  createdAt: number;
}

function deliverPending(ctx: Ctx, agent: Agent): PendingMessage[] {
  const agentRow = ctx.holder.db
    .prepare('SELECT delivered_message_id FROM agent WHERE id = ?')
    .get(agent.id) as { delivered_message_id: number };
  const rows = ctx.holder.db
    .prepare(
      'SELECT id, author, mentions, task_ref, content, created_at FROM message WHERE id > ? ORDER BY id',
    )
    .all(agentRow.delivered_message_id) as {
    id: number;
    author: string;
    mentions: string;
    task_ref: string | null;
    content: string;
    created_at: number;
    }[];
  const out: PendingMessage[] = [];
  for (const r of rows) {
    const mentions = JSON.parse(r.mentions) as string[];
    const mine =
      mentions.includes(agent.handle) ||
      (agent.role === 'orchestrator' && mentions.includes('主脑'));
    if (mine) {
      out.push({
        id: r.id,
        author: r.author,
        mentions,
        taskRef: r.task_ref,
        content: r.content,
        createdAt: r.created_at,
      });
    }
  }
  if (rows.length > 0) {
    ctx.holder.db
      .prepare('UPDATE agent SET delivered_message_id = ? WHERE id = ?')
      .run(rows[rows.length - 1].id, agent.id);
  }
  return out;
}

export function releaseTask(ctx: Ctx, actor: Agent, taskId: string, reason?: string): Task {
  const task = requireTaskRow(ctx, taskId);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
  if (task.lane !== 'InProgress') throw new HttpError(409, `task ${task.id} not InProgress (lane: ${task.lane})`);
  if (task.assignee !== actor.id && task.assignee !== actor.handle && !isElevated(actor)) {
    throw new HttpError(403, 'only assignee or orchestrator/user may release');
  }
  const depsOk = task.dependsOn.every((d) => {
    const dep = ctx.holder.db.prepare("SELECT lane FROM task WHERE id = ? AND status='active'").get(d) as { lane: string } | undefined;
    return dep?.lane === 'Done';
  });
  return withWrite(ctx, 'task.release', () => {
    ctx.holder.db
      .prepare(
        `UPDATE task SET assignee = 'unassigned', lane = ?, attempt = attempt + 1, claimed_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(depsOk ? 'Ready' : 'Backlog', Date.now(), taskId);
    logEvent(ctx, 'task.released', { taskId, by: actor.id, reason: reason ?? '' });
    return getTask(ctx, taskId);
  });
}

export interface SubmitInput {
  summary: string;
  evidence?: Task['evidence'];
  /** Explicit no-code results remain in manual Review; they are never auto-approved. */
  noCode?: boolean;
  attempt?: number;
}

export function submitTask(ctx: Ctx, actor: Agent, taskId: string, input: SubmitInput): Task {
  if (!input.summary?.trim()) throw new HttpError(422, 'summary required');
  const task = requireTaskRow(ctx, taskId);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
  if (task.lane !== 'InProgress') throw new HttpError(409, `task ${task.id} not InProgress (lane: ${task.lane})`);
  if (task.assignee !== actor.id && !isElevated(actor)) {
    throw new HttpError(403, 'only assignee or orchestrator/user may submit');
  }
  const taskAttempt = task.attempt ?? 1;
  if (taskAttempt > 1) {
    if (input.attempt === undefined) {
      throw new HttpError(
        409,
        `stale or unversioned execution attempt: task ${taskId} has been re-dispatched (attempt ${taskAttempt}); submit must include current attempt (upgrade worker SDK)`,
      );
    }
    if (input.attempt !== taskAttempt) {
      throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${input.attempt}`);
    }
  } else if (input.attempt !== undefined && input.attempt !== taskAttempt) {
    throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${input.attempt}`);
  }
  // Review 泳道同样受 WIP 约束
  const board = getBoard(ctx, task.boardId);
  const reviewLimit = board.wip.Review ?? 3;
  const reviewCount = ctx.holder.db
    .prepare("SELECT COUNT(*) AS n FROM task WHERE board_id = ? AND status='active' AND lane = 'Review' AND id != ?")
    .get(task.boardId, taskId) as { n: number };
  if (reviewCount.n >= reviewLimit) {
    throw new HttpError(409, `WIP limit reached for Review on board ${task.boardId} (limit ${reviewLimit})`);
  }
  const noCodeAuthorized = task.workspace.noCode === true;
  const noCode = noCodeAuthorized;
  if (input.noCode === true && !noCodeAuthorized) {
    throw new HttpError(409, 'no-code submission is not authorized by this task; set workspace.noCode=true when creating a no-code task');
  }
  const settingsRow = ctx.holder.db.prepare("SELECT value FROM settings WHERE key='orchestrator'").get() as { value?: string } | undefined;
  let reviewerEnabled = false;
  try {
    reviewerEnabled = !noCode && JSON.parse(settingsRow?.value ?? '{}').reviewerEnabled === true && board.repoMode === 'managed';
  } catch { /* invalid settings fall back to manual review */ }
  const evidence = [...(task.evidence ?? []), ...(input.evidence ?? [])];
  return withWrite(ctx, 'task.submit', () => {
    const now = Date.now();
    ctx.holder.db
      .prepare("UPDATE task SET lane='Review', review_status=?, review_attempts=0, review_reworks=CASE WHEN review_status='rework' THEN review_reworks ELSE 0 END, review_summary='', submit_summary=?, evidence=?, last_activity_at=?, last_real_activity_at=?, last_activity_kind='submit', last_progress_at=?, updated_at=? WHERE id=?")
      .run(reviewerEnabled ? 'pending' : 'none', input.summary.trim().slice(0, 6000), JSON.stringify(evidence), now, now, now, now, taskId);
    logEvent(ctx, 'task.submitted', {
      taskId,
      by: actor.id,
      summary: input.summary.trim(),
      evidence: input.evidence ?? [],
      reviewerEnabled,
      noCode,
    });
    if (reviewerEnabled) logEvent(ctx, 'task.review_queued', { taskId, boardId: task.boardId });
    messageInner(ctx, {
      boardId: task.boardId,
      author: actor.id,
      kind: 'submit',
      content: reviewerEnabled
        ? `@主脑 ${taskId} 已完成并排队独立审核：${input.summary.trim()}`
        : `@主脑 ${taskId} 已完成并进入人工验收${noCode ? '（无代码任务）' : ''}：${input.summary.trim()}`,
    });
    return getTask(ctx, taskId);
  });
}
