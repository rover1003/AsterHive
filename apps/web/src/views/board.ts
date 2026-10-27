// 项目工作台：聊天主舞台（左，主操作面）+ 看板横向条带监视栏（右，状态面）
// 看板不再是五列竖排：五条水平 lane-strip 纵向堆叠，每条内卡片横向滚动；
// 详情抽屉（任务消息子流 / 泳道迁移 / 建卡）+ 看板管理抽屉（元数据 / 参与者 / 删除）
import { api, type Agent, type Board, type Task, type Message, type RepoTaskDiff } from '../api.ts';
import { subscribe } from '../sse.ts';
import { esc, fmtTime, LANE_LABELS, PRIORITY_CLASS, toast } from '../ui.ts';
import { icon } from '../icons.ts';
import { currentQuery, refreshNav } from '../main.ts';
import { mountChatPanel, type ChatPanelHandle } from './room.ts';

const LANES = ['Backlog', 'Ready', 'InProgress', 'Review', 'Done'] as const;
const DEFAULT_WIP: Record<string, number> = { InProgress: 3, Review: 3 };
// 两栏常驻不可收起（用户终裁 2026-10-25）；窄屏 <1000px 看板栏变右侧 overlay
// （断点数值见 styles.css 的 @media (max-width: 999px)，页头「看板」开关仅窄屏显示）

let currentBoard = localStorage.getItem('asterhive.board') ?? '';

// Keep destructive action handling above per-render closures: the SPA can replace an
// entire view while an async drawer open is resolving, leaving its delegated root detached.
document.addEventListener('click', async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('[data-cancel-task]')
    : null;
  if (!button || !button.isConnected) return;
  event.preventDefault();
  event.stopPropagation();
  const id = button.dataset.cancelTask;
  if (!id) return;
  if (!window.confirm(`删除任务卡 ${id}？\n\n任务将标记为取消并从看板移除。历史与证据保留，已合并代码不会回滚，依赖不会自动释放。`)) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await api.post(`/tasks/${encodeURIComponent(id)}/cancel`, { reason: '用户在看板详情中取消' });
    window.location.reload();
  } catch (err) {
    toast(`取消失败：${err instanceof Error ? err.message : ''}`, true);
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});

// 仓库地址补全协议头：填了裸域名（github.com/org/repo）也能直接点开
function repoHref(repo: string): string {
  return /^https?:\/\//.test(repo) ? repo : `https://${repo}`;
}

function repoBadge(board: Board): string {
  if (board.repoMode === 'managed') {
    const label = board.repoStatus === 'ready'
      ? '私有代码库就绪'
      : board.repoStatus === 'empty'
        ? '私有空仓库'
        : board.repoStatus === 'failed'
          ? `初始化失败：${board.repoError}`
          : '代码库初始化中';
    return `<span class="repo-status repo-${board.repoStatus}" title="服务器私有代码库">${icon.link}${esc(label)}</span>`;
  }
  return board.repo
    ? `<a class="board-repo" href="${esc(repoHref(board.repo))}" target="_blank" rel="noopener" title="打开 Git remote">${icon.link}${esc(board.repo)}</a>`
    : '';
}

interface NormalizedTaskProgress {
  status: 'active' | 'no_recent_activity' | 'offline' | 'unknown';
  workerLastSeenAt: number | null;
  lastActivityAt: number | null;
  lastActivityKind: string | null;
  lastProgressAt: number | null;
}

function normalizeProgress(progress?: unknown): NormalizedTaskProgress {
  if (!progress || typeof progress !== 'object') {
    return {
      status: 'unknown',
      workerLastSeenAt: null,
      lastActivityAt: null,
      lastActivityKind: null,
      lastProgressAt: null,
    };
  }
  const p = progress as Record<string, unknown>;
  const rawStatus = typeof p.status === 'string' ? p.status : '';
  const status: NormalizedTaskProgress['status'] =
    rawStatus === 'active' || rawStatus === 'no_recent_activity' || rawStatus === 'offline' || rawStatus === 'unknown'
      ? rawStatus
      : 'unknown';

  const parseEpoch = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  const parseKind = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  return {
    status,
    workerLastSeenAt: parseEpoch(p.workerLastSeenAt),
    lastActivityAt: parseEpoch(p.lastActivityAt),
    lastActivityKind: parseKind(p.lastActivityKind),
    lastProgressAt: parseEpoch(p.lastProgressAt),
  };
}

function formatProgressTime(ts: number | null): string {
  if (!ts) return '暂无记录';
  const now = Date.now();
  const diff = now - ts;
  const clock = fmtTime(ts);
  if (diff < 0) return clock;
  if (diff < 60_000) return `刚刚 (${clock})`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前 (${clock})`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前 (${clock})`;
  return `${Math.floor(diff / 86_400_000)} 天前 (${clock})`;
}

const PROGRESS_STATUS_META: Record<
  NormalizedTaskProgress['status'],
  { label: string; short: string; badgeClass: string; desc: string; calloutClass: string; calloutText: string }
> = {
  active: {
    label: '活跃执行',
    short: '活跃',
    badgeClass: 'prog-active',
    desc: '最近有可观察活动',
    calloutClass: 'alert-active',
    calloutText: '最近有可观察活动。',
  },
  no_recent_activity: {
    label: '等待 / 疑似无活动',
    short: '疑似无活动',
    badgeClass: 'prog-warn',
    desc: '近期未观察到新活动',
    calloutClass: 'alert-warn',
    calloutText: '近期未观察到新活动；心跳保活不代表实际进展。',
  },
  offline: {
    label: '失联',
    short: '失联',
    badgeClass: 'prog-offline',
    desc: '近期未收到心跳',
    calloutClass: 'alert-danger',
    calloutText: '近期未收到心跳。',
  },
  unknown: {
    label: '状态未知',
    short: '未知',
    badgeClass: 'prog-unknown',
    desc: '无活动遥测数据',
    calloutClass: 'alert-unknown',
    calloutText: '无活动遥测数据（旧工蜂或尚未上报）。',
  },
};

