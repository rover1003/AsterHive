import type { Ctx } from './types.ts';
import { getTask, getParticipants, type TaskRequirements } from './tasks.ts';
import { listAgents, isTelemetryFresh, type Agent } from './agents.ts';
import { getOverview, type AgentOverview } from './overview.ts';
export interface MatchCandidate {
  agentId: string;
  handle: string;
  name: string;
  host: string;
  score: number;
  reasons: string[];
  status: 'idle' | 'working' | 'stale';
  specs?: Agent['specs'];
  telemetry?: Agent['telemetry'];
  preferredModel?: string | null;
}

export interface IneligibleCandidate {
  agentId: string;
  handle: string;
  name: string;
  reasons: string[];
}

export interface TaskMatchResult {
  taskId: string;
  taskTitle: string;
  requirements: TaskRequirements;
  eligibleCount: number;
  recommendations: MatchCandidate[];
  ineligible: IneligibleCandidate[];
}

/**
 * Nomad 风格资源感知匹配器：
 * 1. 过滤：硬性条件（启用、参与者门禁、OS/架构、最低 CPU/内存、必需模型）
 * 2. 打分：在线负载（idle > working > stale）、模型匹配度、硬件富余度、历史表现
 * 3. 产出可解释的评分理由，供蜂后决策与派工
 */
