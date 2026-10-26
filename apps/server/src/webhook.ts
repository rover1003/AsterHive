import type { Ctx } from './types.ts';
import { HttpError, assertNoMojibake } from './types.ts';
import { listBoards } from './tasks.ts';
import { createMessage, type Message } from './messages.ts';
import { logEvent } from './write.ts';

export interface ChatToCardInput {
  content: string;
  boardId?: string;
  source?: string;
  author?: string;
  autoDispatch?: boolean;
}

export interface ChatToCardResult {
  ok: boolean;
  boardId: string;
  message: Message;
  source: string;
  author: string;
}

/**
 * Chat-to-Card 多端无感派活 Webhook（Phase 8）：
 * 允许手机快捷指令、机器人回调、外部自动化以极简 HTTP POST 发送一句话。
 * 自动识别目标看板，以用户身份注入聊天室，并无缝触发蜂后的意图澄清与自动建卡分派。
 */
export async function handleChatToCard(ctx: Ctx, input: ChatToCardInput): Promise<ChatToCardResult> {
  const rawContent = (input.content ?? '').trim();
  if (!rawContent) {
    throw new HttpError(422, 'content required: 发送内容不可为空');
  }
  assertNoMojibake(rawContent, 'content');

  // 1. 目标看板确定：显式指定 或 自动回退至第一个可用看板
  let boardId = input.boardId?.trim();
  if (!boardId) {
    const boards = listBoards(ctx);
    if (boards.length === 0) {
      throw new HttpError(404, 'no boards available: 服务器暂无可用看板，请先在星巢建板');
    }
    boardId = boards[0].id;
  }

  // 2. 发送者与来源标识
  const source = input.source?.trim() || 'webhook';
  const author = input.author?.trim() || 'user';
  assertNoMojibake(source, 'source');
  assertNoMojibake(author, 'author');

  // 内容前缀带上来源标签，便于蜂后与界面清晰辨识多端输入
  const formattedContent = source && source !== 'webhook'
    ? `[来自 ${source}] ${rawContent}`
    : rawContent;

  // 3. 注入看板聊天室：以 intervention（用户干预/指令）类型发送，默认直接唤醒蜂后
  const message = createMessage(ctx, {
    boardId,
    author,
    kind: 'intervention',
    content: formattedContent,
  });

  logEvent(ctx, 'webhook.chat_to_card', {
    boardId,
    messageId: message.id,
    source,
    author,
    content: rawContent,
  });

  return {
    ok: true,
    boardId,
    message,
    source,
    author,
  };
}
