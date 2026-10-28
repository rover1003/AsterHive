import { spawn } from 'node:child_process';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { getAgent, findAgent, type Agent } from './agents.ts';
import { getTask, updateTask, type Task } from './tasks.ts';
import { getOverview, type AgentOverview } from './overview.ts';
import { withWrite, logEvent } from './write.ts';
import { withTaskIntegrationLock } from './task-integration-lock.ts';
export interface WorkerProbeResult {
  agentId: string;
  handle: string;
  name: string;
  host: string;
  role: string;
  enabled: boolean;
  status: 'working' | 'idle' | 'stale' | 'disabled';
  lastSeenAt: number | null;
  heartbeatAgeMs: number | null;
  currentTask: AgentOverview['currentTask'];
  specs?: Agent['specs'];
  channelState: 'reachable' | 'unreachable' | 'degraded' | 'local';
  diagnosticSummary: string;
}

export interface WorkerControlActionOutput {
  ok: boolean;
  action: 'restart' | 'stop' | 'kill_orphans';
  agentId: string;
  host: string;
  message: string;
  timestamp: number;
}

export interface WorkerControlDriver {
  probe(host: string, agent: Agent): Promise<{ reachable: boolean; diagnostic?: string }>;
  restart(host: string, agent: Agent, reason: string): Promise<{ ok: boolean; message: string }>;
}

/**
 * 默认的受限控制通道驱动：
 * - 本机或无远程主机：返回 local/ready
 * - 针对已知局域网主机（通过 SSH key 自动化通道执行受限白名单动作）：
 *   仅允许 schtasks / systemctl 等服务级生命周期管理，不开放任意 shell。
 */
class DefaultWorkerControlDriver implements WorkerControlDriver {
  async probe(host: string, _agent: Agent): Promise<{ reachable: boolean; diagnostic?: string }> {
    if (!host || host.toLowerCase() === 'localhost' || host === '127.0.0.1') {
      return { reachable: true, diagnostic: '本机工蜂，本地通道就绪' };
    }
    // 远程工蜂受限探活（无交互、超时 5s、不带凭据输出）
    return new Promise((resolve) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `host-${host.toLowerCase()}`, 'echo ping'], {
        shell: process.platform === 'win32',
      });
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ reachable: false, diagnostic: '远程控制通道连接超时（5s）' });
      }, 6000);

      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ reachable: true, diagnostic: `远程控制通道连通正常（host-${host} 响应 ping）` });
        } else {
          resolve({ reachable: false, diagnostic: `远程控制通道不可达（exit=${code}）` });
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ reachable: false, diagnostic: `远程通道调用失败：${err.message}` });
      });
    });
  }

  async restart(host: string, agent: Agent, reason: string): Promise<{ ok: boolean; message: string }> {
    if (!host || host.toLowerCase() === 'localhost' || host === '127.0.0.1') {
      return { ok: true, message: `本机工蜂 ${agent.handle} 标记重启指令已下发（原因：${reason}）` };
    }
    // 白名单指令：依据设备类型执行服务重启，拒绝任意命令注入
    const targetAlias = `host-${host.toLowerCase()}`;
    const restartCmd = 'schtasks /end /tn "AsterHive worker"; schtasks /run /tn "AsterHive worker"';

    return new Promise((resolve) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', targetAlias, restartCmd], {
        shell: process.platform === 'win32',
      });
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, message: '远程受控重启执行超时（10s）' });
      }, 12000);

      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (out += d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true, message: `已成功通过服务控制器重启工蜂 ${agent.handle}@${host}（${out.trim()}）` });
        } else {
          resolve({ ok: false, message: `受控服务重启返回非零码（exit=${code}）：${out.trim()}` });
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, message: `受控通道网络/系统错误：${err.message}` });
      });
    });
  }
}

let activeDriver: WorkerControlDriver = new DefaultWorkerControlDriver();

