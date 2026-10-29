import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { withWrite, listEvents, logEvent } from './write.ts';
import { listSnapshots, restoreSnapshot, readAudit } from './backup.ts';
import {
  registerAgent,
  listAgents,
  setAgentEnabled,
  deleteAgent,
  heartbeat,
  authByToken,
  reportAgentModels,
  reportAgentSpecs,
  updateAgentProfile,
  getAgentProfile,
  recordAgentTelemetry,
  type Agent,
  type AgentRole,
  type AgentTelemetry,
} from './agents.ts';
import {
  listBoards,
  createBoard,
  getBoard,
  updateBoard,
  deleteBoard,
  getParticipants,
  requireParticipant,
  setParticipants,
  listTasks,
  getTask,
  retryTaskReview,
  createTask,
  updateTask,
  addDependencies,
  type Lane,
  type Priority,
  type TaskRequirements,
  cancelTask,
  returnTaskFromReview,
} from './tasks.ts';
import { claimTask, nextTask, checkpointTask, releaseTask, submitTask } from './verbs.ts';
import { createMessage, listMessages, inboxFor, dispatchTask, type MessageKind } from './messages.ts';
import { getOverview } from './overview.ts';
import {
  getOrchestratorSettings,
  putOrchestratorSettings,
  createOrchestratorGroup,
  updateOrchestratorGroup,
  deleteOrchestratorGroup,
  switchOrchestratorGroup,
  listOrchestratorModels,
  testOrchestratorModel,
  getThinkingProbeTarget,
  getCachedOrchestratorModelMetadata,
  getAdminRecoverySettings,
  setAdminRecoveryPassword,
  verifyAdminRecoveryCredential,
} from './settings.ts';
import { discoverThinkingTiers } from '../../../packages/sdk/src/thinking-discovery.ts';
import { getUserStatus, renameUser, ensureUserAgent } from './user.ts';
import { mountMcp } from './mcp.ts';
import { PiRuntimeManager } from './pi-runtime.ts';
import { RepoManager } from './repo-manager.ts';
import { matchTaskToWorkers } from './scheduler.ts';
import { probeWorker, restartWorkerService, releaseStuckTask } from './worker-control.ts';
import { inferAndApplyTaskDependencies } from './dependencies.ts';
import { handleChatToCard } from './webhook.ts';
import { getFleetRadar, getFleetTelemetry } from './fleet-radar.ts';
import { storeEvidenceFile, listEvidenceFiles, readEvidenceContent, deleteEvidenceFile } from './evidence.ts';
import { Brain } from './brain.ts';
import { withTaskIntegrationLock } from './task-integration-lock.ts';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { listExecutions, executionEvents, recordExecutionActivity } from './executions.ts';
import type { ExecutionActivity } from '../../../packages/sdk/src/execution.ts';
import { parseSessionBatch, storeSessionBatch, readSessionSnapshot, getSessionObservation, setSessionObservation } from './session-observation.ts';

