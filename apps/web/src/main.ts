// 应用外壳：侧栏导航（含项目 / Agent 总览两组子导航）+ hash 路由 + 视图挂载（每个视图自带挂载与清理）
import { startSse, subscribe, onConnectionState } from './sse.ts';
import { esc } from './ui.ts';
import { icon } from './icons.ts';
import { api, refreshUserCache, type Board, type Overview, type AgentOverview } from './api.ts';

export interface View {
  label: string;
  icon: string;
  render: (el: HTMLElement) => Promise<void> | void;
}

interface ViewModule {
  render: (el: HTMLElement) => Promise<void> | void;
}

// 聊天室已并入项目工作台（board 视图左栏主舞台），无独立路由。
// 导航图标全部用内联 SVG（icons.ts），不再使用 emoji。
const ROUTES: Record<string, { label: string; icon: string; load: () => Promise<ViewModule> }> = {
  '#/board': { label: '项目', icon: icon.folder, load: () => import('./views/board.ts') },
  '#/fleet': { label: 'Agent 总览', icon: icon.hive, load: () => import('./views/fleet.ts') },
  '#/agents': { label: 'Agent 接入', icon: icon.plug, load: () => import('./views/agents.ts') },
  '#/settings': { label: '设置', icon: icon.gear, load: () => import('./views/settings.ts') },
  '#/audit': { label: '审计', icon: icon.list, load: () => import('./views/audit.ts') },
};

let currentCleanup: (() => void) | null = null;
let viewHost: HTMLElement | null = null;

export function currentRoute(): string {
  const hash = location.hash || '#/board';
  return hash.split('?')[0];
}

export function currentQuery(): URLSearchParams {
  const idx = location.hash.indexOf('?');
  return new URLSearchParams(idx >= 0 ? location.hash.slice(idx + 1) : '');
}

// 旧「聊天室」路由下线：#/room 与 #/room?... 一律重定向到 #/board（原样保留 board/reply 等参数），
// 旧链接/收藏不 404。返回是否触发了重写（触发时调用方应放弃本次挂载，等 hashchange 带新路由再来）。
function normalizeHash(): boolean {
  if (location.hash === '#/room' || location.hash.startsWith('#/room?')) {
    // location.replace：只换 fragment 且不追加历史记录（返回键不会退回死路由）
    location.replace(location.hash.replace(/^#\/room/, '#/board'));
    return true;
  }
  return false;
}

async function mount(): Promise<void> {
  if (normalizeHash()) return; // 触发重定向：hashchange 会以 #/board 再进来
  const route = currentRoute();
  const def = ROUTES[route] ?? ROUTES['#/board'];
  if (!viewHost) return;
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  viewHost.innerHTML = `<div class="loading">加载中…</div>`;
  try {
    const mod = await def.load();
    viewHost.innerHTML = '';
    const viewEl = document.createElement('div');
    viewEl.className = 'view';
    viewHost.appendChild(viewEl);
    // 视图可通过挂载元素上的 __cleanup 钩子登记清理逻辑
    await mod.render(viewEl);
    currentCleanup = () => {
      const fn = (viewEl as unknown as { __cleanup?: () => void }).__cleanup;
      if (fn) fn();
    };
  } catch (err) {
    // 部署后旧 index.html 引用已不存在的 chunk → 动态导入 404：自动整页重载拿最新壳
    // （sessionStorage 防死循环：一次会话只自动重载一次，再失败就真报错）
    const stale = err instanceof Error && /fetch|import|dynamically|404|Failed/i.test(err.message);
    const key = 'asterhive.chunk-reloaded';
    if (stale && !sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      location.reload();
      return;
    }
    viewHost.innerHTML = `<div class="empty">视图加载失败：${esc(err instanceof Error ? err.message : String(err))}${
      stale ? '<br/>提示：服务可能刚更新过，请 Ctrl+F5 强制刷新。' : ''
    }</div>`;
  }
}

function renderShell(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand">${icon.hive} AsterHive<span>星巢</span></div>
      <nav></nav>
      <div class="conn" id="conn-state"><span class="dot"></span>连接中</div>
    </aside>
    <main class="main" id="view-host"></main>
  `;
  viewHost = document.getElementById('view-host');
  renderNav();
}

// ---- 项目化导航：「项目」下缩进列出各项目（看板=项目），聊天室已并入项目工作台；
// 「Agent 总览」同为可展开组：主项只切换展开态不进路由，展开后缩进列出各 agent
//（状态点 + 名字），点击子项进 fleet 整页并 ?agent= 定位高亮 ----

// 看板列表缓存：启动拉取，board.* 事件后重拉；renderNav 只依赖此缓存与路由/当前板
let boardsCache: Board[] = [];

// Agent 列表缓存：启动拉取，状态相关 SSE 事件 debounce 500ms 重拉 + 30s 兜底轮询；
// 事件刷新走轻量路径只重写子项区（#nav-agents-sub），不整栏重渲，防状态点/文字闪烁
let agentsCache: AgentOverview[] = [];

// 「Agent 总览」组展开态记忆：默认展开（localStorage 只在收起时存 '0'）
function agentsNavOpen(): boolean {
  return localStorage.getItem('asterhive.navAgentsOpen') !== '0';
}

// Agent 子项行：状态点 + 名字（语义色沿用 fleet 卡片的 .status-dot：working/stale=warn、
// idle=ok、disabled/offline=dot-idle）；title 悬停给 @handle · host · 当前任务
function agentSubsHtml(route: string, curAgent: string): string {
  return agentsCache
    .map((a) => {
      const taskTitle = a.currentTask ? a.currentTask.title : '空闲——未占用任务';
      const title = `@${a.handle}${a.host ? ` · ${a.host}` : ''} · ${taskTitle}`;
      return `<a class="nav-sub-item nav-agent-item${route === '#/fleet' && a.id === curAgent ? ' active' : ''}" data-agent="${esc(a.id)}" title="${esc(title)}"><span class="status-dot ${a.status}"></span><span class="nav-agent-name">${esc(a.name)}</span></a>`;
    })
    .join('');
}

// Agent 子项点击：进 fleet 整页并带 ?agent=（fleet 视图读参定位高亮对应卡片）
function bindAgentSubs(scope: ParentNode): void {
  scope.querySelectorAll<HTMLAnchorElement>('.nav-agent-item').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      location.hash = `#/fleet?agent=${a.dataset.agent!}`;
    });
  });
}

