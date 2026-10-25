// 应用外壳：侧栏导航（含项目子导航）+ hash 路由 + 视图挂载（每个视图自带挂载与清理）
import { startSse, subscribe, onConnectionState } from './sse.ts';
import { esc, toast } from './ui.ts';
import { icon } from './icons.ts';
import { api, refreshUserCache, type Board } from './api.ts';

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
    viewHost.innerHTML = `<div class="empty">视图加载失败：${esc(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

function renderShell(): void {
  teardownFleetDrawer(); // 壳重建会连带重建抽屉挂点：先退订 SSE/清计时器，防止泄漏
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand">${icon.hive} AsterHive<span>星巢</span></div>
      <nav></nav>
      <div class="conn" id="conn-state"><span class="dot"></span>连接中</div>
    </aside>
    <main class="main" id="view-host"></main>
    <div id="fleet-drawer-host"></div>
  `;
  viewHost = document.getElementById('view-host');
  renderNav();
}

// ---- Agent 总览抽屉：全局浮层，从侧栏「Agent 总览」直接唤出，不占路由 ----
// 内容复用 fleet 视图的 renderFleetInto（数据拉取 + SSE 刷新 + 30s 兜底轮询），
// 关闭时 destroy 退订；当前页面（通常是聊天工作台）与其 SSE 订阅完全不受影响。
// 挂点 #fleet-drawer-host 与 board.ts 的 #drawer-host 同模式，但挂在 app 级（跨视图常驻）。

let fleetDrawerOpen = false;                                  // 抽屉开关态（含打开中：防重复点击 + 导航高亮）
let fleetDrawerHandle: { destroy: () => void } | null = null; // 内容句柄（renderFleetInto 返回）
let fleetEscHandler: ((ev: KeyboardEvent) => void) | null = null;
let fleetDrawerSeq = 0; // 打开序号：快速 关闭→重开 时丢弃在途旧打开的续体，防旧句柄覆盖新句柄导致订阅泄漏

/** 仅拆订阅与监听，不动 DOM / 导航（renderShell 重建壳前调用，防泄漏） */
function teardownFleetDrawer(): void {
  fleetDrawerOpen = false;
  fleetDrawerHandle?.destroy(); // 退订 SSE / 清刷新计时器
  fleetDrawerHandle = null;
  if (fleetEscHandler) {
    window.removeEventListener('keydown', fleetEscHandler);
    fleetEscHandler = null;
  }
}

/** 关闭抽屉：销毁内容 + 清空挂点 + 导航高亮恢复当前路由项 */
function closeFleetDrawer(): void {
  if (!fleetDrawerOpen) return;
  teardownFleetDrawer();
  const host = document.getElementById('fleet-drawer-host');
  if (host) host.innerHTML = '';
  renderNav();
}

/** 唤出抽屉：写入 mask + aside 壳并绑好关闭途径（mask / 关闭按钮 / ESC），内容异步补齐 */
async function openFleetDrawer(): Promise<void> {
  if (fleetDrawerOpen) return; // 已开（含打开中）：忽略重复点击
  const host = document.getElementById('fleet-drawer-host');
  if (!host) return;
  const seq = ++fleetDrawerSeq;
  fleetDrawerOpen = true;
  // 先同步铺壳，内容区交给 fleet 视图的 renderFleetInto（懒加载，与 #/fleet 路由共用同一 chunk）
  host.innerHTML = `
    <div class="drawer-mask" id="fleet-mask"></div>
    <aside class="drawer fleet-drawer" aria-label="Agent 总览">
      <div class="drawer-head">
        <h3>${icon.hive} Agent 总览</h3>
        <button class="icon-btn" id="fleet-drawer-close" title="关闭">${icon.x}</button>
      </div>
      <div class="fleet-drawer-body" id="fleet-drawer-body"></div>
    </aside>`;
  host.querySelector('#fleet-mask')!.addEventListener('click', closeFleetDrawer);
  host.querySelector('#fleet-drawer-close')!.addEventListener('click', closeFleetDrawer);
  fleetEscHandler = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeFleetDrawer();
  };
  window.addEventListener('keydown', fleetEscHandler);
  renderNav(); // 「Agent 总览」立即高亮
  try {
    const mod = await import('./views/fleet.ts');
    // 打开在途期间已被关闭或又被重开：这次续体作废（新打开会自己装配内容）
    if (!fleetDrawerOpen || seq !== fleetDrawerSeq) return;
    fleetDrawerHandle = mod.renderFleetInto(document.getElementById('fleet-drawer-body')!);
  } catch (err) {
    toast(`Agent 总览加载失败：${err instanceof Error ? err.message : String(err)}`, true);
    closeFleetDrawer();
  }
}

// ---- 项目化导航：「项目」下缩进列出各项目（看板=项目），聊天室已并入项目工作台 ----

// 看板列表缓存：启动拉取，board.* 事件后重拉；renderNav 只依赖此缓存与路由/当前板
let boardsCache: Board[] = [];

// 可重入的 nav 渲染：事件/路由/当前板变化时只重建侧栏 nav 区，
// 不整壳重建（避免打断当前视图的消息流与 SSE 订阅）
function renderNav(): void {
  const nav = document.querySelector('.sidebar nav');
  if (!nav) return;
  const route = currentRoute();
  // 抽屉开着时，导航语境整体切到「Agent 总览」；关闭后恢复按当前路由高亮
  const activeRoute = fleetDrawerOpen ? '#/fleet' : route;
  const curBoard = localStorage.getItem('asterhive.board') ?? '';
  const top = Object.entries(ROUTES)
    .map(([hash, def]) => {
      const item = `<a class="nav-item${hash === activeRoute ? ' active' : ''}" data-nav="${hash}" href="${hash}"><span class="icon">${def.icon}</span>${def.label}</a>`;
      // 仅「项目」入口下挂项目子列表；高亮 = 路由落在项目工作台 且 子项=当前板
      if (hash === '#/board') {
        const subs = boardsCache
          .map(
            (b) =>
              `<a class="nav-sub-item${activeRoute === hash && b.id === curBoard ? ' active' : ''}" data-board="${esc(b.id)}" href="#/board?board=${esc(b.id)}" title="${esc(b.name)}">${esc(b.name)}</a>`,
          )
          .join('');
        return `${item}<div class="nav-sub">${subs}</div>`;
      }
      return item;
    })
    .join('');
  nav.innerHTML = top;
  // 子项点击：直达项目工作台并带 ?board=（board 视图读参写入 localStorage，链接可直接分享）
  nav.querySelectorAll<HTMLAnchorElement>('.nav-sub-item').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate(`#/board?board=${a.dataset.board!}`);
    });
  });
  // 「Agent 总览」不走 hash 路由：点击唤出全局抽屉，当前页面不被打断
  //（#/fleet 深链仍走整页视图，见下方 ROUTES/mount）
  nav.querySelector<HTMLAnchorElement>('a[data-nav="#/fleet"]')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    void openFleetDrawer();
  });
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
  startSse();
  // 单用户模型：启动即拉取并缓存"用户名"（displayAuthor 显示 我（用户名） 用）
  void refreshUserCache();
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
  });
  window.addEventListener('hashchange', () => {
    closeFleetDrawer(); // 路由切换先收起抽屉（内部会 renderNav，恢复路由项高亮）
    if (!document.getElementById('view-host')) renderShell();
    renderNav();
    void mount();
  });
  void mount();
}

main();
