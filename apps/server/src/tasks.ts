import type { Ctx } from './types.ts';
import { HttpError, assertNoMojibake } from './types.ts';
import type { SQLInputValue } from 'node:sqlite';
import { withWrite, logEvent } from './write.ts';
import { getAgent, type Agent } from './agents.ts';

export const LANES = ['Backlog', 'Ready', 'InProgress', 'Review', 'Done'] as const;
export type Lane = (typeof LANES)[number];
export type Priority = 'P0' | 'P1' | 'P2';

// WIP 限制默认值（立项计划 §5.2：每泳道 2–3）；board.wip 可按泳道覆盖
export const DEFAULT_WIP: Partial<Record<Lane, number>> = { InProgress: 3, Review: 3 };

export interface Board {
  id: string;
  name: string;
  /** GitHub 仓库地址（项目元数据，可空） */
  repo: string;
  /** 项目描述（可空） */
  description: string;
  wip: Partial<Record<Lane, number>>;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  boardId: string;
  title: string;
  detail: string;
  lane: Lane;
  assignee: string;
  dependsOn: string[];
  priority: Priority;
  category: string;
  acceptance: string;
  workspace: Record<string, unknown>;
  files: string[];
  evidence: { path: string; machine?: string; note?: string }[];
  protectedPaths: string[];
  claimedAt: number | null;
  lastActivityAt: number | null;
  autoUnblockedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type TaskRow = {
  id: string;
  board_id: string;
  title: string;
  detail: string;
  lane: Lane;
  assignee: string;
  depends_on: string;
  priority: Priority;
  category: string;
  acceptance: string;
  workspace: string;
  files: string;
  evidence: string;
  protected_paths: string;
  claimed_at: number | null;
  last_activity_at: number | null;
  auto_unblocked_at: number | null;
  created_at: number;
  updated_at: number;
};

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    boardId: r.board_id,
    title: r.title,
    detail: r.detail,
    lane: r.lane,
    assignee: r.assignee,
    dependsOn: JSON.parse(r.depends_on) as string[],
    priority: r.priority,
    category: r.category,
    acceptance: r.acceptance,
    workspace: JSON.parse(r.workspace) as Record<string, unknown>,
    files: JSON.parse(r.files) as string[],
    evidence: JSON.parse(r.evidence) as Task['evidence'],
    protectedPaths: JSON.parse(r.protected_paths) as string[],
    claimedAt: r.claimed_at,
    lastActivityAt: r.last_activity_at,
    autoUnblockedAt: r.auto_unblocked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const TASK_ID_RE = /^[A-Z][A-Z0-9]*-?\d+$/; // T42 / BUG-17 / AUX-3

// ---- Board ----

type BoardRow = {
  id: string;
  name: string;
  wip: string;
  repo: string;
  description: string;
  created_at: number;
  updated_at: number;
};

function rowToBoard(r: BoardRow): Board {
  return {
    id: r.id,
    name: r.name,
    repo: r.repo,
    description: r.description,
    wip: JSON.parse(r.wip) as Board['wip'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listBoards(ctx: Ctx): Board[] {
  const rows = ctx.holder.db.prepare('SELECT * FROM board ORDER BY created_at').all() as BoardRow[];
  return rows.map(rowToBoard);
}

export interface CreateBoardInput {
  id?: string;
  name: string;
  repo?: string;
  description?: string;
  wip?: Board['wip'];
}

// 乱码防护：字符串字段统一过一遍（与注册/消息同一纪律），坏编码客户端当场 422
function guardBoardInput(input: { name?: string; repo?: string; description?: string }): void {
  for (const [field, v] of Object.entries({ name: input.name, repo: input.repo, description: input.description })) {
    if (typeof v === 'string') assertNoMojibake(v, `board.${field}`);
  }
}

function guardTaskInput(input: Record<string, unknown>): void {
  for (const field of ['title', 'detail', 'category', 'acceptance']) {
    const v = input[field];
    if (typeof v === 'string') assertNoMojibake(v, `task.${field}`);
  }
}

export function createBoard(ctx: Ctx, input: CreateBoardInput): Board {
  guardBoardInput(input);
  const id = (input.id ?? input.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (!id) throw new HttpError(422, 'board id required');
  const now = Date.now();
  try {
    withWrite(ctx, 'board.create', () => {
      ctx.holder.db
        .prepare(
          'INSERT INTO board (id, name, repo, description, wip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.name, input.repo ?? '', input.description ?? '', JSON.stringify(input.wip ?? {}), now, now);
      logEvent(ctx, 'board.created', { boardId: id, name: input.name });
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new HttpError(409, `board already exists: ${id}`);
    }
    throw err;
  }
  return rowToBoard(ctx.holder.db.prepare('SELECT * FROM board WHERE id = ?').get(id) as BoardRow);
}

export function getBoard(ctx: Ctx, id: string): Board {
  const row = ctx.holder.db.prepare('SELECT * FROM board WHERE id = ?').get(id) as BoardRow | undefined;
  if (!row) throw new HttpError(404, `board not found: ${id}`);
  return rowToBoard(row);
}

export interface PatchBoardInput {
  name?: string;
  repo?: string;
  description?: string;
}

// 看板管理（"看板=项目管理"）：改项目名称 / GitHub 仓库地址 / 描述；部分更新，只落传入字段
export function updateBoard(ctx: Ctx, boardId: string, patch: PatchBoardInput): Board {
  guardBoardInput(patch);
  getBoard(ctx, boardId); // 404 if missing
  if (patch.name !== undefined && !patch.name.trim()) throw new HttpError(422, 'name required');
  withWrite(ctx, 'board.update', () => {
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    const push = (col: string, val: SQLInputValue) => {
      sets.push(`${col} = ?`);
      args.push(val);
    };
    if (patch.name !== undefined) push('name', patch.name.trim());
    if (patch.repo !== undefined) push('repo', patch.repo.trim());
    if (patch.description !== undefined) push('description', patch.description);
    push('updated_at', Date.now());
    ctx.holder.db
      .prepare(`UPDATE board SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, boardId);
    // 只记录实际提交的字段（HTTP 层会把未传字段填成 undefined，需过滤）
    const changedFields = Object.keys(patch).filter(
      (k) => patch[k as keyof PatchBoardInput] !== undefined,
    );
    logEvent(ctx, 'board.updated', { boardId, fields: changedFields });
  });
  return getBoard(ctx, boardId);
}

// 删除看板：级联清掉该板全部任务、消息与参与者记录（同一事务）。
// 事件台账是追加式历史日志，刻意不动——删板事实本身记 board.deleted 留痕。
export function deleteBoard(ctx: Ctx, boardId: string): { taskCount: number; messageCount: number } {
  getBoard(ctx, boardId); // 404 if missing
  return withWrite(ctx, 'board.delete', () => {
    const taskCount = (
      ctx.holder.db.prepare('SELECT COUNT(*) AS n FROM task WHERE board_id = ?').get(boardId) as { n: number }
    ).n;
    const messageCount = (
      ctx.holder.db.prepare('SELECT COUNT(*) AS n FROM message WHERE board_id = ?').get(boardId) as { n: number }
    ).n;
    ctx.holder.db.prepare('DELETE FROM task WHERE board_id = ?').run(boardId);
    ctx.holder.db.prepare('DELETE FROM message WHERE board_id = ?').run(boardId);
    ctx.holder.db.prepare('DELETE FROM board_participant WHERE board_id = ?').run(boardId);
    ctx.holder.db.prepare('DELETE FROM board WHERE id = ?').run(boardId);
    logEvent(ctx, 'board.deleted', { boardId, taskCount, messageCount });
    return { taskCount, messageCount };
  });
}

// ---- 看板参与者 ----

// 参与者列表：空数组 = 开放给所有 agent（默认，向后兼容）
export function getParticipants(ctx: Ctx, boardId: string): string[] {
  const rows = ctx.holder.db
    .prepare('SELECT agent_id FROM board_participant WHERE board_id = ? ORDER BY agent_id')
    .all(boardId) as { agent_id: string }[];
  return rows.map((r) => r.agent_id);
}

// 全量覆盖式设置参与者；逐个校验 agent 存在（404 拒绝拼错 id）
export function setParticipants(ctx: Ctx, boardId: string, agentIds: string[]): string[] {
  getBoard(ctx, boardId); // 404 if missing
  if (!Array.isArray(agentIds)) throw new HttpError(422, 'agentIds: string[] required');
  const ids = [...new Set(agentIds.map((a) => String(a).trim()).filter(Boolean))];
  for (const id of ids) getAgent(ctx, id); // 404 if missing
  withWrite(ctx, 'board.participantsSet', () => {
    ctx.holder.db.prepare('DELETE FROM board_participant WHERE board_id = ?').run(boardId);
    for (const id of ids) {
      ctx.holder.db
        .prepare('INSERT INTO board_participant (board_id, agent_id) VALUES (?, ?)')
        .run(boardId, id);
    }
    logEvent(ctx, 'board.participants_set', { boardId, agentIds: ids });
  });
  return getParticipants(ctx, boardId);
}

// 参与限制执行点：参与者列表非空时，worker 角色必须在列表内才能领活/认领；
// user（老板）与 orchestrator（主脑）豁免——主脑要能跨板分派，老板全板可见。
export function requireParticipant(ctx: Ctx, boardId: string, actor: Agent): void {
  if (actor.role !== 'worker') return; // 老板与主脑全板可见
  const list = getParticipants(ctx, boardId);
  if (list.length === 0) return; // 空 = 不限制（默认开放）
  if (!list.includes(actor.id)) {
    throw new HttpError(403, 'not a participant of this board');
  }
}

// ---- Task ----

export interface CreateTaskInput {
  id: string;
  title: string;
  detail?: string;
  lane?: Lane;
  priority?: Priority;
  category?: string;
  acceptance?: string;
  workspace?: Record<string, unknown>;
  files?: string[];
  protectedPaths?: string[];
  dependsOn?: string[];
}

export function getTask(ctx: Ctx, id: string): Task {
  const row = ctx.holder.db.prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  return rowToTask(row);
}

function requireTaskRow(ctx: Ctx, id: string): TaskRow {
  const row = ctx.holder.db.prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  return row;
}

export function listTasks(
  ctx: Ctx,
  boardId: string,
  opts: { lane?: Lane; assignee?: string } = {},
): Task[] {
  getBoard(ctx, boardId); // 404 if missing
  const conds = ['board_id = ?'];
  const args: unknown[] = [boardId];
  if (opts.lane) {
    conds.push('lane = ?');
    args.push(opts.lane);
  }
  if (opts.assignee) {
    conds.push('assignee = ?');
    args.push(opts.assignee);
  }
  const rows = ctx.holder.db
    .prepare(`SELECT * FROM task WHERE ${conds.join(' AND ')} ORDER BY priority, created_at`)
    .all(...(args as [])) as TaskRow[];
  return rows.map(rowToTask);
}

function depsDone(ctx: Ctx, dependsOn: string[]): boolean {
  if (dependsOn.length === 0) return true;
  const marks = ctx.holder.db
    .prepare(
      `SELECT id, CASE WHEN lane = 'Done' THEN 1 ELSE 0 END AS done FROM task WHERE id IN (${dependsOn.map(() => '?').join(',')})`,
    )
    .all(...(dependsOn as unknown as [])) as { id: string; done: number }[];
  if (marks.length !== dependsOn.length) return false; // 有依赖不存在（创建时已校验，此为兜底）
  return marks.every((m) => m.done === 1);
}

function wipLimitFor(ctx: Ctx, boardId: string, lane: Lane): number {
  const board = getBoard(ctx, boardId);
  return board.wip[lane] ?? DEFAULT_WIP[lane] ?? Number.POSITIVE_INFINITY;
}

function assertWip(ctx: Ctx, boardId: string, lane: Lane, excludeTaskId: string): void {
  const limit = wipLimitFor(ctx, boardId, lane);
  if (!Number.isFinite(limit)) return;
  const row = ctx.holder.db
    .prepare('SELECT COUNT(*) AS n FROM task WHERE board_id = ? AND lane = ? AND id != ?')
    .get(boardId, lane, excludeTaskId) as { n: number };
  if (row.n >= limit) {
    throw new HttpError(409, `WIP limit reached for ${lane} on board ${boardId} (limit ${limit})`);
  }
}

export function createTask(ctx: Ctx, boardId: string, input: CreateTaskInput): Task {
  guardTaskInput(input as unknown as Record<string, unknown>);
  getBoard(ctx, boardId);
  const id = input.id?.trim() ?? '';
  if (!TASK_ID_RE.test(id)) {
    throw new HttpError(422, `invalid task id (expect T42 / BUG-17 style): ${id}`);
  }
  if (!input.title?.trim()) throw new HttpError(422, 'title required');
  const lane = input.lane ?? 'Backlog';
  if (!LANES.includes(lane)) throw new HttpError(422, `invalid lane: ${lane}`);
  const dependsOn = input.dependsOn ?? [];
  for (const dep of dependsOn) {
    requireTaskRow(ctx, dep); // 404 if missing
  }
  if (lane === 'Ready' && !depsDone(ctx, dependsOn)) {
    throw new HttpError(422, 'cannot create directly in Ready: dependencies not Done');
  }
  if (lane === 'InProgress' || lane === 'Review') {
    assertWip(ctx, boardId, lane, id);
  }
  const now = Date.now();
  try {
    withWrite(ctx, 'task.create', () => {
      ctx.holder.db
        .prepare(
          `INSERT INTO task (id, board_id, title, detail, lane, priority, category, acceptance,
             workspace, files, protected_paths, depends_on, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          boardId,
          input.title.trim(),
          input.detail ?? '',
          lane,
          input.priority ?? 'P1',
          input.category ?? '',
          input.acceptance ?? '',
          JSON.stringify(input.workspace ?? {}),
          JSON.stringify(input.files ?? []),
          JSON.stringify(input.protectedPaths ?? []),
          JSON.stringify(dependsOn),
          now,
          now,
        );
      logEvent(ctx, 'task.created', {
        taskId: id,
        boardId,
        title: input.title.trim(),
        lane,
        dependsOn,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new HttpError(409, `task already exists: ${id}`);
    }
    throw err;
  }
  return getTask(ctx, id);
}

export interface PatchTaskInput {
  title?: string;
  detail?: string;
  lane?: Lane;
  assignee?: string;
  priority?: Priority;
  category?: string;
  acceptance?: string;
  workspace?: Record<string, unknown>;
  files?: string[];
  protectedPaths?: string[];
}

export function updateTask(ctx: Ctx, actor: Agent, id: string, patch: PatchTaskInput): Task {
  guardTaskInput(patch as unknown as Record<string, unknown>);
  const row = requireTaskRow(ctx, id);
  const laneChanges: { from: Lane; to: Lane } | null =
    patch.lane && patch.lane !== row.lane ? { from: row.lane, to: patch.lane } : null;

  if (laneChanges) {
    // 信任分层（§5.2）：Review→Done（及 Done 的任何移出/移入）仅主脑/用户可操作
    if ((laneChanges.to === 'Done' || laneChanges.from === 'Done') && actor.role === 'worker') {
      throw new HttpError(403, 'workers cannot move tasks into or out of Done (trust boundary)');
    }
    if (!LANES.includes(laneChanges.to)) throw new HttpError(422, `invalid lane: ${laneChanges.to}`);
    const dependsOn = JSON.parse(row.depends_on) as string[];
    if (laneChanges.to === 'Ready' && !depsDone(ctx, dependsOn)) {
      throw new HttpError(422, `cannot move to Ready: dependencies not Done (${dependsOn.join(', ')})`);
    }
    if (laneChanges.to === 'InProgress' || laneChanges.to === 'Review') {
      assertWip(ctx, row.board_id, laneChanges.to, id);
    }
  }

  withWrite(ctx, 'task.update', () => {
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    const push = (col: string, val: SQLInputValue) => {
      sets.push(`${col} = ?`);
      args.push(val);
    };
    if (patch.title !== undefined) push('title', patch.title.trim());
    if (patch.detail !== undefined) push('detail', patch.detail);
    if (patch.priority !== undefined) push('priority', patch.priority);
    if (patch.category !== undefined) push('category', patch.category);
    if (patch.acceptance !== undefined) push('acceptance', patch.acceptance);
    if (patch.workspace !== undefined) push('workspace', JSON.stringify(patch.workspace));
    if (patch.files !== undefined) push('files', JSON.stringify(patch.files));
    if (patch.protectedPaths !== undefined) push('protected_paths', JSON.stringify(patch.protectedPaths));
    if (patch.assignee !== undefined) push('assignee', patch.assignee);
    if (laneChanges) {
      push('lane', laneChanges.to);
      push('last_activity_at', Date.now());
    }
    push('updated_at', Date.now());
    ctx.holder.db
      .prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id);
    logEvent(ctx, 'task.updated', {
      taskId: id,
      by: actor.id,
      fields: Object.keys(patch),
    });
    if (laneChanges) {
      logEvent(ctx, 'task.lane_changed', {
        taskId: id,
        from: laneChanges.from,
        to: laneChanges.to,
        by: actor.id,
      });
      if (laneChanges.to === 'Done') unlockDependents(ctx, id);
    }
  });
  return getTask(ctx, id);
}

// 上游进 Done：依赖它的任务若全部依赖已完成，记 autoUnblockedAt（§5.1）
function unlockDependents(ctx: Ctx, doneId: string): void {
  const rows = ctx.holder.db.prepare('SELECT id, depends_on FROM task').all() as {
    id: string;
    depends_on: string;
  }[];
  for (const r of rows) {
    if (r.id === doneId) continue;
    const deps = JSON.parse(r.depends_on) as string[];
    if (!deps.includes(doneId)) continue;
    if (depsDone(ctx, deps)) {
      ctx.holder.db
        .prepare('UPDATE task SET auto_unblocked_at = ?, updated_at = ? WHERE id = ?')
        .run(Date.now(), Date.now(), r.id);
      logEvent(ctx, 'task.auto_unlocked', { taskId: r.id, unlockedBy: doneId });
    }
  }
}

export function addDependencies(ctx: Ctx, actor: Agent, id: string, on: string[]): Task {
  if (!Array.isArray(on) || on.length === 0) throw new HttpError(422, 'on[] required');
  for (const dep of on) requireTaskRow(ctx, dep);
  const row = requireTaskRow(ctx, id);
  const current = JSON.parse(row.depends_on) as string[];
  const merged = [...new Set([...current, ...on])];
  withWrite(ctx, 'task.addDeps', () => {
    ctx.holder.db
      .prepare('UPDATE task SET depends_on = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), Date.now(), id);
    logEvent(ctx, 'task.depends_added', { taskId: id, on, by: actor.id });
    // Ready 任务补了未完成依赖 → 退回 Backlog（Ready 语义 = 已解锁可领）
    if (row.lane === 'Ready' && !depsDone(ctx, merged)) {
      ctx.holder.db
        .prepare("UPDATE task SET lane = 'Backlog', auto_unblocked_at = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
      logEvent(ctx, 'task.lane_changed', { taskId: id, from: 'Ready', to: 'Backlog', by: actor.id });
    }
  });
  return getTask(ctx, id);
}