// 可重入的 nav 渲染：事件/路由/当前板变化时只重建侧栏 nav 区，
// 不整壳重建（避免打断当前视图的消息流与 SSE 订阅）
function renderNav(): void {
  const nav = document.querySelector('.sidebar nav');
  if (!nav) return;
  const route = currentRoute();
  const curBoard = localStorage.getItem('asterhive.board') ?? '';
  const curAgent = currentQuery().get('agent') ?? '';
  const open = agentsNavOpen();
  const top = Object.entries(ROUTES)
    .map(([hash, def]) => {
      // 仅「Agent 总览」主项 = 可展开组开关：无 href，点击只切换展开态不进路由
      //（fleet 整页改由子项深链进入，#/fleet 直链仍可收藏）
      if (hash === '#/fleet') {
        const item = `<a class="nav-item${hash === route ? ' active' : ''}" data-agents-toggle title="展开/收起 Agent 列表"><span class="icon">${def.icon}</span>${def.label}<span class="chev${open ? ' open' : ''}">${icon.chevron}</span></a>`;
        if (!open) return item;
        const subs = agentSubsHtml(route, curAgent) || '<div class="nav-agents-empty">尚无 agent 注册</div>';
        return `${item}<div class="nav-sub" id="nav-agents-sub">${subs}</div>`;
      }
      const item = `<a class="nav-item${hash === route ? ' active' : ''}" data-nav="${hash}" href="${hash}"><span class="icon">${def.icon}</span>${def.label}</a>`;
      // 仅「项目」入口下挂项目子列表；高亮 = 路由落在项目工作台 且 子项=当前板
      if (hash === '#/board') {
        const subs = boardsCache
          .map(
            (b) =>
              `<a class="nav-sub-item${route === hash && b.id === curBoard ? ' active' : ''}" data-board="${esc(b.id)}" href="#/board?board=${esc(b.id)}" title="${esc(b.name)}">${esc(b.name)}</a>`,
          )
          .join('');
        return `${item}<div class="nav-sub">${subs}</div>`;
      }
      return item;
    })
    .join('');
  nav.innerHTML = top;
  // 项目子项点击：直达项目工作台并带 ?board=（board 视图读参写入 localStorage，链接可直接分享）
  //（只绑 data-board：Agent 子项同为 .nav-sub-item 变体，走上方 bindAgentSubs）
  nav.querySelectorAll<HTMLAnchorElement>('.nav-sub-item[data-board]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate(`#/board?board=${a.dataset.board!}`);
    });
  });
  // 「Agent 总览」主项点击：切换展开态并记忆（不进路由）
  nav.querySelector<HTMLAnchorElement>('a[data-agents-toggle]')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    localStorage.setItem('asterhive.navAgentsOpen', agentsNavOpen() ? '0' : '1');
    renderNav();
  });
  bindAgentSubs(nav);
}