export function setWorkerControlDriverForTest(driver: WorkerControlDriver): void {
  activeDriver = driver;
}

export function restoreWorkerControlDriver(): void {
  activeDriver = new DefaultWorkerControlDriver();
}

/**
 * 蜂后工蜂直接诊断接口（Phase 6）：
 * 查询目标工蜂在线状态、心跳差值、当前占用任务、硬件规格及底层控制通道连通度。
 */
export async function probeWorker(ctx: Ctx, agentId: string): Promise<WorkerProbeResult> {
  const agent = getAgent(ctx, agentId);
  if (agent.role !== 'worker') {
    throw new HttpError(400, `agent ${agentId} is not a worker`);
  }

  const overview = getOverview(ctx);
  const ov = overview.agents.find((a) => a.id === agentId);
  const now = Date.now();
  const heartbeatAgeMs = agent.lastSeenAt ? now - agent.lastSeenAt : null;
  const status = ov?.status ?? (agent.enabled ? 'stale' : 'disabled');

  // 通过底层控制驱动探活
  const probe = await activeDriver.probe(agent.host, agent);
  let channelState: WorkerProbeResult['channelState'] = 'unreachable';
  if (!agent.host || agent.host === 'localhost') channelState = 'local';
  else if (probe.reachable) channelState = 'reachable';

  let diagnostic = probe.diagnostic ?? '';
  if (status === 'working' && ov?.currentTask) {
    const task = ov.currentTask;
    diagnostic += ` · 当前任务 ${task.id} 已执行约 ${Math.round(task.elapsedMs / 60000)} 分钟`;
  } else if (status === 'stale') {
    diagnostic += ` · 警告：心跳已过期（最后在线于 ${heartbeatAgeMs ? Math.round(heartbeatAgeMs / 1000) : '未知'} 秒前）`;
  }

  const result: WorkerProbeResult = {
    agentId: agent.id,
    handle: agent.handle,
    name: agent.name,
    host: agent.host,
    role: agent.role,
    enabled: agent.enabled,
    status,
    lastSeenAt: agent.lastSeenAt,
    heartbeatAgeMs,
    currentTask: ov?.currentTask ?? null,
    specs: agent.specs,
    channelState,
    diagnosticSummary: diagnostic.trim(),
  };

  withWrite(ctx, 'worker.probed', () => {
    logEvent(ctx, 'worker.probed', {
      agentId: agent.id,
      handle: agent.handle,
      status,
      channelState,
      diagnosticSummary: result.diagnosticSummary,
    });
  });

  return result;
}

/**
 * 蜂后直接受控干预：通过控制通道重启失联或卡死的目标工蜂服务（Phase 6）。
 * 禁止人工 SSH 介入，凭据永不暴露给 AI 上下文，所有干预全量入审计。
 */
export async function restartWorkerService(
  ctx: Ctx,
  actor: Agent,
  agentId: string,
  reason: string,
): Promise<WorkerControlActionOutput> {
  if (actor.role === 'worker') {
    throw new HttpError(403, 'workers cannot execute remote worker control actions');
  }
  const agent = getAgent(ctx, agentId);
  if (agent.role !== 'worker') {
    throw new HttpError(400, `agent ${agentId} is not a worker`);
  }

  const cleanReason = (reason ?? '').trim();
  if (!cleanReason) throw new HttpError(422, 'restart reason required');

  const execResult = await activeDriver.restart(agent.host, agent, cleanReason);

  const output: WorkerControlActionOutput = {
    ok: execResult.ok,
    action: 'restart',
    agentId: agent.id,
    host: agent.host,
    message: execResult.message,
    timestamp: Date.now(),
  };

  withWrite(ctx, 'worker.restart_requested', () => {
    logEvent(ctx, 'worker.restart_requested', {
      actorId: actor.id,
      agentId: agent.id,
      handle: agent.handle,
      host: agent.host,
      reason: cleanReason,
      ok: execResult.ok,
      message: execResult.message,
    });
  });

  return output;
}

