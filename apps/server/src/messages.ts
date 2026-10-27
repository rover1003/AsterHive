import type { Ctx } from './types.ts';
import { HttpError, assertNoMojibake } from './types.ts';
import { withWrite, logEvent } from './write.ts';
import { getTask, getParticipants } from './tasks.ts';
import { findAgent, type Agent } from './agents.ts';

export type MessageKind =
  | 'dispatch'
  | 'submit'
  | 'progress'
  | 'intervention'
  | 'question'
  | 'report'
  | 'system';

export interface Message {
  id: number;
  boardId: string;
  author: string;
  kind: MessageKind;
  mentions: string[];
  taskRef: string | null;
  content: string;
  createdAt: number;
}

type MessageRow = {
  id: number;
  board_id: string;
  author: string;
  kind: MessageKind;
  mentions: string;
  task_ref: string | null;
  content: string;
  created_at: number;
};

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    boardId: r.board_id,
    author: r.author,
    kind: r.kind,
    mentions: JSON.parse(r.mentions) as string[],
    taskRef: r.task_ref,
    content: r.content,
    createdAt: r.created_at,
  };
}

// @ 句柄机械解析（§6）：服务器只解析 @词元并投递，语义理解在被 @ 的 agent 那里。
// 蜂后 Queen 别名投递给全部 orchestrator；工蜂使用具体句柄定向。
const MENTION_RE = /@([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)/g;

export const QUEEN_ALIASES = new Set(['主脑', '蜂后', 'queen', 'Queen']);
export function isQueenMention(mention: string): boolean {
  return QUEEN_ALIASES.has(mention);
}


export function parseMentions(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(MENTION_RE)) out.add(m[1]);
  return [...out];
}

// 任务号机械识别并挂 taskRef（点击跳卡片）：取消息中第一个真实存在的任务 id
const TASK_REF_RE = /\b([A-Z][A-Z0-9]*-?\d+)\b/g;

function detectTaskRef(ctx: Ctx, content: string): string | null {
  for (const m of content.matchAll(TASK_REF_RE)) {
    try {
      getTask(ctx, m[1]);
      return m[1];
    } catch {
      // 不存在的编号跳过
    }
  }
  return null;
}

export function listMessages(
  ctx: Ctx,
  boardId: string,
  opts: { since?: number; limit?: number } = {},
): Message[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = ctx.holder.db
    .prepare('SELECT * FROM message WHERE board_id = ? AND id > ? ORDER BY id DESC LIMIT ?')
    .all(boardId, opts.since ?? 0, limit) as MessageRow[];
  return rows.map(rowToMessage).reverse();
}

// 内层插入（不自行开事务）：供 createMessage 与 submitTask 等在同一事务内复用
function messageInner(
  ctx: Ctx,
  input: { boardId: string; author: string; kind: MessageKind; content: string; mentions?: string[] },
): Message {
  const mentions = input.mentions ?? parseMentions(input.content);
  const taskRef = detectTaskRef(ctx, input.content);
  const now = Date.now();
  const result = ctx.holder.db
    .prepare(
      'INSERT INTO message (board_id, author, kind, mentions, task_ref, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(input.boardId, input.author, input.kind, JSON.stringify(mentions), taskRef, input.content, now);
  const id = Number(result.lastInsertRowid);
  logEvent(ctx, 'message.created', {
    messageId: id,
    boardId: input.boardId,
    author: input.author,
    kind: input.kind,
    mentions,
    taskRef,
    content: input.content,
  });
  return {
    id,
    boardId: input.boardId,
    author: input.author,
    kind: input.kind,
    mentions,
    taskRef,
    content: input.content,
    createdAt: now,
  };
}

// 无 token 的发言者按 'user' 处理（LAN MVP；Web 会话鉴权随 T10 落地）
export function createMessage(
  ctx: Ctx,
  input: { boardId: string; author: string; kind?: MessageKind; content: string },
): Message {
  if (!input.content?.trim()) throw new HttpError(422, 'content required');
  assertNoMojibake(input.content, 'content');
  const kind =
    input.kind ?? (input.author === 'user' ? 'intervention' : 'progress');
  return withWrite(ctx, 'message.create', () =>
    messageInner(ctx, { ...input, kind, content: input.content.trim() }),
  );
}

// 定向投递查询（@ 句柄机械路由的读取面）：
// - 消息 @ 了该 agent 的句柄；
export function inboxFor(ctx: Ctx, agent: Agent, since: number): Message[] {
  const rows = ctx.holder.db
    .prepare('SELECT * FROM message WHERE id > ? ORDER BY id LIMIT 500')
    .all(since) as MessageRow[];
  const wanted = rows.filter((r) => {
    const mentions = JSON.parse(r.mentions) as string[];
    if (mentions.includes(agent.handle)) return true;
    if (agent.role === 'orchestrator' && mentions.some(isQueenMention)) return true;
    if (agent.role === 'orchestrator' && r.author === 'user' && mentions.length === 0) return true;
    return false;
  });
  return wanted.map(rowToMessage);
}

// 分派双通道（§6）：一次调用完成任务指派 + 房间 @ 消息（主脑的结构化分派工具）
export function dispatchTask(
  ctx: Ctx,
  actor: Agent,
  taskId: string,
  input: { content: string; assignee?: string },
): { task: ReturnType<typeof getTask>; message: Message } {
  if (actor.role !== 'orchestrator' && actor.role !== 'user') {
    throw new HttpError(403, 'only orchestrator/user dispatch');
  }
  const task = getTask(ctx, taskId);
  if (task.status === 'cancelled') throw new HttpError(409, `task ${taskId} is cancelled`);
  const assignee = input.assignee?.trim() || task.assignee;
  // 参与限制：被派者是 worker 且该板参与者列表非空时，必须在列表内（user/orchestrator 豁免）
  const assigneeAgent = findAgent(ctx, assignee);
  if (assigneeAgent?.role === 'worker') {
    const list = getParticipants(ctx, task.boardId);
    if (list.length > 0 && !list.includes(assigneeAgent.id)) {
      throw new HttpError(422, 'assignee not a participant');
    }
  }
  return withWrite(ctx, 'task.dispatch', () => {
    const now = Date.now();
    ctx.holder.db
      .prepare('UPDATE task SET assignee = ?, updated_at = ? WHERE id = ?')
      .run(assignee, now, taskId);
    logEvent(ctx, 'task.dispatched', { taskId, by: actor.id, assignee });
    const message = messageInner(ctx, {
      boardId: task.boardId,
      author: actor.id,
      kind: 'dispatch',
      content: input.content.trim(),
    });
    return { task: getTask(ctx, taskId), message };
  });
}

export { messageInner };
