import type { Ctx } from './types.ts';
import { HttpError, assertNoMojibake } from './types.ts';
import type { SQLInputValue } from 'node:sqlite';
import { withWrite, logEvent } from './write.ts';
import { messageInner } from './messages.ts';
import { getAgent, type Agent } from './agents.ts';

import { withTaskIntegrationLock } from './task-integration-lock.ts';
export const LANES = ['Backlog', 'Ready', 'InProgress', 'Review', 'Done'] as const;
export type Lane = (typeof LANES)[number];
export type Priority = 'P0' | 'P1' | 'P2';

// WIP 限制默认值（立项计划 §5.2：每泳道 2–3）；board.wip 可按泳道覆盖
export const DEFAULT_WIP: Partial<Record<Lane, number>> = { InProgress: 3, Review: 3 };

export interface Board {
  id: string;
  name: string;
  /** 任意 Git 仓库地址（remote-legacy；managed 模式由服务器 bare repo 作为主仓） */
  repo: string;
  repoMode: 'managed' | 'remote-legacy';
  repoStatus: 'empty' | 'queued' | 'running' | 'ready' | 'failed';
  repoError: string;
  repoHead: string;
  repoSource: string;
  /** 项目描述（可空） */
  description: string;
  wip: Partial<Record<Lane, number>>;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRequirements {
  /** 期望或必需的操作系统，如 'win32' | 'linux' | 'darwin' */
  os?: string;
  /** 期望或必需的架构，如 'x64' | 'arm64' */
  arch?: string;
  /** 最低 CPU 核心数 */
  minCpus?: number;
  /** 最低物理内存（GB） */
  minMemoryGb?: number;
  /** 最大允许动态 CPU 占用率 (0~100) */
  maxCpuPercent?: number;
  /** 必需的模型或系列标识（模糊匹配，如 'gemini' | 'opus' | 'gpt-5'） */
  requiredModel?: string;
  /** 期望执行内核，如 'omp' | 'zcode' */
  executor?: string;
}


export interface TaskProgress {
  lastActivityAt: number | null;
  lastActivityKind: string | null;
  lastProgressAt: number | null;
  workerLastSeenAt: number | null;
  status: 'active' | 'no_recent_activity' | 'offline' | 'unknown' | 'failed';
  errorNote: string | null;
}

export interface Task {
  id: string;
  boardId: string;
  title: string;
  detail: string;
  lane: Lane;
  status: 'active' | 'cancelled';
  assignee: string;
  dependsOn: string[];
  priority: Priority;
  category: string;
  acceptance: string;
  workspace: Record<string, unknown>;
  files: string[];
  reads: string[];
  evidence: { path: string; machine?: string; note?: string }[];
  protectedPaths: string[];
  requirements: TaskRequirements;
  reviewStatus: 'none' | 'pending' | 'reviewing' | 'passed' | 'rework' | 'blocked' | 'failed';
  reviewAttempts: number;
  reviewReworks: number;
  reviewSummary: string;
  submitSummary: string;
  attempt: number;
  claimedAt: number | null;
  lastActivityAt: number | null;
  lastRealActivityAt: number | null;
  lastProgressAt: number | null;
  lastActivityKind: string | null;
  progress: TaskProgress | null;
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
  reads?: string;
  evidence: string;
  protected_paths: string;
  requirements?: string;
  review_status: Task['reviewStatus'];
  review_attempts: number;
  review_reworks: number;
  review_summary: string;
  submit_summary: string;
  attempt?: number;
  claimed_at: number | null;
  last_activity_at: number | null;
  last_real_activity_at?: number | null;
  last_progress_at?: number | null;
  last_activity_kind?: string | null;
  auto_unblocked_at: number | null;
  created_at: number;
  updated_at: number;
  status: Task['status'];
};

export function computeTaskProgress(
  r: Pick<
    TaskRow,
    | 'id'
    | 'attempt'
    | 'lane'
    | 'assignee'
    | 'claimed_at'
    | 'last_activity_at'
    | 'last_real_activity_at'
    | 'last_progress_at'
    | 'last_activity_kind'
    | 'status'
  >,
  ctx?: Ctx,
  now: number = Date.now(),
): TaskProgress | null {
  if (r.status === 'cancelled' || r.lane !== 'InProgress' || !r.assignee || r.assignee === 'unassigned') {
    return null;
  }
  let workerLastSeenAt: number | null = null;
  let workerEnabled = true;
  if (ctx) {
    try {
      const agent = ctx.holder.db
        .prepare('SELECT last_seen_at, enabled FROM agent WHERE id = ? OR handle = ?')
        .get(r.assignee, r.assignee) as { last_seen_at: number | null; enabled: number } | undefined;
      if (agent) {
        workerLastSeenAt = agent.last_seen_at;
        workerEnabled = agent.enabled === 1;
      }
    } catch {
      /* ignore lookup errors */
    }
  }

  // T105: last_activity_at 维持 TTL 租约时钟；last_real_activity_at 独立记录真实模型/工具活动时钟
  const lastRealActivityAt = r.last_real_activity_at ?? null;
  const lastProgressAt = r.last_progress_at ?? null;
  const lastActivityKind = r.last_activity_kind ?? null;

  const OFFLINE_THRESHOLD_MS = 60_000;
  const NO_RECENT_ACTIVITY_THRESHOLD_MS = 180_000;

  let status: TaskProgress['status'];
  let errorNote: string | null = null;

  if (lastActivityKind === 'error' || lastActivityKind === 'timeout') {
    status = 'failed';
    if (ctx && r.id) {
      try {
        const events = ctx.holder.db
          .prepare(
            `SELECT payload, time_created FROM event WHERE type = 'task.checkpoint' AND json_extract(payload, '$.taskId') = ? ORDER BY id DESC LIMIT 10`,
          )
          .all(r.id) as { payload: string; time_created: number }[];
        const currentAttempt = r.attempt ?? 1;
        for (const ev of events) {
          try {
            const p = JSON.parse(ev.payload) as { kind?: string; note?: string; attempt?: number; taskId?: string };
            if (p.kind === lastActivityKind) {
              const checkpointAttempt = p.attempt ?? 1;
              if (checkpointAttempt !== currentAttempt) continue;
              if (r.claimed_at !== null && ev.time_created < r.claimed_at) {
                continue;
              }
              if (typeof p.note === 'string' && p.note.trim()) {
                errorNote = p.note.trim().slice(0, 2000);
                break;
              }
            }
          } catch {
            /* ignore parse errors */
          }
        }
      } catch {
        /* ignore db errors */
      }
    }
  } else if (!workerEnabled || workerLastSeenAt === null || now - workerLastSeenAt > OFFLINE_THRESHOLD_MS) {
    status = 'offline';
  } else if (lastRealActivityAt !== null) {
    if (now - lastRealActivityAt <= NO_RECENT_ACTIVITY_THRESHOLD_MS) {
      status = 'active';
    } else {
      status = 'no_recent_activity';
    }
  } else {
    const claimedAt = r.claimed_at;
    if (claimedAt !== null && now - claimedAt > NO_RECENT_ACTIVITY_THRESHOLD_MS) {
      status = 'no_recent_activity';
    } else {
      status = 'unknown';
    }
  }

  return {
    lastActivityAt: lastRealActivityAt,
    lastActivityKind,
    lastProgressAt,
    workerLastSeenAt,
    status,
    errorNote,
  };
}

export function parseRequirements(raw: string | undefined | null): TaskRequirements {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const req: TaskRequirements = {};
    if (typeof obj.os === 'string') req.os = obj.os.trim().toLowerCase();
    if (typeof obj.arch === 'string') req.arch = obj.arch.trim().toLowerCase();
    if (typeof obj.minCpus === 'number' && Number.isSafeInteger(obj.minCpus) && obj.minCpus > 0) req.minCpus = obj.minCpus;
    if (typeof obj.minMemoryGb === 'number' && obj.minMemoryGb > 0) req.minMemoryGb = obj.minMemoryGb;
    if (typeof obj.maxCpuPercent === 'number' && obj.maxCpuPercent >= 0 && obj.maxCpuPercent <= 100) req.maxCpuPercent = obj.maxCpuPercent;
    if (typeof obj.requiredModel === 'string') req.requiredModel = obj.requiredModel.trim();
    if (typeof obj.executor === 'string') req.executor = obj.executor.trim().toLowerCase();
    return req;
  } catch {
    return {};
  }
}

