import type { Ctx } from './types.ts';
import { listAgents, type Agent } from './agents.ts';
import { getOverview, type AgentOverview } from './overview.ts';
import { listTasks, type Task } from './tasks.ts';

export interface StagnationAlert {
  taskId: string;
  taskTitle: string;
  boardId: string;
  agentId: string;
  agentHandle: string;
  elapsedMinutes: number;
  idleCheckpointMinutes: number;
  severity: 'warning' | 'critical';
  recommendation: string;
}

export interface InterventionAuditRecord {
  id: number;
  type: string;
  agentId: string;
  handle: string;
  actorId?: string;
  message: string;
  ok: boolean;
  timestamp: number;
}

export interface FleetRadarReport {
  timestamp: number;
  summary: {
    totalWorkers: number;
    onlineWorkers: number;
    staleWorkers: number;
    workingWorkers: number;
    totalCpus: number;
    totalMemoryGb: number;
    executors: Record<string, number>;
    uniqueModels: string[];
  };
  alerts: StagnationAlert[];
  recentInterventions: InterventionAuditRecord[];
}

/**
 * 舰队体检雷达（Phase 9）：
 * 1. 资源水位：物理核心、内存池、执行内核分布、可用模型去重聚合；
 * 2. 停滞预警：自动检测执行超时且长时间无 checkpoint 进度的僵死任务；
 * 3. 干预流水：提取最近受控重启、探活与强制解绑事件，供蜂后与用户全局监控。
 */
export function getFleetRadar(ctx: Ctx): FleetRadarReport {
  const now = Date.now();
  const allAgents = listAgents(ctx);
  const workers = allAgents.filter((a) => a.role === 'worker');
  const overview = getOverview(ctx);

  const overviewMap = new Map<string, AgentOverview>();
  for (const a of overview.agents) overviewMap.set(a.id, a);

  // 1. 资源水位聚合
  let totalCpus = 0;
  let totalMemoryGb = 0;
  const executorCounts: Record<string, number> = {};
  const modelSet = new Set<string>();

  let onlineCount = 0;
  let staleCount = 0;
  let workingCount = 0;

  for (const w of workers) {
    const ov = overviewMap.get(w.id);
    const status = ov?.status ?? 'stale';

    if (status === 'working') {
      workingCount++;
      onlineCount++;
    } else if (status === 'idle') {
      onlineCount++;
    } else if (status === 'stale') {
      staleCount++;
    }

    if (w.specs) {
      if (typeof w.specs.cpus === 'number') totalCpus += w.specs.cpus;
      if (typeof w.specs.memoryTotalGb === 'number') totalMemoryGb += w.specs.memoryTotalGb;
      if (w.specs.executor) {
        executorCounts[w.specs.executor] = (executorCounts[w.specs.executor] ?? 0) + 1;
      }
    }

    if (Array.isArray(w.models)) {
      for (const m of w.models) modelSet.add(m);
    }
    if (w.preferredModel) modelSet.add(w.preferredModel);
  }

  // 2. 停滞预警（Stagnation Alerts）
  // 阈值：任务进行超过 15 分钟，且自最近一次 checkpoint 以来无进展超过 10 分钟
  const alerts: StagnationAlert[] = [];
  const activeTasks = ctx.holder.db
    .prepare("SELECT * FROM task WHERE lane = 'InProgress' AND assignee != 'unassigned'")
    .all() as {
      id: string;
      title: string;
      board_id: string;
      assignee: string;
      claimed_at: number | null;
      last_activity_at: number | null;
    }[];

  for (const t of activeTasks) {
    const claimedAt = t.claimed_at ?? now;
    const elapsedMins = Math.max(0, Math.round((now - claimedAt) / 60000));
    const lastActive = t.last_activity_at ?? claimedAt;
    const idleMins = Math.max(0, Math.round((now - lastActive) / 60000));

    const worker = workers.find((w) => w.id === t.assignee);
    const handle = worker?.handle ?? t.assignee;

    if (elapsedMins >= 15 && idleMins >= 10) {
      const isCritical = elapsedMins >= 30 || idleMins >= 20;
      alerts.push({
        taskId: t.id,
        taskTitle: t.title,
        boardId: t.board_id,
        agentId: t.assignee,
        agentHandle: handle,
        elapsedMinutes: elapsedMins,
        idleCheckpointMinutes: idleMins,
        severity: isCritical ? 'critical' : 'warning',
        recommendation: isCritical
          ? `任务已执行 ${elapsedMins} 分钟且已 ${idleMins} 分钟无进展；建议调用 asterhive_worker_probe 探活，必要时调用 asterhive_worker_restart 或解绑重排`
          : `任务执行耗时较长（${elapsedMins} 分钟）；建议调用 asterhive_worker_probe 检查其执行日志与通道`,
      });
    }
  }

  // 3. 最近受控干预记录
  const interventionRows = ctx.holder.db
    .prepare(
      `SELECT id, type, payload, time_created FROM event
       WHERE type IN ('worker.restart_requested', 'worker.probed', 'task.force_released')
       ORDER BY id DESC LIMIT 10`,
    )
    .all() as { id: number; type: string; payload: string; time_created: number }[];

  const recentInterventions: InterventionAuditRecord[] = interventionRows.map((r) => {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(r.payload);
    } catch {}

    const agentId = String(p.agentId ?? '');
    const handle = String(p.handle ?? agentId);
    const actorId = p.actorId ? String(p.actorId) : (p.by ? String(p.by) : undefined);
    let message = '';
    let ok = true;

    if (r.type === 'worker.restart_requested') {
      ok = Boolean(p.ok !== false);
      message = `受控重启工蜂 ${handle}：${String(p.reason ?? '')} (${String(p.message ?? '')})`;
    } else if (r.type === 'worker.probed') {
      message = `探活诊断工蜂 ${handle}：${String(p.diagnosticSummary ?? p.status ?? '')}`;
    } else if (r.type === 'task.force_released') {
      message = `强制解绑挂死任务 ${String(p.taskId ?? '')}（原工蜂 ${handle}）：${String(p.reason ?? '')}`;
    }

    return {
      id: r.id,
      type: r.type,
      agentId,
      handle,
      actorId,
      message,
      ok,
      timestamp: r.time_created,
    };
  });

  return {
    timestamp: now,
    summary: {
      totalWorkers: workers.length,
      onlineWorkers: onlineCount,
      staleWorkers: staleCount,
      workingWorkers: workingCount,
      totalCpus,
      totalMemoryGb: Math.round(totalMemoryGb * 10) / 10,
      executors: executorCounts,
      uniqueModels: [...modelSet].sort(),
    },
    alerts,
    recentInterventions,
  };
}