export function matchTaskToWorkers(ctx: Ctx, taskId: string): TaskMatchResult {
  const task = getTask(ctx, taskId);
  const req = task.requirements ?? {};
  const boardParticipants = getParticipants(ctx, task.boardId);
  const allowedParticipantSet = boardParticipants.length > 0 ? new Set(boardParticipants) : null;

  const allAgents = listAgents(ctx);
  const overview = getOverview(ctx);
  const overviewMap = new Map<string, AgentOverview>();
  for (const a of overview.agents) {
    overviewMap.set(a.id, a);
  }

  const recommendations: MatchCandidate[] = [];
  const ineligible: IneligibleCandidate[] = [];

  for (const agent of allAgents) {
    // 仅 worker 角色参与匹配
    if (agent.role !== 'worker') continue;
    const reasons: string[] = [];
    const ov = overviewMap.get(agent.id);
    const hasHeartbeat = agent.lastSeenAt !== null;
    const isStale = ov?.status === 'stale' || !hasHeartbeat;
    const effectiveStatus: 'idle' | 'working' | 'stale' = ov?.status === 'working' ? 'working' : (isStale ? 'stale' : 'idle');

    // 1. 阶段一：硬性可行性过滤（Feasibility Filtering）
    // 节点健康可用性
    if (!agent.enabled) {
      reasons.push('工蜂处于停用状态');
    }
    if (!hasHeartbeat) {
      reasons.push('工蜂从未上报心跳（节点尚未就绪）');
    } else if (ov?.status === 'stale') {
      reasons.push('工蜂心跳已超时（处于失联或挂起风险）');
    }
    if (allowedParticipantSet && !allowedParticipantSet.has(agent.id)) {
      reasons.push(`未加入看板 ${task.boardId} 参与者列表`);
    }
    const specs = agent.specs ?? {};
    if (req.executor) {
      const exec = (specs.executor ?? '').toLowerCase();
      if (!exec || exec !== req.executor.toLowerCase()) {
        reasons.push(`执行器内核不匹配（要求 ${req.executor}，实际 ${exec || '未知'}）`);
      }
    }
    if (req.os) {
      const agentOs = (specs.os ?? '').toLowerCase();
      if (!agentOs || agentOs !== req.os.toLowerCase()) {
        reasons.push(`操作系统不匹配（要求 ${req.os}，实际 ${agentOs || '未知'}）`);
      }
    }
    if (req.arch) {
      const agentArch = (specs.arch ?? '').toLowerCase();
      if (!agentArch || agentArch !== req.arch.toLowerCase()) {
        reasons.push(`架构不匹配（要求 ${req.arch}，实际 ${agentArch || '未知'}）`);
      }
    }
    if (typeof req.minCpus === 'number' && req.minCpus > 0) {
      const cpus = specs.cpus ?? 0;
      if (cpus < req.minCpus) {
        reasons.push(`CPU 核心不足（要求最低 ${req.minCpus}C，实际 ${cpus || 0}C）`);
      }
    }

    // 动态容量门禁（基于任务明确声明的资源约束与节点实时新鲜遥测）
    const telem = agent.telemetry;
    const freshTelem = telem && isTelemetryFresh(telem) ? telem : null;
    if (typeof req.maxCpuPercent === 'number' && req.maxCpuPercent > 0) {
      if (!freshTelem || freshTelem.cpuPercent === null) {
        reasons.push('无法确认实时CPU限制（节点未上报新鲜动态CPU负载）');
      } else if (freshTelem.cpuPercent > req.maxCpuPercent) {
        reasons.push(`动态CPU负载超限（当前 ${freshTelem.cpuPercent}% > 任务限制 ${req.maxCpuPercent}%）`);
      }
    }
    // minMemoryGb 既有语义：设备总物理内存最低要求（静态硬约束，实时可用内存作为阶段二排序参考）
    if (typeof req.minMemoryGb === 'number' && req.minMemoryGb > 0) {
      const mem = specs.memoryTotalGb ?? 0;
      if (mem < req.minMemoryGb) {
        reasons.push(`物理总内存不足（要求最低 ${req.minMemoryGb}GB，实际 ${mem || 0}GB）`);
      }
    }
    let modelScore = 0;
    let modelReason = '';
    if (req.requiredModel) {
      const target = req.requiredModel.toLowerCase();
      const pref = (agent.preferredModel ?? '').toLowerCase();
      const inPref = pref && (pref === target || pref.includes(target));
      const inModels = (agent.models ?? []).some((m) => {
        const ml = m.toLowerCase();
        return ml === target || ml.includes(target);
      });

      if (inPref) {
        modelScore = 30;
        modelReason = `首选模型「${agent.preferredModel}」与任务需求高度吻合（+30分）`;
      } else if (inModels) {
        modelScore = 18;
        modelReason = `可用模型包含所需「${req.requiredModel}」（+18分）`;
      } else {
        reasons.push(`模型能力不匹配（所需模型「${req.requiredModel}」未在工蜂模型清单中）`);
      }
    } else {
      if (agent.preferredModel) {
        modelScore = 20;
        modelReason = `具备活跃首选模型「${agent.preferredModel}」（+20分）`;
      } else if ((agent.models ?? []).length > 0) {
        modelScore = 10;
        modelReason = `具备自报可用模型通道（+10分）`;
      }
    }

    // 若存在不满足项，进入 ineligible
    if (reasons.length > 0) {
      ineligible.push({
        agentId: agent.id,
        handle: agent.handle,
        name: agent.name,
        reasons,
      });
      continue;
    }

    // 2. 阶段二：Nomad 风格多维打分（0 ~ 100 分）
    const scoreReasons: string[] = [];

    // 维度 1: 动态算力富余度（占比 40 分：CPU空闲率 20分 + 剩余可用内存 20分，作为建议供蜂后参考）
    let capacityScore = 0;
    let cpuScore = 0;
    let memScore = 0;
    if (freshTelem && freshTelem.cpuPercent !== null) {
      const cpuIdleRatio = Math.max(0, (100 - freshTelem.cpuPercent) / 100);
      cpuScore = Math.round(cpuIdleRatio * 20 * 10) / 10;
    } else {
      // 未采集到新鲜动态 CPU 时，不伪造零负载，基于静态核心数给基准中性分
      cpuScore = Math.min(20, Math.floor((specs.cpus ?? 0) * 1.25));
    }

    if (freshTelem && freshTelem.memoryFreeGb !== null && freshTelem.memoryTotalGb !== null && freshTelem.memoryTotalGb > 0) {
      const freeRatio = Math.min(1, Math.max(0, freshTelem.memoryFreeGb / freshTelem.memoryTotalGb));
      memScore = Math.round(freeRatio * 20 * 10) / 10;
    } else {
      memScore = Math.min(20, Math.floor((specs.memoryTotalGb ?? 0) / 2));
    }
    capacityScore = Math.min(40, Math.round((cpuScore + memScore) * 10) / 10);
    if (freshTelem && freshTelem.cpuPercent !== null && freshTelem.memoryFreeGb !== null) {
      const freePct = freshTelem.memoryTotalGb ? ((freshTelem.memoryFreeGb / freshTelem.memoryTotalGb) * 100).toFixed(0) : '0';
      scoreReasons.push(`动态算力富余度（+${capacityScore}分）：CPU空闲率 ${(100 - freshTelem.cpuPercent).toFixed(0)}%(+${cpuScore}) / 剩余内存 ${freshTelem.memoryFreeGb}GB(${freePct}%)(+${memScore})`);
    } else {
      scoreReasons.push(`硬件富余度：${specs.cpus ?? 0}核(+${cpuScore}) / ${specs.memoryTotalGb ?? 0}GB(+${memScore})（+${capacityScore}分）`);
    }
    // 维度 2: 模型通道亲和度（占比 30 分）
    if (modelScore > 0) {
      scoreReasons.push(modelReason);
    }

    // 维度 3: 负载均衡（占比 20 分：空闲 idle +20分，正在工作 working +5分）
    let loadScore = 0;
    if (effectiveStatus === 'idle') {
      loadScore = 20;
      scoreReasons.push('在线空闲，可立即领取并执行（+20分）');
    } else if (effectiveStatus === 'working') {
      loadScore = 5;
      scoreReasons.push('在线且正执行其它任务，可按需队列排队（+5分）');
    }

    // 维度 4: 项目历史参与（占比 10 分：负责过该看板历史任务）
    let affinityScore = 0;
    const prevBoardTasks = ctx.holder.db
      .prepare("SELECT COUNT(*) AS c FROM task WHERE board_id = ? AND (assignee = ? OR assignee = ?) AND status IN ('active', 'done')")
      .get(task.boardId, agent.id, agent.handle) as { c: number };
    if (prevBoardTasks.c > 0) {
      affinityScore = 10;
      scoreReasons.push(`项目历史参与：该工蜂曾执行过本板 ${prevBoardTasks.c} 项历史任务（+10分）`);
    }

    const totalScore = Math.min(100, Math.round((capacityScore + modelScore + loadScore + affinityScore) * 10) / 10);

    recommendations.push({
      agentId: agent.id,
      handle: agent.handle,
      name: agent.name,
      host: agent.host,
      score: totalScore,
      reasons: scoreReasons,
      status: effectiveStatus,
      specs: agent.specs,
      telemetry: agent.telemetry,
      preferredModel: agent.preferredModel,
    });
  }

  // 按得分由高到低降序排序
  recommendations.sort((a, b) => b.score - a.score);

  return {
    taskId: task.id,
    taskTitle: task.title,
    requirements: req,
    eligibleCount: recommendations.length,
    recommendations,
    ineligible,
  };
}