export function normalizeRequirements(raw: unknown): TaskRequirements {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(422, 'requirements: object required');
  const obj = raw as Record<string, unknown>;
  const req: TaskRequirements = {};
  if (obj.os !== undefined) {
    if (typeof obj.os !== 'string') throw new HttpError(422, 'requirements.os: string required');
    req.os = obj.os.trim().toLowerCase();
  }
  if (obj.arch !== undefined) {
    if (typeof obj.arch !== 'string') throw new HttpError(422, 'requirements.arch: string required');
    req.arch = obj.arch.trim().toLowerCase();
  }
  if (obj.minCpus !== undefined) {
    if (typeof obj.minCpus !== 'number' || !Number.isSafeInteger(obj.minCpus) || obj.minCpus <= 0) {
      throw new HttpError(422, 'requirements.minCpus: positive integer required');
    }
    req.minCpus = obj.minCpus;
  }
  if (obj.minMemoryGb !== undefined) {
    if (typeof obj.minMemoryGb !== 'number' || obj.minMemoryGb <= 0) {
      throw new HttpError(422, 'requirements.minMemoryGb: positive number required');
    }
    req.minMemoryGb = obj.minMemoryGb;
  }
  if (obj.maxCpuPercent !== undefined) {
    if (typeof obj.maxCpuPercent !== 'number' || obj.maxCpuPercent < 0 || obj.maxCpuPercent > 100) {
      throw new HttpError(422, 'requirements.maxCpuPercent: number between 0 and 100 required');
    }
    req.maxCpuPercent = obj.maxCpuPercent;
  }
  if (obj.requiredModel !== undefined) {
    if (typeof obj.requiredModel !== 'string') throw new HttpError(422, 'requirements.requiredModel: string required');
    req.requiredModel = obj.requiredModel.trim();
  }
  if (obj.executor !== undefined) {
    if (typeof obj.executor !== 'string') throw new HttpError(422, 'requirements.executor: string required');
    req.executor = obj.executor.trim().toLowerCase();
  }
  return req;
}

