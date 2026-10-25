// 单用户模型·零令牌终态（2026-10-25 用户终裁）：浏览器端不携带任何凭据，
// 服务器把无 Bearer 的请求一律视为唯一用户（本模块确保该身份恒存在）。
// "用户名"只是显示名（agent.handle/name）；不存在签发、轮换、保存 token 的任何流程。
// token 仅属于 agent（worker/主脑/内置脑）的身份归属，与用户无关。
import { randomBytes } from 'node:crypto';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { withWrite, logEvent } from './write.ts';
import { assertValidHandle, findAgent, hashToken, type Agent } from './agents.ts';

// 单一用户的固定 agent id。作者为 'user' 的聊天室消息与本身份天然同源。
export const USER_AGENT_ID = 'user';

export interface UserStatus {
  /** 当前用户名；未设置过时为 null（身份仍存在，用默认名） */
  handle: string | null;
  configured: boolean;
}

// GET /api/user（公开）：设置页回填用户名。
export function getUserStatus(ctx: Ctx): UserStatus {
  const u = findAgent(ctx, USER_AGENT_ID);
  return { handle: u?.handle === USER_AGENT_ID ? null : (u?.handle ?? null), configured: !!u && u.handle !== USER_AGENT_ID };
}

// 恒等地确保唯一用户身份存在（匿名请求的 actor 落点）。
// 首次创建时顺带清理旧多用户时代的遗留 user 行（直接删除，2026-10-25 决策）。
export function ensureUserAgent(ctx: Ctx): Agent {
  const existing = findAgent(ctx, USER_AGENT_ID);
  if (existing) return existing;
  withWrite(ctx, 'user.ensure', () => {
    const legacy = ctx.holder.db
      .prepare("SELECT id, handle FROM agent WHERE role = 'user'")
      .all() as { id: string; handle: string }[];
    for (const m of legacy) {
      ctx.holder.db.prepare('DELETE FROM agent WHERE id = ?').run(m.id);
    }
    ctx.holder.db
      .prepare(
        "INSERT INTO agent (id, name, handle, role, token_hash, enabled, created_at) VALUES (?, ?, ?, 'user', ?, 1, ?)",
      )
      // token_hash 填不可猜随机值且永不签发——该身份不走 token 认证
      .run(USER_AGENT_ID, '用户', USER_AGENT_ID, hashToken('ah_never_issued_' + randomBytes(24).toString('hex')), Date.now());
    if (legacy.length > 0) {
      logEvent(ctx, 'user.migrated_cleaned', { agents: legacy });
    }
  });
  return findAgent(ctx, USER_AGENT_ID)!;
}

// PUT /api/user：只改用户名（显示名）。没有 token 概念。
export function renameUser(ctx: Ctx, input: { handle?: string }): { handle: string } {
  ensureUserAgent(ctx);
  const handle = assertValidHandle(input.handle ?? '');
  const taken = ctx.holder.db
    .prepare('SELECT 1 FROM agent WHERE handle = ? AND id != ?')
    .get(handle, USER_AGENT_ID);
  if (taken) throw new HttpError(409, `handle already taken: ${handle}`);
  withWrite(ctx, 'user.rename', () => {
    ctx.holder.db
      .prepare('UPDATE agent SET name = ?, handle = ? WHERE id = ?')
      .run(`用户 ${handle}`, handle, USER_AGENT_ID);
    logEvent(ctx, 'user.configured', { handle });
  });
  return { handle };
}
