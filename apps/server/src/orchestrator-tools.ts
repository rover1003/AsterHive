// 星巢协议工具的单一事实源（T14 重构）：
// MCP 服务端（mcp.ts）与内置主脑（brain.ts）共用同一张定义表——
// 名称/描述/zod 参数 schema/执行函数只在此处维护，两侧各自生成自己的注册形态。
// 约束：全表 15 个工具，全部是"看板/聊天室协议动词"，绝不包含 shell/文件/浏览器
// 执行面——主脑侧只注册这张表，结构性保证"只分派不执行"。
import { z } from 'zod';
import type { ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { HttpError, type Ctx } from './types.ts';
import type { Agent } from './agents.ts';
import {
  listBoards,
  getBoard,
  listTasks,
  getTask,
  createTask,
  updateTask,
  LANES,
  type Lane,
  type Priority,
} from './tasks.ts';
import { claimTask, nextTask, checkpointTask, releaseTask, submitTask } from './verbs.ts';
import { createMessage, inboxFor, dispatchTask, type MessageKind } from './messages.ts';
import { getOverview } from './overview.ts';
import { RepoManager } from './repo-manager.ts';
import { matchTaskToWorkers } from './scheduler.ts';
import { probeWorker, restartWorkerService, releaseStuckTask } from './worker-control.ts';
import { inferAndApplyTaskDependencies } from './dependencies.ts';
import { getFleetRadar } from './fleet-radar.ts';

export const MESSAGE_KINDS = [
  'dispatch',
  'submit',
  'progress',
  'intervention',
  'question',
  'report',
  'system',
] as const;

export const PRIORITIES = ['P0', 'P1', 'P2'] as const;

export interface ToolDef {
  name: string;
  description: string;
  shape?: z.ZodRawShape;
  // actor 参数化：MCP 侧传请求身份（Bearer 解析），主脑侧传内置系统身份。
  handle: (ctx: Ctx, actor: Agent, args: Record<string, unknown>) => unknown;
}

// 借 SDK 的 ShapeOutput 从 zod raw shape 推导处理器实参类型（zod v3/v4 兼容）
function tool<S extends z.ZodRawShape | undefined>(
  name: string,
  description: string,
  shape: S,
  handle: (ctx: Ctx, a: Agent, args: S extends z.ZodRawShape ? ShapeOutput<S> : Record<string, never>) => unknown,
): ToolDef {
  return { name, description, shape, handle: handle as ToolDef['handle'] };
}

// ---- 工具定义表（单一事实源）----

export const TOOL_DEFS: ToolDef[] = [
  // ---- Worker 侧：领活与交活 ----
  tool('asterhive_me', '返回当前 token 对应的 agent 身份（id、句柄、角色）。', undefined, (_ctx, a) => a),
  tool(
    'asterhive_inbox',
    '拉取 @ 我（我的句柄）的消息收件箱，since 为上次读到的最大消息 id。',
    { since: z.number().int().optional() },
    (ctx, a, args) => inboxFor(ctx, a, args.since ?? 0),
  ),
  tool(
    'asterhive_next',
    '在指定看板按优先级原子领取一张 Ready 未认领的卡（含 TTL 清扫），无卡时 task 为 null。',
    { boardId: z.string() },
    (ctx, a, args) => nextTask(ctx, a, args.boardId),
  ),
  tool(
    'asterhive_claim',
    '直接认领指定的 Ready 卡（可附文件清单做互斥声明），与他人活跃认领重叠时 409。',
    { taskId: z.string(), files: z.array(z.string()).optional() },
    (ctx, a, args) => claimTask(ctx, a, args.taskId, args.files),
  ),
  tool(
    'asterhive_checkpoint',
    '对正在执行的卡打卡进度（必须 InProgress 且是认领人），并带回所有未达的 @ 消息。',
    { taskId: z.string(), note: z.string() },
    (ctx, a, args) => checkpointTask(ctx, a, args.taskId, args.note),
  ),
  tool(
    'asterhive_submit',
    '完成执行：提交总结与证据文件清单，卡进 Review 并在聊天室自动 @主脑 报告。',
    {
      taskId: z.string(),
      summary: z.string(),
      evidence: z
        .array(
          z.object({
            path: z.string(),
            machine: z.string().optional(),
            note: z.string().optional(),
          }),
        )
        .optional(),
    },
    (ctx, a, args) => submitTask(ctx, a, args.taskId, { summary: args.summary, evidence: args.evidence }),
  ),
  tool(
    'asterhive_release',
    '放弃当前认领（必须 InProgress），卡按依赖状态退回 Ready/Backlog 供他人接管。',
    { taskId: z.string(), reason: z.string().optional() },
    (ctx, a, args) => releaseTask(ctx, a, args.taskId, args.reason),
  ),
  tool(
    'asterhive_message',
    '在指定看板聊天室发言（@句柄 定向投递；默认 kind=progress，用户干预用 intervention）。',
    {
      boardId: z.string(),
      content: z.string(),
      kind: z.enum(MESSAGE_KINDS).optional(),
    },
    (ctx, a, args) =>
      createMessage(ctx, {
        boardId: args.boardId,
        author: a.id,
        kind: args.kind as MessageKind | undefined,
        content: args.content,
      }),
  ),

  // ---- 看板读侧 ----
  tool('asterhive_list_boards', '列出全部看板（id、名称、各泳道 WIP 限制）。', undefined, (ctx) =>
    listBoards(ctx),
  ),
  tool(
    'asterhive_list_tasks',
    '列出指定看板的卡（紧凑视图：id/标题/泳道/优先级/认领人）。要看完整 detail/acceptance 用 asterhive_get_task。',
    {
      boardId: z.string(),
      lane: z.enum(LANES).optional(),
      assignee: z.string().optional(),
    },
    // 紧凑投影：完整任务表可随长文 detail 滚到 MB 级（实测撑爆主脑上下文），列表只回轻字段
    (ctx, _a, args) =>
      listTasks(ctx, args.boardId, { lane: args.lane as Lane, assignee: args.assignee }).map((t) => ({
        id: t.id,
        title: t.title,
        lane: t.lane,
        priority: t.priority,
        assignee: t.assignee,
        deps: t.dependsOn,
      })),
  ),
  tool(
    'asterhive_get_task',
    '按 id 查看单张卡的完整状态（泳道、认领人、依赖、文件清单、证据；长文本字段截断至 2000 字符）。',
    { taskId: z.string() },
    (ctx, _a, args) => {
      const t = getTask(ctx, args.taskId);
      return {
        ...t,
        detail: t.detail?.slice(0, 2000),
        acceptance: t.acceptance?.slice(0, 2000),
      };
    },
  ),
  tool(
    'asterhive_overview',
    '返回全舰队总览：每个 agent 的占用/进度/在线状态与各泳道计数。',
    undefined,
    (ctx) => getOverview(ctx),
  ),

  // ---- 主脑侧：派活（角色由领域层强制，worker 调用得 403）----
  tool(
    'asterhive_create_task',
    '在指定看板立项一张卡（id 形如 T42/BUG-17；默认 Backlog，可带优先级/验收/文件/依赖/工作区）。',
    {
      boardId: z.string(),
      id: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      priority: z.enum(PRIORITIES).optional(),
      acceptance: z.string().optional(),
      files: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional(),
      workspace: z.record(z.string(), z.unknown()).optional(),
    },
    (ctx, _a, args) =>
      createTask(ctx, args.boardId, {
        id: args.id,
        title: args.title,
        detail: args.detail,
        priority: args.priority as Priority | undefined,
        acceptance: args.acceptance,
        files: args.files,
        dependsOn: args.dependsOn,
        workspace: args.workspace as Record<string, unknown> | undefined,
      }),
  ),
  tool(
    'asterhive_match_task',
    'Nomad 风格资源感知调度匹配：结合任务声明的硬件与模型约束，筛选评估最适合的工蜂并给出可解释推荐。',
    { taskId: z.string() },
    (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot query scheduling matches');
      return matchTaskToWorkers(ctx, args.taskId);
    },
  ),
  tool(
    'asterhive_dispatch',
    '主脑分派：给指定卡发指令消息（可选预指派 assignee），一次完成指派 + 房间 @ 消息。',
    {
      taskId: z.string(),
      content: z.string(),
      assignee: z.string().optional(),
    },
    (ctx, a, args) => dispatchTask(ctx, a, args.taskId, { content: args.content, assignee: args.assignee }),
  ),
  tool(
    'asterhive_move_task',
    '移动指定卡到目标泳道（Review→Done 等信任边界仅主脑/用户可操作，worker 会得 403）。',
    { taskId: z.string(), lane: z.enum(LANES) },
    (ctx, a, args) => updateTask(ctx, a, args.taskId, { lane: args.lane as Lane }),
  ),

  // ---- 托管仓库整合工具（仅主脑/用户可调用，worker 403）----
  tool(
    'asterhive_board_repo_status',
    '查询指定看板的代码仓库托管模式与初始化状态（status: empty/queued/running/ready/failed, head, source, error 等），并评估是否需要初始化。',
    { boardId: z.string() },
    (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot inspect repository status');
      const board = getBoard(ctx, args.boardId);
      const mgr = new RepoManager(ctx);
      const status = mgr.status(args.boardId);
      const needsInit = board.repoMode === 'managed' && (status.repoStatus === 'empty' || status.repoStatus === 'failed');
      return {
        boardId: board.id,
        boardName: board.name,
        repoMode: board.repoMode,
        repoStatus: status.repoStatus,
        repoHead: status.repoHead,
        repoSource: board.repoSource || board.repo,
        repoError: status.repoError,
        needsInit,
        advice: needsInit
          ? '项目代码库尚未初始化。请在聊天室询问用户是从远程 Git 仓库（如 GitHub）克隆，还是从本机目录导入。'
          : (status.repoStatus === 'ready' ? '代码库已就绪，可正常开展工蜂开发与审核。' : `代码库正在后台处理中（状态：${status.repoStatus}）。`),
      };
    },
  ),
  tool(
    'asterhive_board_repo_init',
    '对指定看板发起代码库初始化或生成本机导入命令。mode 可选 clone（从远端 git 地址拉取）、empty（建立初始空主仓）、local_import（指导用户从本机目录导入）。',
    {
      boardId: z.string(),
      mode: z.enum(['clone', 'empty', 'local_import']),
      url: z.string().optional(),
    },
    async (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot initialize repositories');
      const board = getBoard(ctx, args.boardId);
      if (board.repoMode !== 'managed') {
        throw new HttpError(409, `看板 ${args.boardId} 为 remote-legacy 模式，仅 managed 看板支持服务端主仓初始化`);
      }
      const mgr = new RepoManager(ctx);
      if (args.mode === 'local_import') {
        const port = process.env.PORT ?? '8067';
        const host = process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1';
        const hiveUrl = `http://${host}:${port}`;
        return {
          mode: 'local_import',
          boardId: board.id,
          instruction: '请用户在拥有项目源码的设备终端中运行以下命令（源码将以 Git bundle 完整历史流式上传到星巢主仓）：',
          command: `node packages/sdk/src/cli.ts repo import --board ${board.id} --path <你的本机项目目录> --url ${hiveUrl}`,
          notes: '若从其他物理设备导入，请将 URL 中的 IP 换为本星巢服务器的局域网 IP。导入前请确保源工作树干净（无未提交修改）。导入成功后服务器主仓将自动就绪。',
        };
      }
      if (args.mode === 'clone') {
        const repoUrl = args.url?.trim() || board.repoSource?.trim() || board.repo?.trim();
        if (!repoUrl) throw new HttpError(422, 'mode=clone 必须提供远程 Git 仓库 URL（如 https://github.com/...）');
        mgr.initialize(board.id, 'clone', repoUrl);
        return {
          mode: 'clone',
          boardId: board.id,
          source: repoUrl,
          status: 'queued',
          message: `已向服务器提交从 ${repoUrl} 克隆初始化的后台任务。可调用 asterhive_board_repo_status 查看进度。`,
        };
      }
      // mode === 'empty'
      mgr.initialize(board.id, 'empty');
      await mgr.waitForJob(board.id);
      const st = mgr.status(board.id);
      return {
        mode: 'empty',
        boardId: board.id,
        status: st.repoStatus,
        message: '已建立初始空仓库。后续可通过工蜂开发提交首个 commit。',
      };
    },
  ),
  tool(
    'asterhive_repo_inspect_task',
    '检查任务分支代码变更（diff/stat 与改动文件列表），仅限 managed 看板中的任务。',
    { taskId: z.string() },
    (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot inspect repository integration state');
      const task = getTask(ctx, args.taskId);
      const mgr = new RepoManager(ctx);
      return mgr.inspectTask(task.boardId, args.taskId);
    },
  ),
  tool(
    'asterhive_repo_integrate_task',
    '验收通过后将任务分支合并至主干（main 分支）。有冲突时返回冲突细节并拒绝合并。',
    { taskId: z.string() },
    async (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot integrate task branches');
      const task = getTask(ctx, args.taskId);
      const mgr = new RepoManager(ctx);
      return await mgr.integrateTask(task.boardId, args.taskId);
    },
  ),

  // ---- 工蜂直接受控诊断与干预工具（Phase 6：仅蜂后/用户可调用，worker 403）----
  tool(
    'asterhive_worker_probe',
    '直接探活并诊断指定工蜂：查询心跳延迟、当前占用任务已耗时、底层受控通道连通度及状态。当工蜂超时或疑似卡死时必须优先调用本工具，严禁建卡派给其他工蜂。',
    { agentId: z.string() },
    (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot probe other workers');
      return probeWorker(ctx, args.agentId);
    },
  ),
  tool(
    'asterhive_worker_restart',
    '通过独立受控通道重启失联或卡死的目标工蜂服务（白名单服务级动作，凭据不暴露）。探活确认失联或长时间无响应时调用。',
    { agentId: z.string(), reason: z.string() },
    (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot restart workers');
      return restartWorkerService(ctx, a, args.agentId, args.reason);
    },
  ),
  tool(
    'asterhive_worker_release_stuck_task',
    '受控强制解除失联/挂起工蜂的任务占用，并将任务回退至 Ready 泳道供重新调度。',
    { agentId: z.string(), taskId: z.string(), reason: z.string().optional() },
    (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot force release tasks');
      return releaseStuckTask(ctx, a, args.agentId, args.taskId, args.reason ?? '蜂后强制解除挂起占用');
    },
  ),

  // ---- 拆解健壮化与所有权推导工具（Phase 7：仅蜂后/用户可调用，worker 403）----
  tool(
    'asterhive_infer_dependencies',
    '依赖自动推导与写冲突分析（Phase 7）：依据任务声明的 writes(files) 与 reads 文件所有权，自动推导缺失的 dependsOn 依赖链并检测并发写冲突。apply=true 时自动批量修补看板任务卡依赖。',
    {
      boardId: z.string(),
      apply: z.boolean().optional(),
    },
    (ctx, a, args) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot infer or modify task dependency graphs');
      return inferAndApplyTaskDependencies(ctx, a, args.boardId, args.apply !== true);
    },
  ),

  // ---- 舰队体检雷达工具（Phase 9：全局算力、停滞预警与干预审计）----
  tool(
    'asterhive_fleet_radar',
    '返回全蜂群舰队体检雷达报告（Phase 9）：包含总工蜂算力池（核心数/内存量/执行内核分布/可用模型去重）、活跃任务停滞僵死风险预警及最近受控干预恢复历史。',
    undefined,
    (ctx, a) => {
      if (a.role === 'worker') throw new HttpError(403, 'workers cannot query fleet radar');
      return getFleetRadar(ctx);
    },
  ),
];

export const TOOL_NAMES = TOOL_DEFS.map((d) => d.name);