export interface ReleaseStuckTaskOptions {
  confirmedStopped?: boolean;
}

/**
 * 仅用户角色可受控解除挂起/卡死任务占用：
 * 网络断连不等于物理停止；任何在线/离线状态均默认拒绝释放（409）；
 * 仅明确由用户角色提供 confirmedStopped: true 才可继续，主脑（orchestrator）绝不可代替用户提供确认。
 */
export async function releaseStuckTask(
  ctx: Ctx,
  actor: Agent,
  agentId: string,
  taskId: string,
  reason: string,
  options?: ReleaseStuckTaskOptions,
): Promise<Task> {
  if (actor.role !== 'user') {
    throw new HttpError(
      403,
      'only user role may confirm worker stopped and force release tasks; orchestrator cannot arbitrate physical execution stop',
    );
  }
  const task = getTask(ctx, taskId);
  const targetAgent = findAgent(ctx, agentId);
  const matchesAssignee = (assigned: string) => assigned === agentId || (targetAgent !== null && targetAgent !== undefined && (assigned === targetAgent.id || assigned === targetAgent.handle));
  if (!matchesAssignee(task.assignee)) {
    throw new HttpError(400, `task ${taskId} is currently assigned to ${task.assignee}, not ${agentId}`);
  }

  // 物理停止确认门禁（计划 §4.3.6）：
  // 无论工蜂在线还是离线，网络断连均不等于物理停止。默认拒绝释放以防止写冲突；
  // 必须由用户角色明确提供 confirmedStopped: true 确认旧工蜂执行已物理停止后方可释放。
  if (options?.confirmedStopped !== true) {
    throw new HttpError(
      409,
      `网络断连不等于物理停止，默认拒绝解绑以保护外部仓库；必须由用户明确提供 confirmedStopped: true 确认旧工蜂执行已物理停止后方可释放。`,
    );
  }

  const cleanReason = (reason ?? '').trim() || '用户明确确认物理停止后受控解除挂起占用';
  return withTaskIntegrationLock(taskId, async () => {
    const current = getTask(ctx, taskId);
    if (current.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
    if (current.lane !== 'InProgress') throw new HttpError(409, `task ${taskId} not InProgress (lane: ${current.lane})`);
    if (!matchesAssignee(current.assignee)) {
      throw new HttpError(400, `task ${taskId} is currently assigned to ${current.assignee}, not ${agentId}`);
    }

    const depsOk = current.dependsOn.every((d) => {
      const dep = ctx.holder.db.prepare("SELECT lane FROM task WHERE id = ? AND status='active'").get(d) as { lane: string } | undefined;
      return dep?.lane === 'Done';
    });
    const targetLane = depsOk ? 'Ready' : 'Backlog';
    const now = Date.now();

    return withWrite(ctx, 'task.force_released', () => {
      const res = ctx.holder.db
        .prepare(
          `UPDATE task
           SET assignee = 'unassigned',
               lane = ?,
               attempt = attempt + 1,
               claimed_at = NULL,
               review_status = 'none',
               review_summary = '',
               review_attempts = 0,
               last_activity_at = ?,
               last_real_activity_at = NULL,
               last_activity_kind = NULL,
               last_progress_at = NULL,
               updated_at = ?
           WHERE id = ? AND status = 'active' AND lane = 'InProgress'`,
        )
        .run(targetLane, now, now, taskId);

      if (Number(res.changes) !== 1) {
        throw new HttpError(409, `task ${taskId} state changed concurrently`);
      }

      logEvent(ctx, 'task.force_released', {
        taskId,
        agentId,
        by: actor.id,
        reason: cleanReason,
        userConfirmedStopped: true,
        fencedAttempt: current.attempt + 1,
      });
      logEvent(ctx, 'task.lane_changed', { taskId, from: current.lane, to: targetLane, by: actor.id });
      return getTask(ctx, taskId);
    });
  });
}