// 拉取 Agent 列表并只更新子项区；失败静默（保留上次缓存，整页 fleet 视图有自己的错误提示）
async function loadAgents(): Promise<void> {
  try {
    agentsCache = (await api.get<Overview>('/overview')).agents;
  } catch {
    return;
  }
  renderAgentSubs();
}

// 轻量刷新：只重写 Agent 子项区（不整栏重渲，防闪烁）；
// 组收起或壳未就绪时跳过 DOM——缓存已更新，下次 renderNav 自然带上
function renderAgentSubs(): void {
  const box = document.getElementById('nav-agents-sub');
  if (!box) return;
  const route = currentRoute();
  const curAgent = currentQuery().get('agent') ?? '';
  box.innerHTML = agentSubsHtml(route, curAgent) || '<div class="nav-agents-empty">尚无 agent 注册</div>';
  bindAgentSubs(box);
}

// 状态事件 → 重拉 /overview：debounce 500ms 合并突发（一次任务流转会连发多条事件）
let agentsReloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAgentsReload(): void {
  if (agentsReloadTimer !== null) clearTimeout(agentsReloadTimer);
  agentsReloadTimer = setTimeout(() => {
    agentsReloadTimer = null;
    void loadAgents();
  }, 500);
}

/** 供视图在切换当前板后同步侧栏高亮（board 的 ?board= 与切板下拉） */
export function refreshNav(): void {
  renderNav();
}

/** 编程式导航：同 hash 也强制重挂载（如项目子导航切板后刷新当前视图） */
export function navigate(hash: string): void {
  if (location.hash === hash) {
    void mount();
  } else {
    location.hash = hash;
  }
}

// 拉取看板列表并刷新项目子导航；失败静默（离线时无子导航，视图自身有错误提示）
async function loadBoards(): Promise<void> {
  try {
    boardsCache = (await api.get<{ boards: Board[] }>('/boards')).boards;
  } catch {
    return;
  }
  renderNav();
}

function main(): void {
  renderShell();
  void loadBoards(); // 项目子导航数据异步补齐（首帧不阻塞）
  void loadAgents(); // Agent 子导航数据异步补齐（首帧不阻塞）
  startSse();
  // 单用户模型：启动即拉取并缓存"用户名"（displayAuthor 显示 我（用户名） 用）
  void refreshUserCache();
  // Agent 子导航兜底轮询：SSE 漏事件（断线窗口期）也能最终一致；nav 常驻，计时器随壳存活
  setInterval(() => void loadAgents(), 30_000);
  onConnectionState((connected) => {
    const el = document.getElementById('conn-state');
    if (el) {
      el.innerHTML = `<span class="dot ${connected ? 'on' : 'off'}"></span>${connected ? '实时在线' : '连接中断'}`;
    }
  });
  // 视图失效刷新：全局订阅（视图自身的订阅在各自模块内）
  subscribe((type) => {
    // 项目子导航跟随看板增删改：只重建 nav 区，不动当前视图
    if (type === 'board.created' || type === 'board.updated' || type === 'board.deleted') {
      void loadBoards();
    }
    // Agent 子导航跟随状态事件（任务流转 / agent 上下线 / 主脑回合起止）：
    // debounce 500ms 重拉 /overview，只更新子项区不整栏重渲
    if (type.startsWith('task.') || type.startsWith('agent.') || type.startsWith('brain.turn_')) {
      scheduleAgentsReload();
    }
  });
  window.addEventListener('hashchange', () => {
    if (!document.getElementById('view-host')) renderShell();
    renderNav();
    void mount();
  });
  void mount();
}

main();