function renderCardProgress(t: Task): string {
  if (t.lane !== 'InProgress') return '';
  const p = normalizeProgress(t.progress);
  const meta = PROGRESS_STATUS_META[p.status];
  const heartPart = p.workerLastSeenAt ? ` · 心跳 ${fmtTime(p.workerLastSeenAt)}` : '';
  const actPart = p.lastActivityAt ? ` · 活动 ${fmtTime(p.lastActivityAt)}` : '';
  const tip = `${meta.label}（${meta.desc}）${actPart}${heartPart} · 心跳保活不代表实际进展`;
  return `<div class="card-progress ${meta.badgeClass}" title="${esc(tip)}"><span class="card-progress-dot"></span><span class="card-progress-text">${esc(meta.short)}</span></div>`;
}

function renderDrawerProgress(t: Task): string {
  if (t.lane !== 'InProgress') return '';

  const p = normalizeProgress(t.progress);
  const meta = PROGRESS_STATUS_META[p.status];

  return `
    <div class="field">
      <label>工蜂执行与进展遥测</label>
      <div class="progress-panel">
        <div class="progress-panel-head">
          <span class="progress-status-badge ${meta.badgeClass}">
            <span class="status-dot"></span>
            <b>${esc(meta.label)}</b>
          </span>
          <span class="progress-panel-desc">${esc(meta.desc)}</span>
        </div>
        <div class="progress-alert ${meta.calloutClass}">
          ${esc(meta.calloutText)}
        </div>
        <div class="progress-grid">
          <div class="progress-row">
            <div class="progress-row-header">
              <span class="progress-row-label">工蜂保活心跳</span>
              <span class="progress-row-val">${esc(formatProgressTime(p.workerLastSeenAt))}</span>
            </div>
            <div class="progress-row-hint muted">仅表示心跳上报，不代表任务有实质进展</div>
          </div>
          <div class="progress-row">
            <div class="progress-row-header">
              <span class="progress-row-label">最近可观察活动</span>
              <span class="progress-row-val">${esc(formatProgressTime(p.lastActivityAt))}${p.lastActivityKind ? ` · <code class="activity-kind">${esc(p.lastActivityKind)}</code>` : ''}</span>
            </div>
            <div class="progress-row-hint muted">可观察到的事件记录</div>
          </div>
          <div class="progress-row">
            <div class="progress-row-header">
              <span class="progress-row-label">最近进展里程碑</span>
              <span class="progress-row-val">${esc(formatProgressTime(p.lastProgressAt))}</span>
            </div>
            <div class="progress-row-hint muted">阶段进展或里程碑更新时间</div>
          </div>
        </div>
        <div class="progress-evidence-note muted">
          证据原则：仅展示可观察证据，无数据或旧工蜂显示未知；不要从心跳保活推断正在工作。
        </div>
      </div>
    </div>`;
}

function cardHtml(t: Task): string {
  // 紧凑卡（176×88）：首行 P 色点 + 任务号（金色等宽）+ 负责人（蓝灰靠右），标题两行截断；
  // 依赖 / 附件 / 解锁等详情全部收进抽屉，卡面只留「扫一眼」信息
  const assignee = t.assignee !== 'unassigned' ? `<span class="card-assignee">@${esc(t.assignee)}</span>` : '';
  const progressBadge = renderCardProgress(t);
  return `
    <div class="card ${PRIORITY_CLASS[t.priority] ?? 'p1'}" data-task="${esc(t.id)}" title="${esc(t.title)}">
      <div class="card-top"><span class="card-dot"></span><span class="card-id">${esc(t.id)}</span>${assignee}</div>
      <div class="card-title">${esc(t.title)}</div>
      ${progressBadge}
    </div>`;
}

