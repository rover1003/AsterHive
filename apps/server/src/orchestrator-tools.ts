// 星巢协议工具的单一事实源（T14 重构）：
// MCP 服务端（mcp.ts）与内置主脑（brain.ts）共用同一张定义表——
// 名称/描述/zod 参数 schema/执行函数只在此处维护，两侧各自生成自己的注册形态。
// 约束：全表 15 个工具，全部是"看板/聊天室协议动词"，绝不包含 shell/文件/浏览器
// 执行面——主脑侧只注册这张表，结构性保证"只分派不执行"。
import { z } from 'zod';
import type { ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { Ctx } from './types.ts';
import type { Agent } from './agents.ts';
import {
  listBoards,
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
    '列出指定看板的卡，可按泳道（lane）与认领人（assignee）过滤。',
    {
      boardId: z.string(),
      lane: z.enum(LANES).optional(),
      assignee: z.string().optional(),
    },
    (ctx, _a, args) => listTasks(ctx, args.boardId, { lane: args.lane as Lane, assignee: args.assignee }),
  ),
  tool(
    'asterhive_get_task',
    '按 id 查看单张卡的完整状态（泳道、认领人、依赖、文件清单、证据）。',
    { taskId: z.string() },
    (ctx, _a, args) => getTask(ctx, args.taskId),
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
];

export const TOOL_NAMES = TOOL_DEFS.map((d) => d.name);
