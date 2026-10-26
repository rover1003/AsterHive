import type { Ctx } from './types.ts';
import { listAgents, type Agent, type AgentSpecs } from './agents.ts';
import { LANES, DEFAULT_WIP, type Lane } from './tasks.ts';

// fleet 视图数据源（§4 Agent 总览页 / §7 GET /overview）：
// 纯聚合端点，agent 无需为此额外上报任何数据——claim 推占用、checkpoint 推进度、heartbeat 推在线。
export interface AgentOverview {
  id: string;
  name: string;
  handle: string;
  host: string;
  role: string;
  enabled: boolean;
  lastSeenAt: number | null;
  status: 'working' | 'idle' | 'stale' | 'disabled';
  specs?: AgentSpecs;
  models?: string[];
  currentTask: {
    id: string;
    title: string;
    boardId: string;
    claimedAt: number;
    elapsedMs: number;
    lastCheckpoint: { note: string; time: number } | null;
  } | null;
  doneCount: number;
}

export interface Overview {
  agents: AgentOverview[];
  aggregates: {
    working: number;
    idle: number;
    stale: number;
    disabled: number;
    lanes: Record<string, { count: number; limit: number | null }>;
  };
  generatedAt: number;
}

interface CheckpointEvent {
  payload: { by?: string; note?: string; taskId?: string };
  time_created: number;
}

function latestCheckpoints(ctx: Ctx): Map<string, { note: string; time: number }> {
  const rows = ctx.holder.db
    .prepare("SELECT payload, time_created FROM event WHERE type = 'task.checkpoint' ORDER BY id DESC LIMIT 200")
    .all() as unknown as { payload: string; time_created: number }[];
  const map = new Map<string, { note: string; time: number }>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as CheckpointEvent['payload'];
    if (p.by && !map.has(p.by)) {
      map.set(p.by, { note: p.note ?? '', time: r.time_created });
    }
  }
  return map;
}

export function getOverview(ctx: Ctx): Overview {
  // 用户（id='user'）不是 agent：fleet 总览只看真正的执行者/主脑，过滤用户身份
  const agents = listAgents(ctx).filter((a) => a.id !== 'user');
  const checkpoints = latestCheckpoints(ctx);
  const now = Date.now();
  const ttlMs = ctx.cfg.ttlMinutes * 60_000;

  const laneCounts: Record<string, number> = {};
  for (const lane of LANES) laneCounts[lane] = 0;
  const doneByAssignee = new Map<string, number>();
  const currentByAssignee = new Map<string, AgentOverview['currentTask']>();

  const taskRows = ctx.holder.db
    .prepare('SELECT id, board_id, title, lane, assignee, claimed_at FROM task')
    .all() as { id: string; board_id: string; title: string; lane: Lane; assignee: string; claimed_at: number | null }[];
  for (const t of taskRows) {
    laneCounts[t.lane] = (laneCounts[t.lane] ?? 0) + 1;
    if (t.lane === 'Done' && t.assignee !== 'unassigned') {
      doneByAssignee.set(t.assignee, (doneByAssignee.get(t.assignee) ?? 0) + 1);
    }
    if (t.lane === 'InProgress' && t.assignee !== 'unassigned') {
      currentByAssignee.set(t.assignee, {
        id: t.id,
        title: t.title,
        boardId: t.board_id,
        claimedAt: t.claimed_at ?? now,
        elapsedMs: now - (t.claimed_at ?? now),
        lastCheckpoint: checkpoints.get(t.assignee) ?? null,
      });
    }
  }

  const out: AgentOverview[] = agents.map((a: Agent) => {
    let status: AgentOverview['status'];
    if (!a.enabled) status = 'disabled';
    else if (currentByAssignee.has(a.id)) status = 'working';
    else if (a.lastSeenAt === null || now - a.lastSeenAt > ttlMs) status = 'stale';
    else status = 'idle';
    return {
      id: a.id,
      name: a.name,
      handle: a.handle,
      host: a.host,
      role: a.role,
      enabled: a.enabled,
      lastSeenAt: a.lastSeenAt,
      status,
      specs: a.specs,
      models: a.models,
      currentTask: currentByAssignee.get(a.id) ?? null,
      doneCount: doneByAssignee.get(a.id) ?? 0,
    };
  });

  const lanes: Record<string, { count: number; limit: number | null }> = {};
  for (const lane of LANES) {
    lanes[lane] = {
      count: laneCounts[lane] ?? 0,
      limit: lane === 'InProgress' || lane === 'Review' ? (DEFAULT_WIP[lane] ?? null) : null,
    };
  }

  return {
    agents: out,
    aggregates: {
      working: out.filter((a) => a.status === 'working').length,
      idle: out.filter((a) => a.status === 'idle').length,
      stale: out.filter((a) => a.status === 'stale').length,
      disabled: out.filter((a) => a.status === 'disabled').length,
      lanes,
    },
    generatedAt: now,
  };
}
