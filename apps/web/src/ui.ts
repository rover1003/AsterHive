// 共享 UI 小件：转义、时间、agent 角色缓存
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export const LANE_LABELS: Record<string, string> = {
  Backlog: '待办 Backlog',
  Ready: '就绪 Ready',
  InProgress: '进行 InProgress',
  Review: '待审 Review',
  Done: '完成 Done',
};

export const KIND_LABELS: Record<string, string> = {
  dispatch: '派活',
  submit: '上交',
  progress: '进度',
  intervention: '干预',
  question: '提问',
  report: '汇报',
  system: '系统',
};

export const PRIORITY_CLASS: Record<string, string> = {
  P0: 'p0',
  P1: 'p1',
  P2: 'p2',
};

// agent 缓存：给消息作者上角色色（user=琥珀 / orchestrator=紫 / worker=蓝 / system=灰）
import { api, cachedUserName, type Agent } from './api.ts';

let agentCache: Agent[] = [];
let agentCacheAt = 0;

export async function agentsCached(): Promise<Agent[]> {
  if (Date.now() - agentCacheAt > 10_000) {
    try {
      const r = await api.get<{ agents: Agent[] }>('/agents');
      agentCache = r.agents;
      agentCacheAt = Date.now();
    } catch {
      /* 离线时用旧缓存 */
    }
  }
  return agentCache;
}

export function roleOf(author: string, agents: Agent[]): string {
  if (author === 'user') return 'user';
  if (author === 'system') return 'system';
  return agents.find((a) => a.id === author)?.role ?? 'worker';
}

export function displayAuthor(author: string, agents: Agent[]): string {
  if (author === 'user') {
    // 单用户模型：作者 'user' 即本人（匿名发言与 user 身份发言同 id）；
    // 用户名来自 GET /api/user 的 localStorage 缓存（应用启动时刷新）。
    const name = cachedUserName();
    return name ? `我（${name}）` : '我';
  }
  if (author === 'system') return '系统';
  const a = agents.find((x) => x.id === author);
  return a ? `${a.name} (@${a.handle})` : author;
}

export function toast(msg: string, isError = false): void {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