function rowToTask(r: TaskRow, ctx?: Ctx): Task {
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
    reads: JSON.parse(r.reads ?? '[]') as string[],
    evidence: JSON.parse(r.evidence) as Task['evidence'],
    protectedPaths: JSON.parse(r.protected_paths) as string[],
    status: r.status ?? 'active',
    requirements: parseRequirements(r.requirements),
    reviewStatus: r.review_status ?? 'none',
    reviewAttempts: r.review_attempts ?? 0,
    reviewReworks: r.review_reworks ?? 0,
    reviewSummary: r.review_summary ?? '',
    submitSummary: r.submit_summary ?? '',
    attempt: r.attempt ?? 1,
    claimedAt: r.claimed_at,
    lastActivityAt: r.last_activity_at,
    lastRealActivityAt: r.last_real_activity_at ?? null,
    lastProgressAt: r.last_progress_at ?? null,
    lastActivityKind: r.last_activity_kind ?? null,
    progress: computeTaskProgress(r, ctx),
    autoUnblockedAt: r.auto_unblocked_at ?? null,
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
  repo_mode: Board['repoMode'];
  repo_status: Board['repoStatus'];
  repo_error: string;
  repo_head: string;
  repo_source: string;
  created_at: number;
  updated_at: number;
};

function rowToBoard(r: BoardRow): Board {
  return {
    id: r.id,
    name: r.name,
    repo: r.repo,
    repoMode: r.repo_mode,
    repoStatus: r.repo_status,
    repoError: r.repo_error,
    repoHead: r.repo_head,
    repoSource: r.repo_source,
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
  repoMode?: Board['repoMode'];
  repoStatus?: Board['repoStatus'];
  repoSource?: string;
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
          'INSERT INTO board (id, name, repo, description, wip, repo_mode, repo_status, repo_error, repo_head, repo_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          input.name,
          input.repo ?? '',
          input.description ?? '',
          JSON.stringify(input.wip ?? {}),
          input.repoMode ?? 'remote-legacy',
          input.repoStatus ?? 'ready',
          '',
          '',
          input.repoSource ?? '',
          now,
          now,
        );
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

/** 服务器 RepoManager 写初始化/迁移状态；路径和 git 执行均不交给客户端。 */
export function setBoardRepoState(
  ctx: Ctx,
  boardId: string,
  input: { status: Board['repoStatus']; error?: string; head?: string; source?: string },
): Board {
  getBoard(ctx, boardId);
  if (!['empty', 'queued', 'running', 'ready', 'failed'].includes(input.status)) {
    throw new HttpError(422, `invalid repo status: ${input.status}`);
  }
  withWrite(ctx, 'board.repo_state', () => {
    ctx.holder.db.prepare(
      'UPDATE board SET repo_status = ?, repo_error = ?, repo_head = ?, repo_source = COALESCE(?, repo_source), updated_at = ? WHERE id = ?',
    ).run(input.status, input.error ?? '', input.head ?? '', input.source ?? null, Date.now(), boardId);
    logEvent(ctx, 'board.repo_state', { boardId, status: input.status, head: input.head ?? '' });
  });
  return getBoard(ctx, boardId);
}

export interface PatchBoardInput {
  name?: string;
  repo?: string;
  description?: string;
  repoMode?: Board['repoMode'];
  repoStatus?: Board['repoStatus'];
}

// 看板管理（"看板=项目管理"）：改项目名称 / GitHub 仓库地址 / 描述 / 仓库模式；部分更新，只落传入字段
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
    if (patch.repoMode !== undefined) push('repo_mode', patch.repoMode);
    if (patch.repoStatus !== undefined) push('repo_status', patch.repoStatus);
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
  assignee?: string;
  priority?: Priority;
  category?: string;
  acceptance?: string;
  workspace?: Record<string, unknown>;
  files?: string[];
  reads?: string[];
  protectedPaths?: string[];
  requirements?: TaskRequirements;
  dependsOn?: string[];
}