function drawerHtml(t: Task, msgs: Message[], repoMode?: Board['repoMode']): string {
  const actions: string[] = [];
  if (t.status !== 'cancelled') actions.push(`<button data-cancel-task="${esc(t.id)}" class="danger">删除任务卡（取消并保留历史）…</button>`);
  if (t.lane === 'Backlog') actions.push(`<button data-move="Ready">解锁进 Ready</button>`);
  if (t.lane === 'Ready') {
    actions.push(`<button data-move="InProgress">手动开工</button>`);
    actions.push(`<button data-dispatch="1">派活…</button>`);
  }
  if (t.lane === 'InProgress') {
    actions.push(`<button data-dispatch="1">改派…</button>`);
    actions.push(`<button data-release="1">释放</button>`);
  }
  if (t.lane === 'Review') {
    if (t.reviewStatus === 'none') {
      actions.push(`<button data-move="Done" class="primary">验收 Done</button>`);
      actions.push(`<button data-move="InProgress">退回执行</button>`);
    } else if (t.reviewStatus === 'failed') {
      actions.push(`<button data-review-retry="1" class="primary">重试独立审核</button>`);
      actions.push(`<button data-move="Done">人工验收通过</button>`);
      actions.push(`<button data-move="InProgress">人工退回执行</button>`);
    } else if (t.reviewStatus === 'blocked') {
      actions.push(`<button data-move="Done" class="primary">人工验收通过</button>`);
      actions.push(`<button data-move="InProgress">人工退回执行</button>`);
    }
  }
  if (t.lane === 'Done') actions.push(`<button data-move="Review">重开</button>`);

  const evidence = t.evidence.length
    ? t.evidence.map((e) => `<li><code>${esc(e.path)}</code>${e.machine ? ` <span class="muted">@${esc(e.machine)}</span>` : ''}${e.note ? ` — ${esc(e.note)}` : ''}</li>`).join('')
    : '<li class="muted">暂无</li>';
  const files = t.files.length ? t.files.map((f) => `<code>${esc(f)}</code>`).join(' ') : '<span class="muted">未登记</span>';
  const deps = t.dependsOn.length ? t.dependsOn.map((d) => `<span class="dep">${esc(d)}</span>`).join(' ') : '<span class="muted">无</span>';
  const workspace = Object.keys(t.workspace).length
    ? Object.entries(t.workspace).map(([k, v]) => `<div><span class="muted">${esc(k)}:</span> ${esc(String(v))}</div>`).join('')
    : '<span class="muted">未指定</span>';
  const reviewSummary = t.reviewSummary && ['passed', 'rework', 'blocked', 'failed'].includes(t.reviewStatus)
    ? `<div class="field"><label>审核结论</label><div role="status">${esc(t.reviewSummary)}</div></div>`
    : '';
  const submitSummary = t.submitSummary
    ? `<div class="field"><label>Worker 提交摘要</label><div>${esc(t.submitSummary)}</div></div>`
    : '';
  const reviewState = t.reviewStatus !== 'none'
    ? `<div class="field"><label>独立审核</label><div>${esc(({ pending: '排队中', reviewing: '审核中', passed: '已通过', rework: `退回重做 ${t.reviewReworks}/2`, blocked: '超过重做上限，等待人工仲裁', failed: '审核运行失败' } as Record<string, string>)[t.reviewStatus] ?? t.reviewStatus)}${t.reviewAttempts ? ` · 尝试 ${t.reviewAttempts}` : ''}</div></div>`
    : '';
  const canInspectDiff = repoMode === 'managed' && (t.lane === 'Review' || t.lane === 'Done' || t.reviewStatus !== 'none');
  const diffPanel = canInspectDiff
    ? `<div class="field"><label>代码改动</label><button data-diff-load="1">加载 Diff</button><div data-diff-host aria-live="polite" class="muted small" style="margin-top:8px"></div></div>`
    : '';
  const substream = msgs.length
    ? msgs
        .map((m) => `<div class="msg-mini"><b>${esc(m.author)}</b> <time>${fmtTime(m.createdAt)}</time><div>${esc(m.content)}</div></div>`)
        .join('')
    : '<div class="muted">该任务暂无关联消息</div>';
  const progressSection = renderDrawerProgress(t);

  return `
    <div class="drawer-mask" id="drawer-mask"></div>
    <aside class="drawer">
      <div class="drawer-head">
        <span class="card-id big">${esc(t.id)}</span>
        <span class="${PRIORITY_CLASS[t.priority] ?? 'p1'} badge">${esc(t.priority)}</span>
        <span class="lane-badge">${LANE_LABELS[t.lane] ?? t.lane}</span>
        <button class="icon-btn" id="drawer-close" title="关闭">${icon.x}</button>
      </div>
      <h3>${esc(t.title)}</h3>
      <div class="drawer-actions">${actions.join('')}</div>
      <div class="drawer-body">
        ${t.detail ? `<div class="field"><label>说明</label><div>${esc(t.detail)}</div></div>` : ''}
        ${t.acceptance ? `<div class="field"><label>验收标准</label><div class="acceptance">${esc(t.acceptance)}</div></div>` : ''}
        ${reviewState}${submitSummary}${reviewSummary}
        ${progressSection}
        <div class="field"><label>负责人</label><div>${t.assignee === 'unassigned' ? '<span class="muted">未指派</span>' : '@' + esc(t.assignee)}</div></div>
        <div class="field"><label>依赖</label><div>${deps}</div></div>
        <div class="field"><label>工作区</label><div>${workspace}</div></div>
        <div class="field"><label>文件清单</label><div>${files}</div></div>
        <div class="field"><label>证据</label><ul class="evidence">${evidence}</ul></div>
        <div class="field muted small">
          创建 ${fmtTime(t.createdAt)} · 更新 ${fmtTime(t.updatedAt)}
          ${t.claimedAt ? ` · 认领 ${fmtTime(t.claimedAt)}` : ''}
          ${t.autoUnblockedAt ? ` · 解锁 ${fmtTime(t.autoUnblockedAt)}` : ''}
        </div>
        <div class="field"><label>任务消息子流</label>${substream}</div>
      </div>
    </aside>`;
}

