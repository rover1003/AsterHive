import type { Ctx } from './types.ts';
import { getTask, getParticipants, type TaskRequirements } from './tasks.ts';
import { listAgents, type Agent } from './agents.ts';
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
    const status = ov?.status ?? 'stale';

    // 1. 硬性条件检查
    if (!agent.enabled) {
      reasons.push('工蜂处于停用状态');
    }
    if (allowedParticipantSet && !allowedParticipantSet.has(agent.id)) {
      reasons.push(`未加入看板 ${task.boardId} 参与者列表`);
    }

    const specs = agent.specs ?? {};
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
    if (typeof req.minMemoryGb === 'number' && req.minMemoryGb > 0) {
      const mem = specs.memoryTotalGb ?? 0;
      if (mem < req.minMemoryGb) {
        reasons.push(`物理内存不足（要求最低 ${req.minMemoryGb}GB，实际 ${mem || 0}GB）`);
      }
    }
    if (req.executor) {
      const exec = (specs.executor ?? '').toLowerCase();
      if (!exec || exec !== req.executor.toLowerCase()) {
        reasons.push(`执行器内核不匹配（要求 ${req.executor}，实际 ${exec || '未知'}）`);
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
        modelScore = 10;
        modelReason = `具备活跃首选模型「${agent.preferredModel}」（+10分）`;
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

    // 2. 评分（Scoring）
    let score = 0;
    const scoreReasons: string[] = [];

    // 在线与负载评分（0 - 40分）
    if (status === 'idle') {
      score += 40;
      scoreReasons.push('在线空闲，可立即领取并执行（+40分）');
    } else if (status === 'working') {
      score += 15;
      scoreReasons.push('在线且正执行其它任务，可按需队列排队（+15分）');
    } else {
      score += 0;
      scoreReasons.push('心跳已超时（处于失联或挂起风险）（+0分）');
    }

    // 模型得分
    if (modelScore > 0) {
      score += modelScore;
      scoreReasons.push(modelReason);
    }

    // 硬件富余度得分（0 - 20分）
    const cpuBonus = Math.min(10, Math.floor((specs.cpus ?? 0) / 2));
    const memBonus = Math.min(10, Math.floor((specs.memoryTotalGb ?? 0) / 8));
    if (cpuBonus > 0 || memBonus > 0) {
      score += cpuBonus + memBonus;
      scoreReasons.push(`硬件富余度：${specs.cpus ?? 0}核(+${cpuBonus}) / ${specs.memoryTotalGb ?? 0}GB(+${memBonus})`);
    }

    // 历史完工活跃度（0 - 10分）
    const doneCount = ov?.doneCount ?? 0;
    const doneBonus = Math.min(10, doneCount * 2);
    if (doneBonus > 0) {
      score += doneBonus;
      scoreReasons.push(`累计顺利交付 ${doneCount} 项任务（+${doneBonus}分）`);
    }

    recommendations.push({
      agentId: agent.id,
      handle: agent.handle,
      name: agent.name,
      host: agent.host,
      score,
      reasons: scoreReasons,
      status,
      specs: agent.specs,
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