export function getTask(ctx: Ctx, id: string): Task {
  const row = ctx.holder.db.prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  return rowToTask(row, ctx);
}

function requireTaskRow(ctx: Ctx, id: string): TaskRow {
  const row = ctx.holder.db.prepare('SELECT * FROM task WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) throw new HttpError(404, `task not found: ${id}`);
  return row;
}

export function listTasks(
  ctx: Ctx,
  boardId: string,
  opts: { lane?: Lane; assignee?: string; reviewStatus?: string; includeCancelled?: boolean } = {},
): Task[] {
  getBoard(ctx, boardId); // 404 if missing
  const conds = ['board_id = ?'];
  const args: unknown[] = [boardId];
  if (!opts.includeCancelled) conds.push("status = 'active'");
  if (opts.lane) {
    conds.push('lane = ?');
    args.push(opts.lane);
  }
  if (opts.assignee) {
    conds.push('assignee = ?');
    args.push(opts.assignee);
  }
  if (opts.reviewStatus) {
    conds.push('review_status = ?');
    args.push(opts.reviewStatus);
  }
  const rows = ctx.holder.db
    .prepare(`SELECT * FROM task WHERE ${conds.join(' AND ')} ORDER BY priority, created_at`)
    .all(...(args as [])) as TaskRow[];
  return rows.map((r) => rowToTask(r, ctx));
}

function depsDone(ctx: Ctx, dependsOn: string[]): boolean {
  if (dependsOn.length === 0) return true;
  const marks = ctx.holder.db
    .prepare(
      `SELECT id, CASE WHEN status='active' AND lane = 'Done' THEN 1 ELSE 0 END AS done FROM task WHERE id IN (${dependsOn.map(() => '?').join(',')})`,
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
    .prepare("SELECT COUNT(*) AS n FROM task WHERE board_id = ? AND status='active' AND lane = ? AND id != ?")
    .get(boardId, lane, excludeTaskId) as { n: number };
  if (row.n >= limit) {
    throw new HttpError(409, `WIP limit reached for ${lane} on board ${boardId} (limit ${limit})`);
  }
}

export function createTask(ctx: Ctx, boardId: string, input: CreateTaskInput): Task {
  guardTaskInput(input as unknown as Record<string, unknown>);
  const board = getBoard(ctx, boardId);
  const id = input.id?.trim() ?? '';
  if (!TASK_ID_RE.test(id)) {
    throw new HttpError(422, `invalid task id (expect T42 / BUG-17 style): ${id}`);
  }
  if (!input.title?.trim()) throw new HttpError(422, 'title required');
  const lane = input.lane ?? 'Backlog';
  if (!LANES.includes(lane)) throw new HttpError(422, `invalid lane: ${lane}`);
  if (lane === 'Done' && board.repoMode === 'managed') {
    throw new HttpError(409, '托管任务不能直接创建为 Done；须提交并完成验收');
  }
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
  const requirements = normalizeRequirements(input.requirements);
  const now = Date.now();
  try {
    withWrite(ctx, 'task.create', () => {
      ctx.holder.db
        .prepare(
          `INSERT INTO task (id, board_id, title, detail, lane, priority, category, acceptance,
             workspace, files, reads, protected_paths, requirements, depends_on, assignee, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(input.reads ?? []),
          JSON.stringify(input.protectedPaths ?? []),
          requirements ? JSON.stringify(requirements) : null,
          JSON.stringify(dependsOn),
          input.assignee?.trim() || 'unassigned',
          now,
          now,
        );
      logEvent(ctx, 'task.created', {
        taskId: id,
        boardId,
        title: input.title.trim(),
        lane,
        dependsOn,
        requirements,
        reads: input.reads ?? [],
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
  reads?: string[];
  protectedPaths?: string[];
  requirements?: TaskRequirements;
}

export function updateTask(ctx: Ctx, actor: Agent, id: string, patch: PatchTaskInput, options?: { integratedManagedCode?: boolean; manualAcceptance?: boolean }): Task {
  guardTaskInput(patch as unknown as Record<string, unknown>);
  const row = requireTaskRow(ctx, id);
  if (row.status === 'cancelled') throw new HttpError(409, `task ${id} is cancelled`);
  const laneChanges: { from: Lane; to: Lane } | null =
    patch.lane && patch.lane !== row.lane ? { from: row.lane, to: patch.lane } : null;
  // 1. 运行中任务 (InProgress) 保护：严禁通用 PATCH 挪动泳道或篡改指派人
  // 必须通过受控专用接口（submitTask、release-task 物理确认门禁、cancelTask）进行生命周期流转
  if (row.lane === 'InProgress') {
    if (laneChanges) {
      throw new HttpError(
        403,
        'cannot move task out of InProgress via generic update; use submit, release-task with confirmedStopped, or cancel',
      );
    }
    if (patch.assignee !== undefined && patch.assignee !== row.assignee) {
      throw new HttpError(
        403,
        'cannot change assignee of InProgress task via generic update; release task with confirmedStopped first',
      );
    }
  }

  // 2. 审核中任务 (Review) 保护：严禁通用 PATCH 挪回 InProgress
  // 退回重做必须独占经由具备锁与代次自增的专用 review-return / review-reject API
  if (row.lane === 'Review' && laneChanges?.to === 'InProgress') {
    throw new HttpError(
      403,
      'Review tasks cannot be moved to InProgress via generic update; use /tasks/:id/review/return or review/reject',
    );
  }

  if (laneChanges) {
    if (laneChanges.to === 'Done' && getBoard(ctx, row.board_id).repoMode === 'managed') {
      if (row.lane !== 'Review') throw new HttpError(409, '托管任务须从 Review 完成验收');
      if (!options?.manualAcceptance && !options?.integratedManagedCode) {
        throw new HttpError(409, '托管任务须经受控验收或代码合并；请使用人工验收接口');
      }
    }
    // 启用独立审核时，失败或熔断的审核任务不能经普通 lane patch 绕过审核。
    if (actor.role === 'orchestrator' && laneChanges.to === 'Done' && ['failed', 'blocked'].includes(row.review_status)) {
      throw new HttpError(403, 'failed/blocked reviewer tasks require explicit user arbitration');
    }
    if (row.lane === 'Review' && laneChanges.to !== 'Review' && actor.role === 'orchestrator') {
      const settingsRow = ctx.holder.db.prepare("SELECT value FROM settings WHERE key='orchestrator'").get() as { value?: string } | undefined;
      let reviewerEnabled = false;
      try {
        reviewerEnabled = JSON.parse(settingsRow?.value ?? '{}').reviewerEnabled === true && getBoard(ctx, row.board_id).repoMode === 'managed';
      } catch { /* Invalid settings retain manual review behavior. */ }
      if (reviewerEnabled && row.review_status !== 'none' && laneChanges.to !== 'InProgress') {
        throw new HttpError(403, 'reviewer workflow owns Review task transitions');
      }
    }
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
    if (patch.reads !== undefined) push('reads', JSON.stringify(patch.reads));
    if (patch.protectedPaths !== undefined) push('protected_paths', JSON.stringify(patch.protectedPaths));
    if (patch.requirements !== undefined) push('requirements', JSON.stringify(normalizeRequirements(patch.requirements)));
    if (patch.assignee !== undefined) push('assignee', patch.assignee);
    if (laneChanges) {
      push('lane', laneChanges.to);
      push('last_activity_at', Date.now());
    }
    if (options?.manualAcceptance) {
      push('review_status', 'none');
      push('review_summary', '用户人工验收通过');
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
    if (options?.manualAcceptance) logEvent(ctx, 'task.manual_accepted', { taskId: id, by: actor.id });
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

export async function returnTaskFromReview(
  ctx: Ctx,
  actor: Agent,
  id: string,
  input?: { reason?: string; assignee?: string } | string,
): Promise<Task> {
  if (actor.role !== 'orchestrator' && actor.role !== 'user') {
    throw new HttpError(403, 'only user or orchestrator may return review tasks');
  }
  const cleanReason = (typeof input === 'string' ? input : input?.reason)?.trim() || '审核退回重做';
  const targetAssigneeInput = (typeof input === 'object' && input !== null ? input.assignee : undefined)?.trim();

  return withTaskIntegrationLock(id, async () => {
    const task = getTask(ctx, id);
    if (task.status === 'cancelled') throw new HttpError(409, `task ${id} is cancelled`);
    if (task.lane !== 'Review') throw new HttpError(409, `task ${id} not in Review (lane: ${task.lane})`);

    let targetAssignee = task.assignee;
    if (targetAssigneeInput) {
      const agent = getAgent(ctx, targetAssigneeInput);
      requireParticipant(ctx, task.boardId, agent);
      targetAssignee = agent.id;
    } else if (targetAssignee === 'unassigned') {
      throw new HttpError(422, 'designated worker assignee required when task is unassigned');
    }

    assertWip(ctx, task.boardId, 'InProgress', id);

    return withWrite(ctx, 'task.reviewReturn', () => {
      const now = Date.now();
      const nextReworks = (task.reviewReworks ?? 0) + 1;
      const res = ctx.holder.db
        .prepare(
          `UPDATE task
           SET lane = 'InProgress',
               review_status = 'rework',
               review_reworks = ?,
               review_summary = ?,
               assignee = ?,
               attempt = attempt + 1,
               last_activity_at = ?,
               last_real_activity_at = ?,
               last_activity_kind = 'rework',
               last_progress_at = ?,
               updated_at = ?
           WHERE id = ? AND lane = 'Review' AND status = 'active'`,
        )
        .run(nextReworks, cleanReason, targetAssignee, now, now, now, now, id);

      if (Number(res.changes) !== 1) {
        throw new HttpError(409, `task ${id} state changed concurrently`);
      }

      logEvent(ctx, 'task.review_returned', {
        taskId: id,
        boardId: task.boardId,
        by: actor.id,
        assignee: targetAssignee,
        reason: cleanReason,
        reworks: nextReworks,
      });
      logEvent(ctx, 'task.lane_changed', { taskId: id, from: 'Review', to: 'InProgress', by: actor.id });
      messageInner(ctx, {
        boardId: task.boardId,
        author: actor.id,
        kind: 'intervention',
        content: `@${targetAssignee} ${id} 已退回重做：\n\n${cleanReason}`,
      });
      return getTask(ctx, id);
    });
  });
}

export async function cancelTask(ctx: Ctx, actor: Agent, id: string, reason: string): Promise<Task> {
  if (actor.role !== 'user' && actor.role !== 'orchestrator') {
    throw new HttpError(403, 'only user or orchestrator may cancel tasks');
  }
  const note = reason.trim().slice(0, 2000);
  if (!note) throw new HttpError(422, 'cancellation reason required');
  return withTaskIntegrationLock(id, async () => {
    const task = getTask(ctx, id);
    if (task.status === 'cancelled') return task;
    return withWrite(ctx, 'task.cancel', () => {
      ctx.holder.db.prepare("UPDATE task SET status='cancelled', updated_at=? WHERE id=? AND status='active'")
        .run(Date.now(), id);
      logEvent(ctx, 'task.cancelled', { taskId: id, boardId: task.boardId, by: actor.id, reason: note });
      return getTask(ctx, id);
    });
  });
}
export async function finalizeTaskReview(
  ctx: Ctx,
  actor: Agent,
  id: string,
  result: { verdict: 'pass' | 'reject'; summary: string },
  opts: { maxReworks?: number; integrated?: boolean } = {},
): Promise<Task> {
  if (actor.role !== 'orchestrator' && actor.role !== 'user') {
    throw new HttpError(403, 'only orchestrator/user may finalize task review');
  }
  const task = getTask(ctx, id);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${id} is cancelled`);
  if (task.lane !== 'Review' || task.reviewStatus !== 'reviewing') {
    throw new HttpError(409, `task ${id} is not being reviewed`);
  }
  const maxReworks = opts.maxReworks ?? 2;
  if (result.verdict === 'pass' && !opts.integrated) {
    throw new HttpError(409, 'task branch must be integrated before reviewer pass is finalized');
  }
  const summary = result.summary.trim().slice(0, 6000);
  if (!summary) throw new HttpError(422, 'review summary required');

  return withTaskIntegrationLock(id, async () => {
    const current = getTask(ctx, id);
    if (current.status === 'cancelled') throw new HttpError(409, `task ${id} is cancelled`);
    if (current.lane !== 'Review' || current.reviewStatus !== 'reviewing') {
      throw new HttpError(409, `task ${id} is not being reviewed`);
    }
    return withWrite(ctx, 'task.reviewFinalize', () => {
      const now = Date.now();
      const user = ctx.holder.db.prepare("SELECT handle FROM agent WHERE id='user'").get() as { handle?: string } | undefined;
      const userHandle = user?.handle || '用户';
      if (result.verdict === 'pass') {
        const res = ctx.holder.db
          .prepare(
            "UPDATE task SET lane='Done', review_status='passed', review_summary=?, last_activity_at=?, updated_at=? WHERE id=? AND lane='Review' AND status='active'",
          )
          .run(summary, now, now, id);
        if (Number(res.changes) !== 1) throw new HttpError(409, `task ${id} state changed concurrently`);
        logEvent(ctx, 'task.review_passed', { taskId: id, boardId: current.boardId, summary });
        logEvent(ctx, 'task.lane_changed', { taskId: id, from: 'Review', to: 'Done', by: actor.id });
        messageInner(ctx, {
          boardId: current.boardId,
          author: actor.id,
          kind: 'report',
          content: `@${userHandle} ${id} 独立审核通过，变更已合并并移入 Done。\n\n${summary}`,
        });
        unlockDependents(ctx, id);
      } else if (current.reviewReworks < maxReworks) {
        const nextReworks = current.reviewReworks + 1;
        const res = ctx.holder.db
          .prepare(
            `UPDATE task
             SET lane='InProgress',
                 review_status='rework',
                 review_reworks=?,
                 review_summary=?,
                 attempt=attempt + 1,
                 last_activity_at=?,
                 last_real_activity_at=?,
                 last_activity_kind='rework',
                 last_progress_at=?,
                 updated_at=?
             WHERE id=? AND lane='Review' AND status='active'`,
          )
          .run(nextReworks, summary, now, now, now, now, id);
        if (Number(res.changes) !== 1) throw new HttpError(409, `task ${id} state changed concurrently`);
        logEvent(ctx, 'task.review_rejected', { taskId: id, boardId: current.boardId, reworks: nextReworks, summary });
        messageInner(ctx, {
          boardId: current.boardId,
          author: actor.id,
          kind: 'intervention',
          content: `@${current.assignee} @老板 ${id} 独立审核未通过（重做 ${nextReworks}/${maxReworks}）。请按以下问题修正后重新提交：\n\n${summary}`,
        });
        logEvent(ctx, 'task.lane_changed', { taskId: id, from: 'Review', to: 'InProgress', by: actor.id });
      } else {
        const res = ctx.holder.db
          .prepare(
            "UPDATE task SET review_status='blocked', review_summary=?, last_activity_at=?, updated_at=? WHERE id=? AND lane='Review' AND status='active'",
          )
          .run(summary, now, now, id);
        if (Number(res.changes) !== 1) throw new HttpError(409, `task ${id} state changed concurrently`);
        logEvent(ctx, 'task.review_blocked', { taskId: id, boardId: current.boardId, reworks: current.reviewReworks, summary });
        messageInner(ctx, {
          boardId: current.boardId,
          author: actor.id,
          kind: 'system',
          content: `⚠ ${id} 独立审核连续未通过，已达到 ${maxReworks} 次重做上限并挂起，请 @${userHandle} 人工仲裁。\n\n${summary}`,
        });
      }
      return getTask(ctx, id);
    });
  });
}


export function recoverReviewerClaims(ctx: Ctx): number {
  const rows = ctx.holder.db.prepare("SELECT id, board_id FROM task WHERE status='active' AND lane='Review' AND review_status='reviewing'").all() as { id: string; board_id: string }[];
  if (rows.length === 0) return 0;
  return withWrite(ctx, 'task.reviewRecover', () => {
    for (const row of rows) {
      ctx.holder.db.prepare("UPDATE task SET review_status='pending', updated_at=? WHERE id=? AND review_status='reviewing'")
        .run(Date.now(), row.id);
      logEvent(ctx, 'task.review_queued', { taskId: row.id, boardId: row.board_id, recovered: true });
    }
    return rows.length;
  });
}

export function retryTaskReview(ctx: Ctx, actor: Agent, taskId: string): Task {
  if (actor.role !== 'orchestrator' && actor.role !== 'user') throw new HttpError(403, 'only orchestrator/user may retry a review');
  const task = getTask(ctx, taskId);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
  if (task.lane !== 'Review' || task.reviewStatus !== 'failed') throw new HttpError(409, 'only failed Review tasks can be retried');
  const repoMode = getBoard(ctx, task.boardId).repoMode;
  const settingsRow = ctx.holder.db.prepare("SELECT value FROM settings WHERE key='orchestrator'").get() as { value?: string } | undefined;
  let enabled = false;
  try { enabled = JSON.parse(settingsRow?.value ?? '{}').reviewerEnabled === true && repoMode === 'managed'; } catch { /* ignore malformed setting */ }
  if (!enabled) throw new HttpError(409, 'independent reviewer is not enabled for this managed board');
  return withWrite(ctx, 'task.reviewRetry', () => {
    ctx.holder.db.prepare("UPDATE task SET review_status='pending', review_summary='', updated_at=? WHERE id=?")
      .run(Date.now(), taskId);
    logEvent(ctx, 'task.review_queued', { taskId, boardId: task.boardId, retry: true });
    return getTask(ctx, taskId);
  });
}

export function claimTaskForReview(ctx: Ctx, taskId: string): Task | null {
  const task = getTask(ctx, taskId);
  if (task.status === 'cancelled') return null;
  if (task.lane !== 'Review' || task.reviewStatus !== 'pending') return null;
  return withWrite(ctx, 'task.reviewStart', () => {
    const now = Date.now();
    const res = ctx.holder.db.prepare("UPDATE task SET review_status='reviewing', review_attempts=review_attempts+1, updated_at=? WHERE id=? AND lane='Review' AND review_status IN ('pending','failed')")
      .run(now, taskId);
    if (Number(res.changes) !== 1) return null;
    logEvent(ctx, 'task.review_started', { taskId, boardId: task.boardId, attempt: task.reviewAttempts + 1 });
    return getTask(ctx, taskId);
  });
}

export function failTaskReview(ctx: Ctx, taskId: string, summary: string): void {
  const task = getTask(ctx, taskId);
  if (task.status === 'cancelled' || task.lane !== 'Review' || task.reviewStatus !== 'reviewing') return;
  const message = summary.trim().slice(0, 2000) || 'Reviewer 运行失败，未产生有效裁决。';
  withWrite(ctx, 'task.reviewFailed', () => {
    ctx.holder.db.prepare("UPDATE task SET review_status='failed', review_summary=?, updated_at=? WHERE id=?")
      .run(message, Date.now(), taskId);
    logEvent(ctx, 'task.review_failed', { taskId, boardId: task.boardId, summary: message });
    messageInner(ctx, {
      boardId: task.boardId,
      author: 'asterhive-brain',
      kind: 'system',
      content: `⚠ ${taskId} 的独立审核未能完成，任务仍停留在 Review，未自动通过。\n\n失败详情：${message}\n\n请依据详情排查：task ref 不存在时确认工蜂已成功上传 repo-result bundle；审核模型调用失败时检查 reviewer 模型组配置。修复原因后可重试审核。`,
    });
  });
}

// 上游进 Done：依赖它的任务若全部依赖已完成，记 autoUnblockedAt（§5.1）
function unlockDependents(ctx: Ctx, doneId: string): void {
  const rows = ctx.holder.db.prepare("SELECT id, lane, status, depends_on FROM task WHERE status = 'active'").all() as {
    id: string;
    lane: Lane;
    status: string;
    depends_on: string;
  }[];
  const now = Date.now();
  for (const r of rows) {
    if (r.id === doneId) continue;
    let deps: string[];
    try {
      deps = JSON.parse(r.depends_on) as string[];
    } catch {
      continue;
    }
    if (!deps.includes(doneId)) continue;
    if (depsDone(ctx, deps)) {
      if (r.lane === 'Backlog' && r.status === 'active') {
        const res = ctx.holder.db
          .prepare("UPDATE task SET lane = 'Ready', auto_unblocked_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND lane = 'Backlog'")
          .run(now, now, r.id);
        if (Number(res.changes) === 1) {
          logEvent(ctx, 'task.lane_changed', { taskId: r.id, from: 'Backlog', to: 'Ready', by: 'system' });
          logEvent(ctx, 'task.auto_unlocked', { taskId: r.id, unlockedBy: doneId });
        }
      } else if (r.status === 'active') {
        ctx.holder.db
          .prepare("UPDATE task SET auto_unblocked_at = COALESCE(auto_unblocked_at, ?), updated_at = ? WHERE id = ? AND status = 'active'")
          .run(now, now, r.id);
        logEvent(ctx, 'task.auto_unlocked', { taskId: r.id, unlockedBy: doneId });
      }
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