export async function render(el: HTMLElement): Promise<void> {
  el.innerHTML = '<div class="loading">加载中…</div>';
  let boards: Board[] = [];
  try {
    boards = (await api.get<{ boards: Board[] }>('/boards')).boards;
  } catch {
    el.innerHTML = '<div class="empty">无法连接分派服务器。</div>';
    return;
  }

  if (boards.length === 0) {
    el.innerHTML = `
      <div class="view-head"><h2>${icon.folder} 项目</h2></div>
      <div class="empty">
        <p>还没有项目。每块板对应一个项目或工作流，聊天室随板而生（建板后出现在右侧）。</p>
        <div class="inline-form">
          <input id="new-board-name" placeholder="看板名称，如：演示项目" />
          <button class="primary" id="new-board-create">创建看板</button>
        </div>
      </div>`;
    (el.querySelector('#new-board-create') as HTMLElement).addEventListener('click', async () => {
      const name = (el.querySelector('#new-board-name') as HTMLInputElement).value.trim();
      if (!name) return;
      try {
        await api.post('/boards', { name });
        location.reload();
      } catch (err) {
        toast(`创建失败：${err instanceof Error ? err.message : ''}`, true);
      }
    });
    return;
  }

  // 深链支持：URL 带 ?board= 时覆盖当前板（写入 localStorage 沿用），侧栏子导航/分享链接即走这里
  const qb = currentQuery().get('board');
  if (qb) {
    currentBoard = qb;
    localStorage.setItem('asterhive.board', qb);
  }

  if (!boards.some((b) => b.id === currentBoard)) {
    currentBoard = boards[0].id;
    localStorage.setItem('asterhive.board', currentBoard);
  }
  refreshNav(); // 当前板可能因深链/回落变化：同步侧栏项目高亮

  const board = boards.find((b) => b.id === currentBoard)!;
  const needsInit = board.repoMode === 'managed' && (board.repoStatus === 'empty' || board.repoStatus === 'failed');
  const initBanner = needsInit
    ? `
      <div class="panel init-banner" style="margin: 0 16px 12px; border-left: 3px solid var(--gold); background: rgba(217, 119, 6, 0.08); padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-radius: 6px;">
        <div>
          <div style="font-weight: 600; font-size: 13px; color: var(--gold-light);">📦 项目代码库尚未初始化</div>
          <div class="muted small" style="margin-top: 2px;">
            当前项目为托管空仓。在聊天室对蜂后说<b>“初始化项目”</b>，蜂后将协助从 GitHub 远端拉取；也可在「管理」中配置远端，或由本机终端导入。
          </div>
        </div>
        <button class="sm ghost" id="btn-copy-import" style="white-space: nowrap;">复制导入命令</button>
      </div>`
    : '';

  // 页头两行：①项目名+仓库 pill+建卡主按钮 ②切板+管理+新项目（窄屏外加看板开关）
  el.innerHTML = `
    <div class="view-head stack">
      <div class="view-head-row">
        <div class="view-title">${icon.folder}<span id="board-title">${esc(board.name)}</span></div>
        <span id="board-repo-link">${repoBadge(board)}</span>
        <div class="flex-spacer"></div>
        <button id="new-task" class="primary" title="新建任务卡">${icon.plus} 建卡</button>
      </div>
      <div class="view-head-row">
        <select id="board-select" title="切换项目">
          ${boards.map((b) => `<option value="${esc(b.id)}"${b.id === currentBoard ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select>
        <button id="manage-board" class="ghost" title="看板管理">${icon.gear} 管理</button>
        <button id="new-board" class="ghost" title="新建项目">${icon.plus} 新项目</button>
        <div class="flex-spacer"></div>
        <button id="board-toggle" class="ghost rail-toggle" title="展开看板浮层">${icon.folder} 看板</button>
      </div>
    </div>
    ${initBanner}
    <div class="workbench" id="workbench">
      <section class="chat-panel" id="chat-panel" aria-label="项目聊天">
        <div class="chat-panel-head">
          <span class="chat-panel-title" title="发言即指令；@句柄 定向投递，@Queen 唤醒蜂后">${icon.chat} 项目聊天</span>
        </div>
        <div class="chat-panel-body" id="chat-panel-body"></div>
      </section>
      <div class="board-mask" id="board-mask"></div>
      <aside class="board-rail" id="board-rail" aria-label="看板">
        <div class="board-rail-head">
          <span class="board-rail-title">${icon.folder} 看板</span>
        </div>
        <div class="board" id="board"></div>
      </aside>
    </div>
    <div id="drawer-host"></div>`;

  const boardEl = el.querySelector('#board') as HTMLElement;
  const drawerHost = el.querySelector('#drawer-host') as HTMLElement;

  const copyImportBtn = el.querySelector('#btn-copy-import');
  if (copyImportBtn) {
    copyImportBtn.addEventListener('click', async () => {
      const cmd = `node packages/sdk/src/cli.ts repo import --board ${board.id} --path <你的本机项目目录> --url ${location.origin}`;
      try {
        await navigator.clipboard.writeText(cmd);
        toast('导入命令已复制到剪贴板');
      } catch {
        prompt('请手动复制以下导入命令：', cmd);
      }
    });
  }

  // 看板渲染：五条横向 lane-strip 纵向堆叠（条带头 = lane 名 + WIP 计数胶囊），
  // 每条内卡片横向滚动——消灭"一条一条竖排"的卡片列；空 lane 保留条带展示占位
  const renderBoard = (tasks: Task[]) => {
    boardEl.innerHTML = LANES.map((lane) => {
      const inLane = tasks.filter((t) => t.lane === lane);
      const limit = lane === 'InProgress' || lane === 'Review' ? (board.wip?.[lane] ?? DEFAULT_WIP[lane]) : null;
      const full = limit !== null && inLane.length >= limit; // WIP 满：计数胶囊变红
      const cards = inLane.length ? inLane.map(cardHtml).join('') : '<div class="lane-empty">暂无卡片</div>';
      return `
        <div class="lane-strip" data-lane="${lane}">
          <div class="lane-head"><span class="lane-name">${LANE_LABELS[lane]}</span><span class="count${full ? ' full' : ''}">${inLane.length}${limit ? `/${limit}` : ''}</span></div>
          <div class="lane-cards">${cards}</div>
        </div>`;
    }).join('');
    boardEl.querySelectorAll('.card').forEach((cardEl) => {
      cardEl.addEventListener('click', () => {
        const id = (cardEl as HTMLElement).dataset.task!;
        void openDrawer(id);
      });
    });
  };

  const load = async () => {
    const r = await api.get<{ tasks: Task[] }>(`/boards/${currentBoard}/tasks`);
    renderBoard(r.tasks);
    return r.tasks;
  };
  let tasks = await load();

  const openDrawer = async (id: string, msgs?: Message[]) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const sub =
      msgs ??
      (
        await api
          .get<{ messages: Message[] }>(`/boards/${currentBoard}/messages?limit=500`)
          .catch(() => ({ messages: [] as Message[] }))
      ).messages.filter((m) => m.taskRef === id);
    drawerHost.innerHTML = drawerHtml(t, sub, board.repoMode);
    drawerHost.querySelector('#drawer-close')!.addEventListener('click', () => (drawerHost.innerHTML = ''));
    drawerHost.querySelector('#drawer-mask')!.addEventListener('click', () => (drawerHost.innerHTML = ''));
    const diffButton = drawerHost.querySelector('[data-diff-load]') as HTMLButtonElement | null;
    const diffHost = drawerHost.querySelector('[data-diff-host]') as HTMLElement | null;
    diffButton?.addEventListener('click', async () => {
      if (!diffHost) return;
      diffButton.disabled = true;
      diffButton.setAttribute('aria-busy', 'true');
      diffButton.textContent = '正在加载 Diff…';
      diffHost.setAttribute('role', 'status');
      diffHost.textContent = '正在读取服务器托管仓库的任务差异…';
      try {
        const diff = await api.get<RepoTaskDiff>(`/tasks/${encodeURIComponent(id)}/repo-diff`);
        const rows = diff.diffText.split('\n').map((line) => {
          const kind = line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
            : line.startsWith('-') && !line.startsWith('---') ? 'diff-del'
              : line.startsWith('@@') ? 'diff-hunk' : '';
          return `<span class="diff-line ${kind}">${esc(line) || '&nbsp;'}</span>`;
        }).join('');
        diffHost.innerHTML = `
          <div class="diff-meta"><div><span class="muted">基线</span> <code>${esc(diff.base.slice(0, 12))}</code> <span class="muted">→ 任务提交</span> <code>${esc(diff.head.slice(0, 12))}</code></div>
          <pre class="repo-diff"><code>${rows || '<span class="muted">没有文本差异</span>'}</code></pre>
          ${diff.diffTruncated ? '<div class="warn" role="status">Diff 超过 50 KB，显示内容已截断；审核时不会对截断 Diff 自动判定通过。</div>' : ''}
          <details><summary>变更文件与统计</summary><pre class="diff-stat">${esc(diff.diffStat || '无统计')}</pre><ul>${diff.changedFiles.map((path) => `<li><code>${esc(path)}</code></li>`).join('') || '<li class="muted">无变更文件</li>'}</ul></details>
        </div>`;
        diffButton.textContent = '重新加载 Diff';
      } catch (err) {
        diffHost.innerHTML = `<span class="warn" role="alert">Diff 加载失败：${esc(err instanceof Error ? err.message : String(err))}</span>`;
        diffButton.textContent = '重试加载 Diff';
      } finally {
        diffButton.disabled = false;
        diffButton.removeAttribute('aria-busy');
      }
    });
    const retryReviewBtn = drawerHost.querySelector('[data-review-retry]');
    retryReviewBtn?.addEventListener('click', async () => {
      const button = retryReviewBtn as HTMLButtonElement;
      button.disabled = true;
      button.textContent = '正在重新排队…';
      try {
        await api.post(`/tasks/${id}/review/retry`, {});
        toast('独立审核已重新排队');
        tasks = await load();
        await openDrawer(id, sub);
      } catch (err) {
        button.disabled = false;
        button.textContent = '重试独立审核';
        toast(`重试失败：${err instanceof Error ? err.message : ''}`, true);
      }
    });
    drawerHost.querySelectorAll('[data-move]').forEach((btn) => {
      btn.addEventListener('click', async () => {
            const to = (btn as HTMLElement).dataset.move!;
        try {
          await api.patch(`/tasks/${id}`, { lane: to });
          toast(`已移至 ${LANE_LABELS[to]}`);
          tasks = await load();
          drawerHost.innerHTML = '';
        } catch (err) {
          toast(`移动失败：${err instanceof Error ? err.message : ''}`, true);
        }
      });
    });
    const dispatchBtn = drawerHost.querySelector('[data-dispatch]');
    if (dispatchBtn) {
      dispatchBtn.addEventListener('click', async () => {
            const handle = prompt('派给谁？（@句柄，如 zcode）');
        if (!handle) return;
        const content = prompt('分派留言（将 @对方 发到聊天室）', `@${handle} 请领取 ${id} 任务，详情见卡片`);
        if (!content) return;
        try {
          await api.post(`/tasks/${id}/dispatch`, { assignee: handle, content });
          toast('已派活并发消息');
          tasks = await load();
          drawerHost.innerHTML = '';
        } catch (err) {
          toast(`派活失败：${err instanceof Error ? err.message : ''}`, true);
        }
      });
    }
    const releaseBtn = drawerHost.querySelector('[data-release]');
    if (releaseBtn) {
      releaseBtn.addEventListener('click', async () => {
            try {
          await api.post(`/tasks/${id}/release`, { reason: '用户界面释放' });
          toast('已释放');
          tasks = await load();
          drawerHost.innerHTML = '';
        } catch (err) {
          toast(`释放失败：${err instanceof Error ? err.message : ''}`, true);
        }
      });
    }
  };

  // ---- 聊天主舞台（项目聊天）：挂载在左栏，切板时整体重挂 ----
  // 取舍：重挂而非热更新 boardId——面板内消息/目标/SSE 过滤都闭包了 boardId，
  // 重挂一次性换新全部状态，无陈旧闭包风险；代价只是切板时多一次消息 GET（原逻辑切板也要拉）。
  const chatBody = el.querySelector('#chat-panel-body') as HTMLElement;
  let chatPanel: ChatPanelHandle | null = null;
  const remountChatPanel = (replyTo?: string) => {
    chatPanel?.destroy(); // 旧面板退订 SSE，避免同一条消息双份增量
    chatPanel = mountChatPanel(chatBody, {
      boardId: currentBoard,
      replyTo,
      onTaskClick: (id) => void openDrawer(id), // 同页联动：消息里的任务号直接开任务抽屉
    });
  };
  // ?reply= 深链只在首次挂载时预填输入框，切板重挂不重复预填
  remountChatPanel(currentQuery().get('reply') ?? undefined);

  // ---- 面板常驻（用户终裁：不设收起）；仅窄屏（<1000px）看板栏变右侧 overlay ----
  // 宽屏两栏固定比例常驻；窄屏由页头「看板」开关唤出 overlay，遮罩点击关闭
  const workbench = el.querySelector('#workbench') as HTMLElement;
  let railOpen = false;
  const applyRailState = () => workbench.classList.toggle('rail-open', railOpen);
  applyRailState();
  (el.querySelector('#board-toggle') as HTMLElement).addEventListener('click', () => {
    railOpen = !railOpen;
    applyRailState();
  });
  (el.querySelector('#board-mask') as HTMLElement).addEventListener('click', () => {
    railOpen = false;
    applyRailState();
  });

  // 建卡表单（简易抽屉）
  (el.querySelector('#new-task') as HTMLElement).addEventListener('click', () => {
    drawerHost.innerHTML = `
      <div class="drawer-mask" id="drawer-mask"></div>
      <aside class="drawer">
        <div class="drawer-head"><h3>新建任务卡</h3><button class="icon-btn" id="drawer-close" title="关闭">${icon.x}</button></div>
        <div class="drawer-body">
          <div class="field"><label for="f-id">编号（T43 / BUG-7）</label><input id="f-id" /></div>
          <div class="field"><label for="f-title">标题</label><input id="f-title" /></div>
          <div class="field"><label for="f-priority">优先级</label>
            <select id="f-priority"><option>P1</option><option>P0</option><option>P2</option></select></div>
          <div class="field"><label for="f-acceptance">验收标准</label><textarea id="f-acceptance" rows="3"></textarea></div>
          <div class="field"><label for="f-deps">依赖（逗号分隔任务号）</label><input id="f-deps" placeholder="T41,T42" /></div>
          <div class="field"><label for="f-repo">仓库</label><input id="f-repo" placeholder="github.com/org/repo" /></div>
          <div class="field"><label for="f-branch">分支</label><input id="f-branch" placeholder="main" /></div>
          <div class="field"><label for="f-files">文件清单（逗号分隔，用于认领互斥）</label><input id="f-files" /></div>
          <button class="primary" id="f-submit">创建</button>
        </div>
      </aside>`;
    drawerHost.querySelector('#drawer-close')!.addEventListener('click', () => (drawerHost.innerHTML = ''));
    drawerHost.querySelector('#drawer-mask')!.addEventListener('click', () => (drawerHost.innerHTML = ''));
    drawerHost.querySelector('#f-submit')!.addEventListener('click', async () => {
        const g = (sel: string) => (drawerHost.querySelector(sel) as HTMLInputElement).value.trim();
      try {
        await api.post(`/boards/${currentBoard}/tasks`, {
          id: g('#f-id'),
          title: g('#f-title'),
          priority: g('#f-priority'),
          acceptance: g('#f-acceptance'),
          dependsOn: g('#f-deps') ? g('#f-deps').split(',').map((s) => s.trim()) : [],
          workspace: g('#f-repo') ? { repo: g('#f-repo'), branch: g('#f-branch') || 'main' } : {},
          files: g('#f-files') ? g('#f-files').split(',').map((s) => s.trim()) : [],
        });
        toast('任务卡已创建');
        tasks = await load();
        drawerHost.innerHTML = '';
      } catch (err) {
        toast(`创建失败：${err instanceof Error ? err.message : ''}`, true);
      }
    });
  });

  // 看板管理抽屉：项目元数据 + 参与者开关 + 危险区删除
  (el.querySelector('#manage-board') as HTMLElement).addEventListener('click', async () => {
    // 参与者数据：worker 角色 agent × 该板当前参与者列表。
    // 蜂后（orchestrator）结构性豁免参与门禁、必须参与，故不列出——避免用户误把它"开除"。
    let participants: string[];
    let agents: Agent[];
    try {
      const [agentsRes, partRes] = await Promise.all([
        api.get<{ agents: Agent[] }>('/agents'),
        api
          .get<{ agentIds: string[] }>(`/boards/${currentBoard}/participants`)
          .catch(() => ({ agentIds: [] as string[] })),
      ]);
      agents = agentsRes.agents.filter((a) => a.role !== 'orchestrator');
      participants = partRes.agentIds;
    } catch (err) {
      toast(`加载参与者失败：${err instanceof Error ? err.message : ''}`, true);
      return;
    }
    const openAll = participants.length === 0; // 空 = 开放给全部（默认态，新注册 agent 自动可参与）
    drawerHost.innerHTML = `
      <div class="drawer-mask" id="drawer-mask"></div>
      <aside class="drawer">
        <div class="drawer-head"><h3>${icon.gear} 看板管理</h3><button class="icon-btn" id="drawer-close" title="关闭">${icon.x}</button></div>
        <div class="drawer-body">
          <div class="field"><label for="m-name">项目名称</label><input id="m-name" value="${esc(board.name)}" /></div>
          <div class="field"><label for="m-repo">Git 仓库地址</label><input id="m-repo" value="${esc(board.repo)}" placeholder="github.com/org/repo 或内网 git 地址（Gitea/裸仓库皆可）" /></div>
          <div class="field"><label for="m-desc">描述</label><textarea id="m-desc" rows="3">${esc(board.description)}</textarea></div>
          <button class="primary" id="m-save">保存</button>

          <div class="field">
            <label>参与者 <span class="muted">（默认开放全部；蜂后始终参与）</span></label>
            <div class="participant-list">
              ${agents.length
                ? agents
                    .map(
                      (a) => `
                <label class="participant-row">
                  <input type="checkbox" data-agent="${esc(a.id)}"${openAll || participants.includes(a.id) ? ' checked' : ''} />
                  <span class="participant-name">${esc(a.name)}</span>
                  <span class="muted">@${esc(a.handle)}</span>
                  <span class="role-badge role-${esc(a.role)}">${esc(a.role)}</span>
                </label>`,
                    )
                    .join('')
                : '<div class="muted small">暂无已注册 worker，可先到「Agent 管理」页注册</div>'}
            </div>
            <button id="m-participants-save">保存参与者</button>
          </div>

          <div class="danger-zone">
            <div class="danger-title">危险区</div>
            <div class="muted small">删除看板将级联删除该板全部任务与消息，不可恢复。</div>
            <button class="danger" id="m-delete">删除看板</button>
          </div>
        </div>
      </aside>`;
    drawerHost.querySelector('#drawer-close')!.addEventListener('click', () => (drawerHost.innerHTML = ''));
    drawerHost.querySelector('#drawer-mask')!.addEventListener('click', () => (drawerHost.innerHTML = ''));

    // 保存项目元数据：PATCH 后就地刷新标题与仓库链接（不整页重载）
    drawerHost.querySelector('#m-save')!.addEventListener('click', async () => {
      const g = (sel: string) => (drawerHost.querySelector(sel) as HTMLInputElement).value.trim();
      try {
        const r = await api.patch<{ board: Board }>(`/boards/${currentBoard}`, {
          name: g('#m-name'),
          repo: g('#m-repo'),
          description: (drawerHost.querySelector('#m-desc') as HTMLTextAreaElement).value.trim(),
        });
        board.name = r.board.name;
        board.repo = r.board.repo;
        board.description = r.board.description;
        (el.querySelector('#board-title') as HTMLElement).textContent = board.name;
        (el.querySelector('#board-repo-link') as HTMLElement).innerHTML = repoBadge(board);
        const opt = el.querySelector(`#board-select option[value="${board.id}"]`) as HTMLOptionElement | null;
        if (opt) opt.textContent = board.name;
        toast('看板元数据已保存');
      } catch (err) {
        toast(`保存失败：${err instanceof Error ? err.message : ''}`, true);
      }
    });

    // 保存参与者：勾选态全量覆盖 PUT；不勾选 = 开放给全部 agent
    drawerHost.querySelector('#m-participants-save')!.addEventListener('click', async () => {
      const boxes = [...drawerHost.querySelectorAll('input[data-agent]:checked')].map(
        (x) => (x as HTMLInputElement).dataset.agent!,
      );
      // 全勾 = 开放给全部（存空数组，未来新注册 agent 自动可参与）；部分勾 = 白名单
      const ids = boxes.length === agents.length ? [] : boxes;
      try {
        await api.put(`/boards/${currentBoard}/participants`, { agentIds: ids });
        participants = ids;
        toast(ids.length ? `参与者已保存（${ids.length} 人）` : '已保存：开放给全部 agent');
        chatPanel?.refreshTargets(); // 参与者变了 → 同步刷新聊天面板的目标下拉
      } catch (err) {
        toast(`保存失败：${err instanceof Error ? err.message : ''}`, true);
      }
    });

    // 危险区：双重确认删除（第一次提示级联不可恢复，第二次输看板 id 确认）
    drawerHost.querySelector('#m-delete')!.addEventListener('click', async () => {
      if (!confirm(`确定删除看板「${board.name}」？\n该板全部任务与消息将被级联删除，不可恢复！`)) return;
      const typed = prompt(`请输入看板 id「${board.id}」以确认删除`);
      if (typed === null) return;
      if (typed.trim() !== board.id) {
        toast('看板 id 不匹配，已取消删除', true);
        return;
      }
      try {
        await api.del(`/boards/${currentBoard}`);
        localStorage.removeItem('asterhive.board'); // 清空看板选择，重载后落到剩余板
        location.reload();
      } catch (err) {
        toast(`删除失败：${err instanceof Error ? err.message : ''}`, true);
      }
    });
  });

  // 新建看板抽屉（＋，常驻入口）：成功后选中新板并刷新
  (el.querySelector('#new-board') as HTMLElement).addEventListener('click', () => {
    drawerHost.innerHTML = `
      <div class="drawer-mask" id="drawer-mask"></div>
      <aside class="drawer">
        <div class="drawer-head"><h3>新建看板</h3><button class="icon-btn" id="drawer-close" title="关闭">${icon.x}</button></div>
        <div class="drawer-body">
          <div class="field"><label for="nb-name">项目名称</label><input id="nb-name" placeholder="如：演示项目" /></div>
          <div class="field"><label for="nb-repo-mode">代码库初始化</label>
            <select id="nb-repo-mode"><option value="empty">在服务器新建私有空仓库</option><option value="clone">从远程 Git 仓库克隆</option><option value="import">本机目录导入（建空仓，后续用 CLI 上传）</option></select>
          </div>
          <div class="field" id="nb-remote-field" hidden><label for="nb-repo">远程 Git 地址</label><input id="nb-repo" placeholder="https://host/org/repo.git 或 SSH remote" /></div>
          <div class="hint" id="nb-import-hint" hidden>创建看板后，在持有源码的设备运行：<code>node packages/sdk/src/cli.ts repo import --board &lt;看板ID&gt; --path &lt;本机项目目录&gt;</code>。仅支持工作树干净的 Git 仓库，并保留提交历史。</div>
          <div class="field"><label for="nb-desc">描述</label><textarea id="nb-desc" rows="3"></textarea></div>
          <button class="primary" id="nb-create">创建看板</button>
        </div>
      </aside>`;
    const modeSelect = drawerHost.querySelector('#nb-repo-mode') as HTMLSelectElement;
    const remoteField = drawerHost.querySelector('#nb-remote-field') as HTMLElement;
    const importHint = drawerHost.querySelector('#nb-import-hint') as HTMLElement;
    modeSelect.addEventListener('change', () => {
      remoteField.hidden = modeSelect.value !== 'clone';
      importHint.hidden = modeSelect.value !== 'import';
    });
    drawerHost.querySelector('#drawer-close')!.addEventListener('click', () => (drawerHost.innerHTML = ''));
    drawerHost.querySelector('#drawer-mask')!.addEventListener('click', () => (drawerHost.innerHTML = ''));
    drawerHost.querySelector('#nb-create')!.addEventListener('click', async () => {
      const name = (drawerHost.querySelector('#nb-name') as HTMLInputElement).value.trim();
      const repoInit = modeSelect.value as 'empty' | 'clone' | 'import';
      const remote = (drawerHost.querySelector('#nb-repo') as HTMLInputElement).value.trim();
      if (!name) {
        toast('请填写项目名称', true);
        return;
      }
      if (repoInit === 'clone' && !remote) {
        toast('远程克隆需要填写 Git 地址', true);
        return;
      }
      try {
        const r = await api.post<{ board: Board }>('/boards', {
          name,
          repo: repoInit === 'clone' ? remote : '',
          repoMode: 'managed',
          repoInit: repoInit === 'clone' ? 'clone' : 'empty',
          description: (drawerHost.querySelector('#nb-desc') as HTMLTextAreaElement).value.trim(),
        });
        localStorage.setItem('asterhive.board', r.board.id);
        location.reload();
      } catch (err) {
        toast(`创建失败：${err instanceof Error ? err.message : ''}`, true);
      }
    });
  });

  (el.querySelector('#board-select') as HTMLSelectElement).addEventListener('change', (ev) => {
    currentBoard = (ev.target as HTMLSelectElement).value;
    localStorage.setItem('asterhive.board', currentBoard);
    location.hash = '#/board'; // 顺手清掉 ?task=/?reply= 等旧参数（hash 变化会触发整页重挂，无需重复处理）
    refreshNav(); // 同步侧栏项目高亮
    void load().then((t) => (tasks = t));
    remountChatPanel(); // 切板：聊天面板跟随（消息/目标下拉/SSE 过滤全部换到新板）
  });

  let repoStatusTimer: ReturnType<typeof setInterval> | null = null;
  if (board.repoMode === 'managed' && (board.repoStatus === 'queued' || board.repoStatus === 'running')) {
    repoStatusTimer = setInterval(async () => {
      try {
        const status = await api.get<Pick<Board, 'repoMode' | 'repoStatus' | 'repoError' | 'repoHead'>>(`/boards/${currentBoard}/repo`);
        board.repoMode = status.repoMode;
        board.repoStatus = status.repoStatus;
        board.repoError = status.repoError;
        board.repoHead = status.repoHead;
        (el.querySelector('#board-repo-link') as HTMLElement).innerHTML = repoBadge(board);
        if (status.repoStatus !== 'queued' && status.repoStatus !== 'running' && repoStatusTimer) {
          clearInterval(repoStatusTimer);
          repoStatusTimer = null;
          if (status.repoStatus === 'failed') toast(`服务器仓库初始化失败：${status.repoError}`, true);
          else toast('服务器私有代码库已就绪');
        }
      } catch { /* 短暂请求失败交给下一次轮询 */ }
    }, 2000);
  }

  const unsub = subscribe((type) => {
    if (type.startsWith('task.') || type.startsWith('agent.')) {
      void load().then((t) => (tasks = t));
    }
  });
  (el as unknown as { __cleanup?: () => void }).__cleanup = () => {
    unsub();
    if (repoStatusTimer) clearInterval(repoStatusTimer);
    chatPanel?.destroy(); // 视图卸载：面板 SSE 订阅一并退订
  };

  // 深链 ?task=T42：直接打开任务抽屉（旧聊天室 taskRef 链接/收藏链接仍可用；
  // 站内消息里的 taskRef 现已改为同页回调 openDrawer，不再经路由）
  const jump = currentQuery().get('task');
  if (jump) {
    await openDrawer(jump);
  }
}