function bearerToken(c: Context): string | null {
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

// 身份解析（2026-10-25 用户终裁）：浏览器端零令牌——不携带 Bearer 的请求即视为唯一用户。
// token 仅是 agent（worker/主脑/内置脑）的身份归属机制，不是用户账号体系；
// 内网（WireGuard）即信任边界，匿名请求获得 user 权限是有意语义。
// 注意：带了 token 但无效（吊销/伪造）必须 401——agent 客户端需要明确失败而非静默降权成用户。
function resolveActor(ctx: Ctx, c: Context): Agent {
  const token = bearerToken(c);
  if (token) {
    const agent = authByToken(ctx, token);
    if (!agent) throw new HttpError(401, 'invalid bearer token');
    return agent;
  }
  return ensureUserAgent(ctx);
}

function requireActor(ctx: Ctx, c: Context): Agent {
  return resolveActor(ctx, c);
}

function requireTokenActor(ctx: Ctx, c: Context): Agent {
  const token = bearerToken(c);
  if (!token) throw new HttpError(401, 'unauthorized: bearer token required');
  const agent = authByToken(ctx, token);
  if (!agent) throw new HttpError(401, 'invalid or revoked bearer token');
  return agent;
}

function requireVerifiedUser(ctx: Ctx, c: Context): Agent {
  const token = bearerToken(c);
  if (!token) throw new HttpError(401, 'administrator recovery credential required');
  const verification = verifyAdminRecoveryCredential(ctx, token);
  if (!verification.configured) throw new HttpError(503, 'administrator recovery credential is not configured');
  if (!verification.ok) throw new HttpError(403, 'invalid administrator recovery credential');
  return ensureUserAgent(ctx);
}
// 提权写闸门：worker 角色的 token 不放行（信任分层仍对 agent 生效）；匿名即 user，自然通过。
function requireElevated(ctx: Ctx, c: Context): Agent {
  const agent = resolveActor(ctx, c);
  if (agent.role !== 'user' && agent.role !== 'orchestrator') {
    throw new HttpError(403, `role '${agent.role}' cannot perform elevated operations`);
  }
  return agent;
}

export function createApp(ctx: Ctx, repoManager = new RepoManager(ctx)): Hono {
  const app = new Hono();

  // Web UI 静态托管（生产形态：单容器同时供 API 与界面）。
  // 必须先于其余路由注册，'/' 才会落到 index.html 而不是被 API 路由抢占。
  const staticRoot = process.env.ASTERHIVE_STATIC_DIR ?? '../web/dist';
  const staticEnabled = existsSync(staticRoot);

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    }
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
  });

  if (staticEnabled) {
    // 缓存策略：index.html 禁缓存（每次拿最新 hash 引用），assets 带内容 hash 可长缓存——
    // 否则重新部署后浏览器旧 index.html 引用已不存在的旧 chunk，动态导入 404
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('cache-control', 'public, max-age=31536000, immutable');
    });
    app.use('*', async (c, next) => {
      await next();
      if (c.res.status === 200 && (c.res.headers.get('content-type') ?? '').includes('text/html')) {
        c.header('cache-control', 'no-cache');
      }
    });
    app.use('*', serveStatic({ root: staticRoot }));
  }

  app.get(staticEnabled ? '/api/info' : '/', (c) =>
    c.json({
      name: 'AsterHive',
      service: 'dispatch-server',
      version: '0.1.0',
      endpoints: ['/health', '/events (SSE)', '/api/events', '/api/audit', '/api/user', '/settings/runtime', '/skill/asterhive-worker', '/bootstrap/', '/mcp'],
    }),
  );

  app.get('/health', (c) => {
    const row = ctx.holder.db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number };
    return c.json({ ok: true, db: true, events: row.n });
  });

  // SSE 事件流：主脑唤醒与 UI 实时刷新共用（立项计划 §7）。
  // 连接建立即订阅总线；事务提交后的领域事件实时下发，另以心跳保活。
  // 有界队列（立项计划 §3.2）：同节点 agent.telemetry 合并为最新帧（可重建，慢消费者
  // 丢弃中间帧并经快照恢复）；非遥测事件逐条入队；总队列超上限即真实终止流
  // （stream.abort()，非 Promise.race 伪取消）——客户端 EventSource onerror 自动重连并重拉权威快照。
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const MAX_QUEUE = 1000;
      const queue: { id: number; type: string; payload: Record<string, unknown> }[] = [];
      // dirty 标志覆盖建立期间事件与唤醒竞态：事件在等待间隙到达但 wake 尚未设置时不丢失。
      let dirty = false;
      let wake: (() => void) | null = null;
      const unsub = ctx.bus.subscribe((type, payload, id) => {
        // 同节点 agent.telemetry 合并为最新帧（丢弃可重建的中间遥测）
        if (type === 'agent.telemetry' && payload && typeof payload === 'object' && 'agentId' in payload) {
          const agentId = payload.agentId;
          const idx = queue.findIndex(
            (e) => e.type === 'agent.telemetry' && e.payload && e.payload.agentId === agentId,
          );
          if (idx !== -1) {
            queue[idx] = { id, type, payload };
          } else {
            queue.push({ id, type, payload });
          }
        } else {
          queue.push({ id, type, payload });
        }
        if (queue.length > MAX_QUEUE) {
          // 队列溢出：真实终止流，客户端重连后重拉快照，杜绝无界内存增长
          unsub();
          stream.abort();
          return;
        }
        dirty = true;
        wake?.();
      });
      stream.onAbort(() => unsub());
      await stream.writeSSE({ event: 'hello', data: 'asterhive event stream' });
      while (!stream.aborted) {
        if (queue.length === 0 && !dirty) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 15_000);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          if (stream.aborted) break;
          if (queue.length === 0 && !dirty) {
            await stream.writeSSE({ event: 'heartbeat', data: String(Date.now()) });
            continue;
          }
        }
        dirty = false;
        while (queue.length > 0 && !stream.aborted) {
          const e = queue.shift()!;
          await stream.writeSSE({
            id: String(e.id),
            event: e.type,
            data: JSON.stringify(e.payload),
          });
        }
      }
    }),
  );

  // ---- 事件台账（只读投影）----

  app.get('/api/events', (c) => {
    const events = listEvents(ctx, {
      type: c.req.query('type') || undefined,
      before: c.req.query('before') ? Number(c.req.query('before')) : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    return c.json({ events });
  });

  app.get('/api/audit', (c) => {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50;
    return c.json({ entries: readAudit(ctx.cfg.dataDir, Math.min(limit, 500)) });
  });

  // ---- 快照与恢复（管理）----

  app.get('/api/admin/snapshots', (c) => c.json({ snapshots: listSnapshots(ctx.cfg.dataDir) }));

  app.post('/api/admin/snapshots', async (c) => {
    withWrite(ctx, 'admin.snapshot', () => {
      logEvent(ctx, 'snapshot.manual', {});
    });
    return c.json({ snapshots: listSnapshots(ctx.cfg.dataDir) }, 201);
  });

  app.post('/api/admin/restore', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { snapshot?: string; confirm?: boolean };
    if (!body.snapshot || body.confirm !== true) {
      throw new HttpError(400, 'restore requires {snapshot, confirm:true}');
    }
    restoreSnapshot(ctx.holder, ctx.cfg.dataDir, body.snapshot);
    withWrite(ctx, 'admin.restore', () => {
      logEvent(ctx, 'server.restored', { snapshot: body.snapshot });
    });
    return c.json({ ok: true, restored: body.snapshot, snapshots: listSnapshots(ctx.cfg.dataDir) });
  });

  // ---- Agent 注册表（§5.3）----

  // 注册自由化（单用户模型）：role 参数自由（worker/orchestrator/user 均可，无门槛）——
  // 外部主脑 A 会话与 worker 设备都走这里；浏览器"用户"身份走 PUT /api/user。
  app.post('/agents/register', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      handle?: string;
      role?: AgentRole;
      models?: string[];
      host?: string;
      specs?: unknown;
    };
    if (!body.name || !body.handle) throw new HttpError(422, 'name and handle required');
    const { agent, token } = registerAgent(ctx, {
      id: body.id,
      name: body.name,
      handle: body.handle,
      role: body.role,
      models: body.models,
      host: body.host,
      specs: body.specs as import('./agents.ts').AgentSpecs | undefined,
    });
    return c.json({ agent, token }, 201); // token 仅此一次返回
  });

  // 用户（id='user'）不是被管理的 agent——它是匿名请求的身份落点，不进接入列表
  app.get('/agents', (c) => c.json({ agents: listAgents(ctx).filter((a) => a.id !== 'user') }));

  // 自己的模型清单自报/更新：token 即身份，worker token 即可，只能改自己（全量覆盖语义）
  app.post('/agents/me/models', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { models?: unknown };
    const agent = reportAgentModels(ctx, actor.id, body.models);
    return c.json({ agent });
  });

  // 自报设备硬件能力规格（Phase 4：OS、架构、CPU 核心数、内存总量等）
  app.post('/agents/me/specs', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { specs?: unknown };
    const agent = reportAgentSpecs(ctx, actor.id, body.specs ?? body);
    return c.json({ agent });
  });

  // 自己的档案速览（CLI worker 每轮取活前拉取）：自报模型 + 用户设置的首选模型
  app.get('/agents/me/profile', (c) => {
    const actor = requireActor(ctx, c);
    return c.json(getAgentProfile(ctx, actor.id));
  });

  // agent 档案与启停（合一端点）：启停沿用原语义；name/note/preferredModel 为档案字段。
  // 零令牌语义：匿名（=user）与 orchestrator 放行，worker token 403；id='user' 也允许改（用户自己的备注）。
  app.patch('/agents/:id', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      name?: string;
      note?: string;
      preferredModel?: string;
    };
    const hasProfile =
      body.name !== undefined || body.note !== undefined || body.preferredModel !== undefined;
    if (typeof body.enabled !== 'boolean' && !hasProfile) {
      throw new HttpError(422, 'enabled:boolean 或 name/note/preferredModel 至少一项');
    }
    let agent: Agent | undefined;
    if (typeof body.enabled === 'boolean') {
      agent = setAgentEnabled(ctx, c.req.param('id'), body.enabled);
    }
    if (hasProfile) {
      const result = updateAgentProfile(ctx, c.req.param('id'), {
        name: body.name,
        note: body.note,
        preferredModel: body.preferredModel,
      });
      agent = result.agent;
    }
    return c.json({ agent });
  });

  // 删除 agent（真删行，≠ 停用；单用户身份受保护；requireElevated 闸门：匿名 user / orchestrator 可删，worker 403）
  app.delete('/agents/:id', (c) => {
    requireElevated(ctx, c);
    deleteAgent(ctx, c.req.param('id'));
    return c.json({ ok: true, deleted: c.req.param('id') });
  });

  // 工蜂自助注销端点（Phase 10：卸载脚本调用，凭自身 worker token 注销自己的身份行并落账）
  app.post('/agents/me/unregister', (c) => {
    const actor = requireActor(ctx, c);
    if (actor.id === 'user') throw new HttpError(422, '单用户身份不可删除');
    deleteAgent(ctx, actor.id);
    return c.json({ ok: true, deleted: actor.id });
  });

  app.post('/agents/:id/heartbeat', async (c) => {
    const actor = requireTokenActor(ctx, c);
    const id = c.req.param('id');
    if (actor.id !== id && actor.role !== 'orchestrator' && actor.role !== 'user') {
      throw new HttpError(403, `forbidden: cannot send heartbeat for agent ${id}`);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      specs?: unknown;
      telemetry?: unknown;
    };
    if (body.specs !== undefined) {
      reportAgentSpecs(ctx, id, body.specs);
    }
    let recordedTelemetry: AgentTelemetry | null = null;
    if (body.telemetry !== undefined) {
      recordedTelemetry = recordAgentTelemetry(ctx, id, body.telemetry);
      ctx.bus.publish('agent.telemetry', { agentId: id, telemetry: recordedTelemetry });
    }
    const agent = heartbeat(ctx, id);
    return c.json({ agent, telemetry: recordedTelemetry ?? agent.telemetry ?? null });
  });

  // ---- 工蜂受控诊断与干预（Phase 6：requireElevated，worker 403）----
  app.post('/agents/:id/control/probe', async (c) => {
    requireElevated(ctx, c);
    const result = await probeWorker(ctx, c.req.param('id'));
    return c.json(result);
  });

  app.post('/agents/:id/control/restart', async (c) => {
    const actor = requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const result = await restartWorkerService(ctx, actor, c.req.param('id'), body.reason ?? '受控恢复');
    return c.json(result);
  });

  app.post('/agents/:id/control/release-task', async (c) => {
    const actor = requireVerifiedUser(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as {
      taskId?: string;
      reason?: string;
      confirmedStopped?: boolean;
    };
    if (!body.taskId) throw new HttpError(422, 'taskId required');
    const task = await releaseStuckTask(ctx, actor, c.req.param('id'), body.taskId, body.reason ?? '', {
      confirmedStopped: body.confirmedStopped === true,
    });
    return c.json({ task });
  });

  // ---- 看板（§5.1 / §7）----

  app.get('/boards', (c) => c.json({ boards: listBoards(ctx) }));

  app.post('/boards', async (c) => {
    requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      repo?: string;
      repoMode?: 'managed' | 'remote-legacy';
      repoInit?: 'empty' | 'clone';
      description?: string;
    };
    if (!body.name) throw new HttpError(422, 'name required');
    const repo = body.repo?.trim() ?? '';
    const repoMode = body.repoMode ?? 'remote-legacy';
    if (repoMode !== 'managed' && repoMode !== 'remote-legacy') throw new HttpError(422, 'repoMode must be managed or remote-legacy');
    const repoInit = body.repoInit ?? (repoMode === 'managed' ? (repo ? 'clone' : undefined) : undefined);
    if (repoMode === 'managed' && repoInit && repoInit !== 'empty' && repoInit !== 'clone') throw new HttpError(422, 'repoInit must be empty or clone for managed boards');
    if (repoInit === 'clone' && !repo) throw new HttpError(422, 'repo URL required for clone initialization');
    const board = createBoard(ctx, {
      id: body.id,
      name: body.name,
      repo,
      repoSource: repoMode === 'managed' && repoInit === 'clone' ? repo : '',
      repoMode,
      repoStatus: repoMode === 'managed' ? (repoInit === 'clone' ? 'queued' : 'empty') : 'ready',
      description: body.description === undefined ? undefined : String(body.description),
    });
    if (repoMode === 'managed' && repoInit) {
      repoManager.initialize(board.id, repoInit, repo || undefined);
      // 空 bare repo 的本地 git init 很快，建板响应直接给 ready；远程 clone 保持异步 queued。
      if (repoInit === 'empty') await repoManager.waitForJob(board.id);
    }
    return c.json({ board: repoMode === 'managed' ? getBoard(ctx, board.id) : board }, 201);
  });

  // 从设备本机导入 Git bundle：Bearer worker 身份 + board participant；raw stream 有长度与 SHA-256 限额校验
  app.post('/boards/:b/repo/import', async (c) => {
    const actor = requireActor(ctx, c);
    const boardId = c.req.param('b');
    const board = getBoard(ctx, boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'board is not in managed repository mode');
    if (actor.role === 'worker') requireParticipant(ctx, boardId, actor);
    else if (actor.role !== 'user' && actor.role !== 'orchestrator') throw new HttpError(403, 'worker/user/orchestrator identity required');
    const length = Number(c.req.header('content-length'));
    const sha256 = c.req.header('x-content-sha256') ?? '';
    if (!Number.isSafeInteger(length) || length < 1) throw new HttpError(411, 'Content-Length required');
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, 'Git bundle body required');
    const result = await repoManager.importBundle(boardId, body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>, length, sha256);
    return c.json({ status: 'imported', ...result });
  });

  // 服务器托管仓库状态（repo 本体不经此端点暴露；worker/主脑只看状态与 HEAD 摘要）
  app.get('/boards/:b/repo', (c) => {
    requireActor(ctx, c);
    const board = repoManager.status(c.req.param('b'));
    return c.json({ boardId: board.id, mode: board.repoMode, status: board.repoStatus, head: board.repoHead, error: board.repoError });
  });

  // 看板管理：改项目元数据（匿名即 user，requireElevated 自然放行；worker token 拒绝）
  app.patch('/boards/:b', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const board = updateBoard(ctx, c.req.param('b'), {
      name: body.name === undefined ? undefined : String(body.name),
      repo: body.repo === undefined ? undefined : String(body.repo),
      description: body.description === undefined ? undefined : String(body.description),
      repoMode: body.repoMode === undefined ? undefined : (body.repoMode as 'managed' | 'remote-legacy'),
      repoStatus: body.repoStatus === undefined ? undefined : (body.repoStatus as 'empty' | 'queued' | 'running' | 'ready' | 'failed'),
    });
    return c.json({ board });
  });

  // 删除看板：级联清空任务/消息/参与者（事件台账保留历史）
  app.delete('/boards/:b', (c) => {
    requireElevated(ctx, c);
    const result = deleteBoard(ctx, c.req.param('b'));
    return c.json({ ok: true, deleted: c.req.param('b'), ...result });
  });

  // 参与者读取：空数组 = 开放给所有 agent
  app.get('/boards/:b/participants', (c) =>
    c.json({ agentIds: getParticipants(ctx, c.req.param('b')) }),
  );

  // 参与者全量覆盖设置（user/orchestrator 身份可操作）
  app.put('/boards/:b/participants', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { agentIds?: unknown };
    if (!Array.isArray(body.agentIds)) throw new HttpError(422, 'agentIds: string[] required');
    const agentIds = setParticipants(ctx, c.req.param('b'), body.agentIds.map(String));
    return c.json({ agentIds });
  });

  app.get('/boards/:b/tasks', (c) =>
    c.json({
      tasks: listTasks(ctx, c.req.param('b'), {
        lane: (c.req.query('lane') as Lane | undefined) || undefined,
        assignee: c.req.query('assignee') || undefined,
        reviewStatus: c.req.query('reviewStatus') || undefined,
      }),
    }),
  );

  app.post('/boards/:b/tasks', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const task = createTask(ctx, c.req.param('b'), {
      id: String(body.id ?? ''),
      title: String(body.title ?? ''),
      detail: body.detail === undefined ? undefined : String(body.detail),
      lane: (body.lane as Lane | undefined) || undefined,
      assignee: body.assignee === undefined ? undefined : String(body.assignee),
      priority: (body.priority as Priority | undefined) || undefined,
      category: body.category === undefined ? undefined : String(body.category),
      acceptance: body.acceptance === undefined ? undefined : String(body.acceptance),
      workspace: (body.workspace as Record<string, unknown> | undefined) || undefined,
      files: (body.files as string[] | undefined) || undefined,
      protectedPaths: (body.protectedPaths as string[] | undefined) || undefined,
      requirements: body.requirements as TaskRequirements | undefined,
      dependsOn: (body.dependsOn as string[] | undefined) || undefined,
    });
    return c.json({ task, by: actor.id }, 201);
  });

  app.get('/tasks/:id', (c) => c.json({ task: getTask(ctx, c.req.param('id')) }));

  app.get('/tasks/:id/executions', (c) => {
    const actor = requireActor(ctx, c);
    const task = getTask(ctx, c.req.param('id'));
    requireParticipant(ctx, task.boardId, actor);
    if (actor.role === 'worker' && task.assignee !== actor.id && task.assignee !== actor.handle) {
      throw new HttpError(403, 'task belongs to another worker');
    }
    return c.json({ executions: listExecutions(ctx, task.id) });
  });

  app.get('/tasks/:id/executions/:executionId/events', (c) => {
    const actor = requireActor(ctx, c);
    const task = getTask(ctx, c.req.param('id'));
    requireParticipant(ctx, task.boardId, actor);
    if (actor.role === 'worker' && task.assignee !== actor.id && task.assignee !== actor.handle) {
      throw new HttpError(403, 'task belongs to another worker');
    }
    const after = Number(c.req.query('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(422, 'invalid event cursor');
    return c.json(executionEvents(ctx, task.id, c.req.param('executionId'), after));
  });

  app.post('/tasks/:id/executions/:attempt/events', async (c) => {
    const actor = requireTokenActor(ctx, c);
    const attempt = Number(c.req.param('attempt'));
    const body = await c.req.json().catch(() => null) as ExecutionActivity | null;
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !body ||
        !Number.isSafeInteger(body.sequence) || body.sequence < 1 ||
        !['started', 'model', 'tool', 'user', 'milestone', 'completed', 'failed', 'cancel_requested', 'cancelled', 'gap'].includes(body.kind) ||
        (['model', 'tool', 'user'].includes(body.kind) && body.phase !== 'start' && body.phase !== 'end') ||
        (body.toolName !== undefined && !['read', 'write', 'edit', 'bash', 'powershell', 'hive_checkpoint', 'unknown'].includes(body.toolName)) ||
        (body.kind === 'tool' && (typeof body.callId !== 'string' || !body.callId)) ||
        (body.baseCommit !== undefined && body.baseCommit !== null && (typeof body.baseCommit !== 'string' || !/^[a-f0-9]{40,64}$/.test(body.baseCommit))) ||
        (body.executor !== undefined && (typeof body.executor !== 'string' || !/^[a-z0-9-]{1,32}$/.test(body.executor))) ||
        (body.callId !== undefined && (typeof body.callId !== 'string' || body.callId.length > 128))) {
      throw new HttpError(422, 'invalid execution activity');
    }
    const execution = withWrite(ctx, 'execution.activity', () => {
      const result = recordExecutionActivity(ctx, actor, c.req.param('id'), attempt, body);
      logEvent(ctx, 'execution.updated', { taskId: result.taskId, boardId: result.boardId, executionId: result.id, attempt: result.attempt });
      return result;
    });
    return c.json({ execution });
  });

  app.get('/tasks/:id/session-observation', (c) => {
    const actor = requireActor(ctx, c);
    const task = getTask(ctx, c.req.param('id'));
    requireParticipant(ctx, task.boardId, actor);
    if (actor.role === 'worker' && task.assignee !== actor.id && task.assignee !== actor.handle) throw new HttpError(403, 'task belongs to another worker');
    return c.json({ ...getSessionObservation(ctx, task.id), cancelRequested: task.status === 'cancelled' });
  });

  app.put('/tasks/:id/session-observation', async (c) => {
    const actor = requireActor(ctx, c);
    if (actor.role !== 'user') throw new HttpError(403, 'only the user can authorize session observation');
    const task = getTask(ctx, c.req.param('id'));
    const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
    if (!body || typeof body.enabled !== 'boolean') throw new HttpError(422, 'enabled must be boolean');
    const enabled = body.enabled;
    const consent = withWrite(ctx, 'session.observation_consent', () => {
      const result = setSessionObservation(ctx, actor, task.id, enabled);
      logEvent(ctx, 'execution.observation_consent', { taskId: task.id, enabled, by: actor.id });
      return result;
    });
    return c.json(consent);
  });

  app.get('/tasks/:id/executions/:executionId/session', (c) => {
    const actor = requireActor(ctx, c);
    const task = getTask(ctx, c.req.param('id'));
    requireParticipant(ctx, task.boardId, actor);
    if (actor.role === 'worker' && task.assignee !== actor.id && task.assignee !== actor.handle) throw new HttpError(403, 'task belongs to another worker');
    const after = Number(c.req.query('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(422, 'invalid session cursor');
    return c.json(readSessionSnapshot(ctx, task.id, c.req.param('executionId'), after));
  });

  app.post('/tasks/:id/executions/:attempt/session',
    bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'session batch exceeds 16 KiB' }, 413) }),
    async (c) => {
      const actor = requireTokenActor(ctx, c);
      const attempt = Number(c.req.param('attempt'));
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw new HttpError(422, 'invalid execution attempt');
      const events = parseSessionBatch(await c.req.json().catch(() => null));
      const taskId = c.req.param('id');
      const result = withWrite(ctx, 'session.observation', () => {
        const stored = storeSessionBatch(ctx, actor, taskId, attempt, events);
        logEvent(ctx, 'execution.session_updated', { taskId, executionId: stored.executionId, attempt, cursor: stored.cursor });
        return stored;
      });
      return c.json(result);
    });

  app.patch('/tasks/:id', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const task = updateTask(ctx, actor, c.req.param('id'), {
      title: body.title === undefined ? undefined : String(body.title),
      detail: body.detail === undefined ? undefined : String(body.detail),
      lane: (body.lane as Lane | undefined) || undefined,
      assignee: body.assignee === undefined ? undefined : String(body.assignee),
      priority: (body.priority as Priority | undefined) || undefined,
      category: body.category === undefined ? undefined : String(body.category),
      acceptance: body.acceptance === undefined ? undefined : String(body.acceptance),
      workspace: (body.workspace as Record<string, unknown> | undefined) || undefined,
      files: (body.files as string[] | undefined) || undefined,
      protectedPaths: (body.protectedPaths as string[] | undefined) || undefined,
      requirements: body.requirements as TaskRequirements | undefined,
    });
    return c.json({ task, by: actor.id });
  });

  app.post('/tasks/:id/depends', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { on?: string[] };
    const task = addDependencies(ctx, actor, c.req.param('id'), body.on ?? []);
    return c.json({ task, by: actor.id });
  });

  // 依赖自动推导与写冲突分析（Phase 7：requireElevated，worker 403）
  app.post('/boards/:b/tasks/infer-dependencies', async (c) => {
    const actor = requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { apply?: boolean };
    const report = inferAndApplyTaskDependencies(ctx, actor, c.req.param('b'), body.apply !== true);
    return c.json(report);
  });

  // ---- Worker 动词（交接协议：claim / checkpoint / release / submit + next 动态拉取）----

  app.post('/boards/:b/next', (c) => {
    const actor = requireActor(ctx, c);
    return c.json(nextTask(ctx, actor, c.req.param('b')));
  });

  app.post('/boards/:b/tasks/next', (c) => {
    const actor = requireActor(ctx, c);
    return c.json(nextTask(ctx, actor, c.req.param('b')));
  });

  app.post('/tasks/:id/claim', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { files?: string[] };
    const task = claimTask(ctx, actor, c.req.param('id'), body.files);
    return c.json({ task, by: actor.id });
  });

  app.post('/tasks/:id/checkpoint', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as {
      note?: string;
      kind?: string;
      isKeepalive?: boolean;
      attempt?: number;
    };
    const result = checkpointTask(ctx, actor, c.req.param('id'), {
      note: body.note ?? '',
      kind: body.kind,
      isKeepalive: body.isKeepalive,
      attempt: body.attempt,
    });
    return c.json({ ...result, by: actor.id });
  });

  app.post('/tasks/:id/release', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const task = await releaseTask(ctx, actor, c.req.param('id'), body.reason);
    return c.json({ task, by: actor.id });
  });

  app.post('/tasks/:id/submit', async (c) => {
    const actor = requireActor(ctx, c);
    const taskId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      summary?: string;
      evidence?: { path: string; machine?: string; note?: string }[];
      noCode?: boolean;
      attempt?: number;
    };
    const task = await withTaskIntegrationLock(taskId, async () =>
      submitTask(ctx, actor, taskId, {
        summary: body.summary ?? '',
        evidence: body.evidence,
        noCode: body.noCode,
        attempt: body.attempt,
      }),
    );
    return c.json({ task, by: actor.id });
  });

  app.post('/tasks/:id/review/retry', (c) => {
    const actor = requireElevated(ctx, c);
    const task = retryTaskReview(ctx, actor, c.req.param('id'));
    return c.json({ task });
  });

  app.post('/tasks/:id/review/accept', async (c) => {
    const actor = requireElevated(ctx, c);
    return c.json(await repoManager.acceptManualTask(c.req.param('id'), actor));
  });

  app.post('/tasks/:id/review/return', async (c) => {
    const actor = requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string; assignee?: string };
    const task = await returnTaskFromReview(ctx, actor, c.req.param('id'), body);
    return c.json({ task });
  });

  app.post('/tasks/:id/review/reject', async (c) => {
    const actor = requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string; assignee?: string };
    const task = await returnTaskFromReview(ctx, actor, c.req.param('id'), body);
    return c.json({ task });
  });

  app.post('/tasks/:id/cancel', async (c) => {
    const actor = requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    return c.json({ task: await cancelTask(ctx, actor, c.req.param('id'), body.reason ?? '') });
  });

  // managed 模式：Worker 领取任务代码快照 Bundle
  app.get('/tasks/:id/repo-snapshot', async (c) => {
    const actor = requireActor(ctx, c);
    const taskId = c.req.param('id');
    const rawAttempt = c.req.header('x-task-attempt');
    const expectedAttempt = rawAttempt !== undefined ? Number(rawAttempt) : undefined;

    return withTaskIntegrationLock(taskId, async () => {
      const task = getTask(ctx, taskId);
      if (actor.role === 'worker') {
        requireParticipant(ctx, task.boardId, actor);
        if (task.assignee !== actor.id && task.assignee !== actor.handle) {
          throw new HttpError(403, `only assigned worker (${task.assignee}) may download repo snapshot`);
        }
      }
      if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
      if (task.lane !== 'InProgress') throw new HttpError(409, `task ${taskId} not InProgress (lane: ${task.lane})`);

      const taskAttempt = task.attempt ?? 1;
      if (actor.role === 'worker') {
        if (taskAttempt > 1) {
          if (expectedAttempt === undefined) {
            throw new HttpError(
              409,
              `stale or unversioned execution attempt: task ${taskId} has been re-dispatched (attempt ${taskAttempt}); x-task-attempt header required`,
            );
          }
          if (expectedAttempt !== taskAttempt) {
            throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${expectedAttempt}`);
          }
        } else if (expectedAttempt !== undefined && expectedAttempt !== taskAttempt) {
          throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${expectedAttempt}`);
        }
      }

      const snap = await repoManager.exportTaskSnapshot(task.boardId, taskId);
      try {
        const stat = statSync(snap.bundlePath);
        c.header('content-type', 'application/vnd.git.bundle');
        c.header('content-length', String(stat.size));
        c.header('x-base-commit', snap.baseCommit);
        if (snap.reworkCommit) {
          c.header('x-rework-commit', snap.reworkCommit);
        }
        if (snap.reworkBranch) {
          c.header('x-rework-branch', snap.reworkBranch);
        }
        const stream = createReadStream(snap.bundlePath);
        stream.on('close', snap.cleanup);
        return c.body(stream as unknown as ReadableStream);
      } catch (err) {
        snap.cleanup();
        throw err;
      }
    });
  });

  // managed 模式：Worker 回传任务结果 Git Bundle
  app.post('/tasks/:id/repo-result', async (c) => {
    const actor = requireActor(ctx, c);
    const taskId = c.req.param('id');
    const length = Number(c.req.header('content-length'));
    const sha256 = c.req.header('x-content-sha256') ?? '';
    if (!Number.isSafeInteger(length) || length < 1) throw new HttpError(411, 'Content-Length required');
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, 'Git bundle body required');

    const rawAttempt = c.req.header('x-task-attempt');
    const expectedAttempt = rawAttempt !== undefined ? Number(rawAttempt) : undefined;

    return withTaskIntegrationLock(taskId, async () => {
      let task = getTask(ctx, taskId);
      if (actor.role === 'worker') {
        requireParticipant(ctx, task.boardId, actor);
        if (task.assignee !== actor.id && task.assignee !== actor.handle) {
          throw new HttpError(403, `only assigned worker (${task.assignee}) may upload repo result`);
        }
      }
      if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
      if (task.lane !== 'InProgress') throw new HttpError(409, `task ${taskId} not InProgress (lane: ${task.lane})`);
      if (task.lastActivityKind === 'error' || task.lastActivityKind === 'timeout') {
        throw new HttpError(409, 'task execution failed; 确认工蜂停止后受控恢复');
      }

      const taskAttempt = task.attempt ?? 1;
      if (taskAttempt > 1) {
        if (expectedAttempt === undefined) {
          throw new HttpError(
            409,
            `stale or unversioned execution attempt: task ${taskId} has been re-dispatched (attempt ${taskAttempt}); x-task-attempt header required`,
          );
        }
        if (expectedAttempt !== taskAttempt) {
          throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${expectedAttempt}`);
        }
      } else if (expectedAttempt !== undefined && expectedAttempt !== taskAttempt) {
        throw new HttpError(409, `stale execution attempt: expected ${taskAttempt}, got ${expectedAttempt}`);
      }

      const result = await repoManager.importTaskResult(
        task.boardId,
        taskId,
        body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>,
        length,
        sha256,
      );

      task = getTask(ctx, taskId);
      if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} was cancelled during upload`);
      if (task.lane !== 'InProgress') throw new HttpError(409, `task ${taskId} is no longer InProgress`);
      if (expectedAttempt !== undefined && (task.attempt ?? 1) !== expectedAttempt) {
        throw new HttpError(409, `stale execution attempt detected after upload: expected ${task.attempt}, got ${expectedAttempt}`);
      }

      return c.json({ status: 'saved', ...result });
    });
  });

  // managed 模式：查询任务分支差异（Diff / Stat），供前端卡片及审查抽屉展示
  app.get('/tasks/:id/repo-diff', async (c) => {
    const actor = requireActor(ctx, c);
    const taskId = c.req.param('id');
    const task = getTask(ctx, taskId);
    const board = getBoard(ctx, task.boardId);
    if (board.repoMode !== 'managed') throw new HttpError(409, 'task does not use a managed repository');
    if (actor.role === 'worker') requireParticipant(ctx, task.boardId, actor);
    const diff = await repoManager.inspectTask(task.boardId, taskId);
    return c.json(diff);
  });

  // 资源感知任务匹配查询（Nomad 风格调度评估与建议：仅 orchestrator / user 可查，worker 403）
  app.get('/tasks/:id/match', (c) => {
    requireElevated(ctx, c);
    const result = matchTaskToWorkers(ctx, c.req.param('id'));
    return c.json(result);
  });

  // ---- 证据上传端点（T15：小文件入库、大文件登记校验和）----
  app.post('/tasks/:id/evidence', async (c) => {
    const actor = requireActor(ctx, c);
    const taskId = c.req.param('id');
    const rawName = c.req.header('x-filename') || c.req.query('filename') || '';
    let filename = rawName;
    try { filename = decodeURIComponent(rawName); } catch { /* 原样使用 */ }
    const rawNote = c.req.header('x-note') || c.req.query('note') || '';
    let note = rawNote;
    try { note = decodeURIComponent(rawNote); } catch { /* 原样使用 */ }
    const expectedSha = c.req.header('x-content-sha256') || '';
    const rawAttempt = c.req.header('x-task-attempt') || c.req.query('attempt');
    const attempt = rawAttempt !== undefined && rawAttempt !== '' ? Number(rawAttempt) : undefined;
    const buf = new Uint8Array(await c.req.arrayBuffer());
    const file = storeEvidenceFile(ctx, actor, taskId, filename, buf, note, expectedSha, attempt);
    return c.json({ file }, 201);
  });

  app.get('/tasks/:id/evidence', (c) => {
    requireActor(ctx, c);
    return c.json({ files: listEvidenceFiles(ctx, c.req.param('id')) });
  });

  app.get('/tasks/:id/evidence/:fileId', (c) => {
    requireActor(ctx, c);
    const { file, content } = readEvidenceContent(ctx, c.req.param('id'), Number(c.req.param('fileId')));
    return new Response(content as ConstructorParameters<typeof Response>[0], {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(content.byteLength),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'x-content-sha256': file.sha256,
      },
    });
  });

  app.delete('/tasks/:id/evidence/:fileId', (c) => {
    const actor = requireElevated(ctx, c);
    deleteEvidenceFile(ctx, actor, c.req.param('id'), Number(c.req.param('fileId')));
    return c.json({ ok: true });
  });

  // ---- 聊天室（§6：统一控制面）----

  app.get('/boards/:b/messages', (c) =>
    c.json({
      messages: listMessages(ctx, c.req.param('b'), {
        since: c.req.query('since') ? Number(c.req.query('since')) : undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      }),
    }),
  );

  // 发言：带 token 落 agent 身份；无 token 按单用户 'user'（内网信任，浏览器未配身份时兜底）
  app.post('/boards/:b/messages', async (c) => {
    // 零令牌语义：无/无效 token 一律按唯一用户发言（agent 仍可用 token 以自身身份发言）
    const agent = resolveActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; kind?: MessageKind };
    // 用户发言即指令（§6）：user 角色/匿名用户默认 intervention，worker 默认 progress
    const kind: MessageKind | undefined =
      body.kind ?? (agent.role !== 'user' ? 'progress' : 'intervention');
    const message = createMessage(ctx, {
      boardId: c.req.param('b'),
      author: agent.id,
      kind,
      content: body.content ?? '',
    });
    return c.json({ message }, 201);
  });

  app.get('/agents/me/inbox', (c) => {
    const actor = requireActor(ctx, c);
    const since = c.req.query('since') ? Number(c.req.query('since')) : 0;
    return c.json({ messages: inboxFor(ctx, actor, since) });
  });

  app.post('/tasks/:id/dispatch', async (c) => {
    const actor = requireActor(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; assignee?: string };
    if (!body.content?.trim()) throw new HttpError(422, 'content required');
    const result = dispatchTask(ctx, actor, c.req.param('id'), {
      content: body.content,
      assignee: body.assignee,
    });
    return c.json({ ...result, by: actor.id }, 201);
  });

  // ---- 多端无感派活 Webhook（Phase 8：Chat-to-Card）----
  app.post('/api/webhooks/chat-to-card', async (c) => {
    let body: Record<string, unknown> = {};
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } else {
      const text = await c.req.text().catch(() => '');
      body = { content: text };
    }

    const result = await handleChatToCard(ctx, {
      content: String(body.content ?? ''),
      boardId: body.boardId ? String(body.boardId) : undefined,
      source: body.source ? String(body.source) : (c.req.header('x-source') || 'webhook'),
      author: body.author ? String(body.author) : 'user',
    });
    return c.json(result, 201);
  });

  // ---- 总览与设置（§7）----

  app.get('/overview', (c) => c.json(getOverview(ctx)));

  // 舰队体检雷达端点（Phase 9：全局算力、停滞预警与干预审计）
  app.get('/api/fleet/radar', (c) => {
    requireActor(ctx, c);
    return c.json(getFleetRadar(ctx));
  });

  // 舰队遥测时序与实时指标端点（Nomad 风格）
  app.get('/api/fleet/telemetry', (c) => {
    requireActor(ctx, c);
    return c.json(getFleetTelemetry(ctx));
  });

  app.get('/api/fleet/telemetry/:id', (c) => {
    requireActor(ctx, c);
    const id = c.req.param('id');
    const result = getFleetTelemetry(ctx, id);
    if (!result) throw new HttpError(404, `telemetry not found for agent: ${id}`);
    return c.json(result);
  });

  app.get('/agents/:id/telemetry', (c) => {
    requireActor(ctx, c);
    const id = c.req.param('id');
    const result = getFleetTelemetry(ctx, id);
    if (!result) throw new HttpError(404, `telemetry not found for agent: ${id}`);
    return c.json(result);
  });

  // 多模型组（主脑多模型组升级）：GET 投影 { enabled, wakeOn, activeGroupId, groups }，
  // cipher/明文永不回显；旧单配置顶层字段（provider/baseURL/model/apiKey）不再输出。
  app.get('/settings/orchestrator', (c) => c.json(getOrchestratorSettings(ctx)));

  // 全局开关与审核员模型组绑定：enabled/wakeOn/reviewerGroupId
  app.put('/settings/orchestrator', async (c) => {
    requireElevated(ctx, c); // user/orchestrator 身份可写（单用户模型，管理令牌已移除）
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(
      putOrchestratorSettings(ctx, {
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
        wakeOn: body.wakeOn as never,
        reviewerGroupId: body.reviewerGroupId === undefined ? undefined : (body.reviewerGroupId ? String(body.reviewerGroupId) : null),
        reviewerModel: body.reviewerModel === undefined ? undefined : (body.reviewerModel ? String(body.reviewerModel) : null),
        reviewerEnabled: body.reviewerEnabled === undefined ? undefined : Boolean(body.reviewerEnabled),
      }),
    );
  });

  app.get('/settings/admin-recovery', (c) => c.json(getAdminRecoverySettings(ctx)));

  app.put('/settings/admin-recovery', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    return c.json(setAdminRecoveryPassword(ctx, body.password));
  });

  // 上游 /models 清单（60s 缓存，缓存键=baseURL）——设置页模型下拉的数据源；
  // ?group=<id> 按组拉取，缺省 = 激活组；?force=1 手动刷新绕过缓存
  app.get('/settings/orchestrator/models', async (c) => {
    requireElevated(ctx, c);
    return c.json(await listOrchestratorModels(ctx, {
      groupId: c.req.query('group') || undefined,
      force: c.req.query('force') === '1',
    }));
  });

  // 一键探测模型连通：groupId 缺省 = 激活组；model 缺省 = 组配置的模型
  app.post('/settings/orchestrator/test', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(
      await testOrchestratorModel(ctx, {
        groupId: body.groupId === undefined ? undefined : String(body.groupId),
        model: body.model === undefined ? undefined : String(body.model),
      }),
    );
  });

  // 单次思考等级探测：只允许用户主动确认，并仅使用已保存模型组的 endpoint/model/key。
  app.post('/settings/orchestrator/groups/:id/thinking-probe', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.confirmed !== true) throw new HttpError(400, '思考等级探测可能产生上游费用；请明确确认后重试。');
    const target = getThinkingProbeTarget(ctx, c.req.param('id'));
    const modelMetadata = getCachedOrchestratorModelMetadata(ctx, c.req.param('id'), target.model);
    return c.json(await discoverThinkingTiers({
      ...target,
      ...(modelMetadata !== undefined ? { modelMetadata } : {}),
    }));
  });

  // ---- 模型组 CRUD（每组独立 name/baseURL/apiKey/model；授权同全局开关）----

  app.post('/settings/orchestrator/groups', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const group = createOrchestratorGroup(ctx, {
      name: body.name === undefined ? undefined : String(body.name),
      baseURL: body.baseURL === undefined ? undefined : String(body.baseURL),
      apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
      model: body.model === undefined ? undefined : String(body.model),
      thinkingLevel: body.thinkingLevel,
      thinkingLevelMap: body.thinkingLevelMap,
    });
    return c.json({ group }, 201);
  });

  // 局部更新：未传键不覆盖；apiKey 缺省/空串 = 保留原 KEY（UI 永不回显）
  app.put('/settings/orchestrator/groups/:id', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const group = updateOrchestratorGroup(ctx, c.req.param('id'), {
      name: body.name === undefined ? undefined : String(body.name),
      baseURL: body.baseURL === undefined ? undefined : String(body.baseURL),
      apiKey: body.apiKey === undefined ? undefined : String(body.apiKey),
      model: body.model === undefined ? undefined : String(body.model),
      thinkingLevel: body.thinkingLevel,
      thinkingLevelMap: body.thinkingLevelMap,
    });
    return c.json({ group });
  });

  // 删除模型组：还有其他组时激活组 422（先启用其他组）；删的是最后一组则允许（主脑未配置态）
  app.delete('/settings/orchestrator/groups/:id', (c) => {
    requireElevated(ctx, c);
    deleteOrchestratorGroup(ctx, c.req.param('id'));
    return c.json({ ok: true, deleted: c.req.param('id') });
  });

  // 切换激活组：组不存在 404。必发 settings.orchestrator_updated → brain 既有
  // disposeSession 分支重建会话——换通道下一轮即生效（不用重启、不残留旧 provider 绑定）。
  app.put('/settings/orchestrator/active', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.groupId === undefined || String(body.groupId) === '') throw new HttpError(422, 'groupId required');
    return c.json(switchOrchestratorGroup(ctx, String(body.groupId)));
  });

  // ---- Pi 运行时（T14：数据卷自管理，更新/回滚不重启服务器进程）----

  const piRuntime = new PiRuntimeManager(ctx);
  const brain = new Brain(ctx, piRuntime);
  brain.start(); // 只订阅总线；settings.enabled 决定是否激活（默认关，测试与裸部署零副作用）

  // 主动中止主脑当前轮次（聊天页停止按钮）：授权同主脑设置（requireElevated，worker token 403）。
  // 幂等——未在运行（含已收尾/会话已弃）返回 { aborted: false }，前端据此保持现状不误撤指示。
  app.post('/settings/orchestrator/abort', (c) => {
    requireElevated(ctx, c);
    return c.json({ aborted: brain.abortTurn('user') });
  });

  app.get('/settings/runtime', async (c) => {
    const status = piRuntime.status();
    // 上游 latest 用 npm view 子进程现查（失败 → null，UI 显示未知）；管理页低频调用可接受
    status.latest = await piRuntime.latestVersion();
    return c.json(status);
  });

  // 更新/回滚授权与主脑设置一致：user/orchestrator 身份（requireElevated）
  app.post('/settings/runtime/update', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { version?: string };
    const result = await piRuntime.update(typeof body.version === 'string' ? body.version : undefined);
    return c.json({ ok: true, ...result });
  });

  app.post('/settings/runtime/rollback', async (c) => {
    requireElevated(ctx, c);
    return c.json({ ok: true, ...(await piRuntime.rollback()) });
  });

  // ---- 主脑扩展 / 技能界面化管理（T17：user/orchestrator 可管理，worker 403）----

  app.get('/settings/runtime/extensions', (c) => {
    requireElevated(ctx, c);
    return c.json({ extensions: piRuntime.listExtensions() });
  });

  app.post('/settings/runtime/extensions/install', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { package?: string; version?: string };
    if (!body.package?.trim()) throw new HttpError(422, 'package required');
    const result = await piRuntime.installExtension(body.package, body.version);
    return c.json(result, 201);
  });

  app.post('/settings/runtime/extensions/:name/enabled', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') throw new HttpError(422, 'enabled:boolean required');
    return c.json(piRuntime.setExtensionEnabled(c.req.param('name'), body.enabled));
  });

  app.delete('/settings/runtime/extensions/:name', (c) => {
    requireElevated(ctx, c);
    return c.json(piRuntime.deleteExtension(c.req.param('name')));
  });

  app.get('/settings/runtime/skills', (c) => {
    requireElevated(ctx, c);
    return c.json({ skills: piRuntime.listSkills() });
  });

  app.put('/settings/runtime/skills/:name', async (c) => {
    requireElevated(ctx, c);
    const body = (await c.req.json().catch(() => ({}))) as { markdown?: string };
    if (typeof body.markdown !== 'string' || !body.markdown.trim()) throw new HttpError(422, 'markdown required');
    return c.json(piRuntime.writeSkill(c.req.param('name'), body.markdown));
  });

  // 读取技能 SKILL.md 全文（UI「载入编辑」用；限 skills/ 内，防目录穿越）
  app.get('/settings/runtime/skills/:name/content', (c) => {
    requireElevated(ctx, c);
    const name = c.req.param('name');
    if (!/^[\w][\w.-]*$/.test(name)) throw new HttpError(422, `invalid skill name: ${name}`);
    const file = join(piRuntime.skillsDir, name, 'SKILL.md');
    if (!existsSync(file)) throw new HttpError(404, `skill not found: ${name}`);
    return c.text(readFileSync(file, 'utf8'));
  });

  app.delete('/settings/runtime/skills/:name', (c) => {
    requireElevated(ctx, c);
    return c.json(piRuntime.deleteSkill(c.req.param('name')));
  });

  // ---- 单用户身份（设置页"用户名"；浏览器写操作以该身份 token 作 Bearer）----

  // 公开读：设置页回填用户名。
  app.get('/api/user', (c) => c.json(getUserStatus(ctx)));

  // 改用户名（显示名）。零令牌：不存在签发/轮换 token 的任何流程（用户终裁 2026-10-25）。
  app.put('/api/user', async (c) => {
    requireElevated(ctx, c); // 无头=用户放行；worker token/无效 token 拒绝
    const body = (await c.req.json().catch(() => ({}))) as { handle?: string };
    return c.json(renameUser(ctx, body));
  });

  // ---- 技能分发：桌面会话无需预装，直接拉取技能全文 ----
  // 路径以 src/ 为基准向上三级（src → server → apps → 仓库根）：
  // 本地仓库（<repo>/skills）与容器 /app 布局（/app/skills）均成立。

  app.get('/skill/:name', (c) => {
    if (c.req.param('name') !== 'asterhive-worker') {
      throw new HttpError(404, `unknown skill: ${c.req.param('name')}`);
    }
    const path = fileURLToPath(new URL('../../../skills/asterhive-worker/SKILL.md', import.meta.url));
    if (!existsSync(path)) {
      throw new HttpError(404, 'skill file not found: skills/asterhive-worker/SKILL.md 未随服务器部署');
    }
    return c.body(readFileSync(path, 'utf8'), 200, {
      'content-type': 'text/markdown; charset=utf-8',
    });
  });

  // ---- 自举快捷通道（/bootstrap/）：偏爱现成 CLI 的 agent 用两条命令把单文件 CLI 拉到本机 ----
  // 公开只读端点（不挂 requireActor）：零令牌语义下匿名即可读，与 /skill/:name 同级。
  // 源文件定位（按序尝试）：容器布局 COPY packages/sdk/src → /app/sdk/（相对 http.ts 向上三级）；
  // 仓库直跑布局 <repo>/packages/sdk/src（同样向上三级即仓库根）。都缺失 → 503，不许崩。
  const BOOTSTRAP_FILES = new Set(['cli.ts', 'index.ts']); // 白名单：仅这两个文件可读，不作目录敞开

  function readBootstrapSource(file: string): string {
    const candidates = [
      fileURLToPath(new URL(`../../../sdk/${file}`, import.meta.url)), // 容器：/app/sdk/<file>
      fileURLToPath(new URL(`../../../packages/sdk/src/${file}`, import.meta.url)), // 仓库：<repo>/packages/sdk/src/<file>
    ];
    for (const p of candidates) {
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    throw new HttpError(503, 'bootstrap 文件未随镜像安装');
  }

  const bootstrapIndex = (c: Context) => {
    const base = new URL(c.req.url).origin;
    const text = [
      'AsterHive worker 自举（可选快捷通道；完整协议见 ' + `${base}/skill/asterhive-worker` + '）',
      '',
      '# 1) 下载单文件 CLI（零第三方依赖，node >= 23.6 直接运行 .ts；cli.ts 依赖同目录的 index.ts）',
      `curl -fLo cli.ts ${base}/bootstrap/cli.ts`,
      `curl -fLo index.ts ${base}/bootstrap/index.ts`,
      '',
      '# 2) 注册（默认身份，撞名自愈；token 自动写入 ~/.asterhive/worker.json，仅此一次返回）',
      `node cli.ts register --url ${base}`,
      '',
      '# 3) 之后用 CLI 走同样的领活循环：next / claim / checkpoint / submit / release / inbox / message',
      'node cli.ts next --board <boardId>',
    ].join('\n');
    return c.body(text, 200, { 'content-type': 'text/plain; charset=utf-8' });
  };

  app.get('/bootstrap', bootstrapIndex); // 无斜杠别名：浏览器手输少打一个字符也能到
  app.get('/bootstrap/', bootstrapIndex);
  app.get('/bootstrap/:file', (c) => {
    const file = c.req.param('file');
    if (!BOOTSTRAP_FILES.has(file)) {
      throw new HttpError(404, `unknown bootstrap file: ${file}`);
    }
    return c.body(readBootstrapSource(file), 200, { 'content-type': 'text/plain; charset=utf-8' });
  });

  // ---- 托管脚本与工蜂源码包分发（/scripts/）----
  // 支持 install-bee / uninstall-bee 脚本及 worker.tar.gz 源码包内网直拉分发；
  // 返回脚本时动态将 __HIVE_URL_PLACEHOLDER__ 替换为当前请求实际 base origin，实现内网零配置直连。
  const SCRIPT_FILES = new Set([
    'install-bee.ps1',
    'install-bee.sh',
    'activate-bee.ps1',
    'activate-bee.sh',
    'uninstall-bee.ps1',
    'uninstall-bee.sh',
    'worker.tar.gz',
  ]);

  function resolveScriptFile(file: string): string {
    const candidates = [
      fileURLToPath(new URL(`../../../scripts/${file}`, import.meta.url)),
      fileURLToPath(new URL(`../../scripts/${file}`, import.meta.url)),
      fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    throw new HttpError(404, `script file not found: ${file}`);
  }

  app.get('/scripts/:file', (c) => {
    const file = c.req.param('file');
    if (!SCRIPT_FILES.has(file)) {
      throw new HttpError(404, `unknown script: ${file}`);
    }
    const filePath = resolveScriptFile(file);
    if (file.endsWith('.tar.gz')) {
      const buffer = readFileSync(filePath);
      return c.body(buffer, 200, {
        'content-type': 'application/gzip',
        'cache-control': 'no-cache',
        'content-disposition': `attachment; filename="${file}"`,
      });
    }
    let content = readFileSync(filePath, 'utf8');
    const base = new URL(c.req.url).origin;
    content = content.replaceAll('__HIVE_URL_PLACEHOLDER__', base);
    return c.body(content, 200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
    });
  });

  // ---- MCP 服务端（Streamable HTTP，挂在 /mcp）----
  // 分派服务器自身即 MCP 服务：桌面 agent 会话配一个 URL + Bearer token 即成 worker/主脑。
  mountMcp(app, ctx);

  return app;
}
