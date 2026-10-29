// 独立资源驾驶舱（任务 D）：实时快照 + SSE 按节点局部更新；全屏大屏
// 数据源：GET /overview（节点状态/当前任务/泳道计数）+ GET /api/fleet/telemetry（资源快照与 60s 历史）
// + SSE agent.telemetry（按节点合并更新，不整页重绘）。未知不当 0，过期/断线明确标注。
import { api, type Overview, type AgentOverview, type FleetTelemetryReport, type AgentTelemetry } from '../api.ts';
import { subscribe } from '../sse.ts';
import { esc, fmtTime } from '../ui.ts';
import { icon } from '../icons.ts';

const FRESH_MS = 60_000; // 遥测新鲜阈值（与服务端 TELEMETRY_FRESHNESS_MS 一致）
const GAP_MS = 20_000; // 相邻采样间隔超过此值视为断线缺口（不画成连续线）
const PAGE_SIZE = 8; // 每页节点数（节点数量随环境动态变化，分页而非画固定数量）

const STATUS_LABEL: Record<AgentOverview['status'], string> = {
  working: '任务占用',
  idle: '在线·空闲',
  stale: '心跳过期',
  disabled: '停用',
};

const iconExpand =
  '<svg class="i" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>';
const iconCompress =
  '<svg class="i" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"/></svg>';

function metric(v: number | null | undefined, suffix = '', digits = 1): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${suffix}` : '未知';
}

function fmtAgo(ts: number | null): string {
  if (ts === null || !Number.isFinite(ts)) return '未知';
  const d = Date.now() - ts;
  if (d < 0) return '刚刚';
  if (d < 60_000) return `${Math.floor(d / 1000)}s 前`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m 前`;
  return fmtTime(ts);
}

interface Pt {
  t: number;
  v: number;
}

/** 近 60 秒走势：相邻采样间隔 > GAP_MS 处断开线段，明确断线缺口，不把缺口画成连续真实线。 */
function sparkline(history: AgentTelemetry[], key: 'cpuPercent' | 'memoryPercent', label: string): string {
  const pts: Pt[] = [];
  for (const s of history) {
    const v = s[key];
    if (typeof v === 'number' && Number.isFinite(v) && typeof s.timestamp === 'number') {
      pts.push({ t: s.timestamp, v });
    }
  }
  if (!pts.length) return `<span class="cp-no-history">${label} 暂无走势</span>`;
  const width = 240;
  const height = 42;
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => (pts.length < 2 ? width / 2 : ((t - t0) / span) * (width - 4) + 2);
  const y = (v: number) => height - (Math.max(0, Math.min(100, v)) / 100) * (height - 4) - 2;
  const segments: string[] = [];
  let cur: string[] = [];
  let gapCount = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && pts[i].t - pts[i - 1].t > GAP_MS) {
      if (cur.length) {
        segments.push(cur.join(' '));
        cur = [];
      }
      gapCount++;
    }
    cur.push(`${x(pts[i].t).toFixed(1)},${y(pts[i].v).toFixed(1)}`);
  }
  if (cur.length) segments.push(cur.join(' '));
  const last = pts[pts.length - 1].v;
  const gapNote = gapCount ? `，${gapCount} 处断线缺口` : '';
  return `<svg class="cp-spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}近60秒趋势，最近 ${metric(last, '%')}${gapNote}">${segments
    .map((s) => `<polyline points="${s}" />`)
    .join('')}</svg>`;
}

function nodeCardHtml(a: AgentOverview, node: FleetTelemetryReport['nodes'][number] | undefined): string {
  const t = node?.telemetry ?? null;
  const time = t?.timestamp ?? null;
  const expired = time === null || Date.now() - time > FRESH_MS;
  const state = !t ? '暂无遥测' : expired ? '上报已过期' : '实时上报';
  const cpu = t?.cpuPercent ?? null;
  const mem = t?.memoryPercent ?? null;
  const usage = (v: number | null) =>
    v === null || !Number.isFinite(v) ? '' : `--usage:${Math.max(0, Math.min(100, v))}%`;
  const specs = node?.specs ?? a.specs;
  const cores =
    typeof specs?.cpus === 'number' && Number.isFinite(specs.cpus) ? `${specs.cpus} 核` : '未知核心数';
  const osArch = [specs?.os, specs?.arch].filter(Boolean).join('/') || '未知系统';
  const task = a.currentTask
    ? `<div class="cp-task"><span class="cp-task-id">${esc(a.currentTask.id)}</span><span class="cp-task-title">${esc(a.currentTask.title)}</span></div>`
    : '<div class="cp-task muted">空闲——未占用任务</div>';
  const lastSeen = a.lastSeenAt;
  const online = lastSeen !== null && Date.now() - lastSeen <= FRESH_MS;
  return `<article class="cp-card status-${a.status}" data-agent="${esc(a.id)}" aria-label="${esc(a.name)}，${STATUS_LABEL[a.status]}">
    <div class="cp-head"><span class="status-dot ${a.status}" aria-hidden="true"></span><b>${esc(a.name)}</b><span class="cp-handle">@${esc(a.handle)}${a.host ? ` · ${esc(a.host)}` : ''}</span><span class="cp-status">${STATUS_LABEL[a.status]}</span></div>
    <div class="cp-specs muted">${esc(osArch)} · ${cores}${specs?.executor ? ` · ${esc(specs.executor)}` : ''}</div>
    ${task}
    <div class="cp-telemetry${expired ? ' cp-expired' : ''}">
      <div class="cp-t-head"><b>节点资源</b><span class="cp-t-state">${state}</span></div>
      <div class="cp-metrics">
        <div class="cp-metric"><div><span>CPU 实测</span><b>${metric(cpu, '%')}</b></div><div class="cp-track" role="img" aria-label="CPU 使用率 ${metric(cpu, '%')}"><i style="${usage(cpu)}"></i></div></div>
        <div class="cp-metric"><div><span>内存</span><b>${metric(t?.memoryUsedGb)} / ${metric(t?.memoryTotalGb)} GB</b></div><div class="cp-track" role="img" aria-label="内存使用率 ${metric(mem, '%')}"><i style="${usage(mem)}"></i></div></div>
      </div>
      <div class="cp-trends"><div><span>CPU 走势</span>${sparkline(node?.history ?? [], 'cpuPercent', 'CPU')}</div><div><span>内存走势</span>${sparkline(node?.history ?? [], 'memoryPercent', '内存')}</div></div>
      <div class="cp-meta"><span>可用 ${metric(t?.memoryFreeGb)} GB</span><span>${expired ? '最近上报' : '上报'} ${time ? fmtAgo(time) : '未知'}</span><span>心跳 ${online ? '在线' : '离线'}</span></div>
    </div>
  </article>`;
}

/** 整页视图：页头 + 汇总 + 节点网格（分页）+ 调度/任务区；自管订阅与计时器，路由卸载时清理。 */
export function render(el: HTMLElement): void {
  el.innerHTML = `
    <div class="cp-toolbar">
      <div class="cp-title">${icon.hive} 资源驾驶舱</div>
      <div class="cp-actions">
        <button class="ghost sm" id="cp-fullscreen" title="进入/退出全屏"></button>
        <button class="ghost sm" id="cp-back" title="返回常规 Agent 总览">${icon.list} 常规总览</button>
      </div>
    </div>
    <div class="cp-body">
      <div class="cp-summary" id="cp-summary"></div>
      <div class="cp-grid" id="cp-grid"></div>
      <div class="cp-pager" id="cp-pager"></div>
      <div class="cp-tasks" id="cp-tasks"></div>
    </div>`;

  const grid = el.querySelector('#cp-grid') as HTMLElement;
  const summaryEl = el.querySelector('#cp-summary') as HTMLElement;
  const pagerEl = el.querySelector('#cp-pager') as HTMLElement;
  const tasksEl = el.querySelector('#cp-tasks') as HTMLElement;
  const fsBtn = el.querySelector('#cp-fullscreen') as HTMLButtonElement;
  const backBtn = el.querySelector('#cp-back') as HTMLButtonElement;

  let disposed = false;
  let overview: Overview | null = null;
  let telemetry: FleetTelemetryReport | null = null;
  const pending = new Map<string, AgentTelemetry>();
  let telemetryTimer: number | undefined;
  let reloadTimer: number | undefined;
  let page = 0;

  const workers = () => (overview?.agents ?? []).filter((a) => a.role !== 'orchestrator');
  const pages = () => Math.max(1, Math.ceil(workers().length / PAGE_SIZE));

  function renderSummary(): void {
    const ov = overview;
    const telem = telemetry;
    const ws = workers();
    const online = ws.filter((a) => a.status === 'working' || a.status === 'idle').length;
    const working = ws.filter((a) => a.status === 'working').length;
    const fresh = telem?.reportingNodes ?? 0;
    const total = telem?.totalNodes ?? ws.length;
    const lanes = ov?.aggregates.lanes ?? {};
    const inProgress = lanes.InProgress?.count ?? 0;
    const ready = lanes.Ready?.count ?? 0;
    const review = lanes.Review?.count ?? 0;
    const m = telem?.metrics;
    const cpuAvg = m && typeof m.avgCpuPercent === 'number' && Number.isFinite(m.avgCpuPercent) ? m.avgCpuPercent : null;
    const memUsed = m && typeof m.totalUsedMemoryGb === 'number' && Number.isFinite(m.totalUsedMemoryGb) ? m.totalUsedMemoryGb : null;
    const memTotal = m && typeof m.totalMemoryGb === 'number' && Number.isFinite(m.totalMemoryGb) ? m.totalMemoryGb : null;
    const cpuVal =
      cpuAvg === null ? '未知' : `${metric(cpuAvg, '%')}<small class="cp-note">（${fresh} 节点样本）</small>`;
    summaryEl.innerHTML = `
      <div class="cp-stat"><span>在线 / 总数</span><b>${online}<i>/</i>${total}</b></div>
      <div class="cp-stat"><span>工作中</span><b>${working}</b></div>
      <div class="cp-stat"><span>遥测新鲜节点</span><b>${fresh}<i>/</i>${total}</b></div>
      <div class="cp-stat"><span>进行中任务</span><b>${inProgress}</b></div>
      <div class="cp-stat"><span>排队任务</span><b>${ready}</b></div>
      <div class="cp-stat"><span>平均 CPU</span><b>${cpuVal}</b></div>
      <div class="cp-stat"><span>内存已用 / 总</span><b>${metric(memUsed)} / ${metric(memTotal)} GB</b></div>
      <div class="cp-stat"><span>待审</span><b>${review}</b></div>`;
  }

  function renderTasks(): void {
    const ov = overview;
    const lanes = ov?.aggregates.lanes ?? {};
    const agg = ov?.aggregates;
    const ready = lanes.Ready?.count ?? 0;
    const inProgress = lanes.InProgress?.count ?? 0;
    const review = lanes.Review?.count ?? 0;
    const wipIp = lanes.InProgress?.limit;
    const wipRv = lanes.Review?.limit;
    const working = agg?.working ?? 0;
    const idle = agg?.idle ?? 0;
    const stale = agg?.stale ?? 0;
    const disabled = agg?.disabled ?? 0;
    tasksEl.innerHTML = `
      <div class="cp-tasks-head"><b>调度与任务</b><span class="hint">泳道计数来自看板真实任务；派发/匹配原因请在项目工作台查看任务详情</span></div>
      <div class="cp-lanes">
        <div class="cp-lane"><span>就绪 Ready</span><b>${ready}</b></div>
        <div class="cp-lane"><span>进行 InProgress</span><b>${inProgress}${wipIp != null ? `/${wipIp}` : ''}</b></div>
        <div class="cp-lane"><span>待审 Review</span><b>${review}${wipRv != null ? `/${wipRv}` : ''}</b></div>
      </div>
      <div class="cp-agents"><span>任务占用 <b>${working}</b></span><span>在线空闲 <b>${idle}</b></span><span>心跳过期 <b>${stale}</b></span><span>停用 <b>${disabled}</b></span></div>`;
  }

  function renderGrid(): void {
    const ov = overview;
    if (!ov) {
      grid.innerHTML = '<div class="loading">加载中…</div>';
      return;
    }
    const byId = new Map((telemetry?.nodes ?? []).map((n) => [n.agentId, n]));
    const ws = workers();
    const p = pages();
    if (page >= p) page = p - 1;
    const slice = ws.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    if (!slice.length) {
      grid.innerHTML = '<div class="empty">尚无工蜂注册——到「Agent 管理」注册第一只工蜂</div>';
      return;
    }
    grid.innerHTML = slice.map((a) => nodeCardHtml(a, byId.get(a.id))).join('');
  }

  function renderPager(): void {
    const ws = workers();
    const p = pages();
    if (p <= 1) {
      pagerEl.innerHTML = '';
      return;
    }
    const btns = [];
    for (let i = 0; i < p; i++) {
      btns.push(
        `<button class="cp-page${i === page ? ' active' : ''}" data-page="${i}"${i === page ? ' aria-current="page"' : ''}>${i + 1}</button>`,
      );
    }
    pagerEl.innerHTML = `<span class="cp-page-info">第 ${page + 1} / ${p} 页 · 共 ${ws.length} 节点</span><div class="cp-pages">${btns.join('')}</div>`;
    pagerEl.querySelectorAll<HTMLButtonElement>('.cp-page').forEach((b) => {
      b.addEventListener('click', () => {
        page = Number(b.dataset.page);
        renderGrid();
        renderPager();
      });
    });
  }

  function renderAll(): void {
    renderSummary();
    renderTasks();
    renderGrid();
    renderPager();
  }

  /** SSE 按节点局部更新：只替换该节点卡片，不整页重绘。 */
  function updateNodeCard(agentId: string): void {
    if (!overview) return;
    const card =
      Array.from(grid.querySelectorAll<HTMLElement>('.cp-card')).find((c) => c.dataset.agent === agentId) ?? null;
    if (!card) return;
    const a = overview.agents.find((x) => x.id === agentId);
    const node = telemetry?.nodes.find((n) => n.agentId === agentId);
    if (!a) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = nodeCardHtml(a, node);
    card.replaceWith(wrapper.firstElementChild!);
  }

  function applyTelemetry(): void {
    telemetryTimer = undefined;
    if (!telemetry) return;
    for (const [agentId, sample] of pending) {
      const node = telemetry.nodes.find((n) => n.agentId === agentId);
      if (!node) continue;
      node.telemetry = sample;
      node.history = [...node.history, sample].slice(-60);
      telemetry.timestamp = Math.max(telemetry.timestamp, sample.timestamp);
      updateNodeCard(agentId);
    }
    pending.clear();
  }

  const load = async () => {
    if (disposed || document.hidden) return;
    try {
      const [ov, telem] = await Promise.all([
        api.get<Overview>('/overview'),
        api.get<FleetTelemetryReport>('/api/fleet/telemetry').catch(() => null),
      ]);
      if (disposed) return;
      overview = ov;
      if (telem) telemetry = telem;
      if (page >= pages()) page = pages() - 1;
      renderAll();
    } catch {
      if (disposed) return;
      if (!overview) grid.innerHTML = '<div class="empty">加载失败：无法连接分派服务器。</div>';
    }
  };

  const unsub = subscribe((type, payload) => {
    if (disposed || document.hidden) return;
    if (type === 'agent.telemetry') {
      if (typeof payload.agentId !== 'string' || !payload.telemetry) return;
      pending.set(payload.agentId, payload.telemetry as AgentTelemetry);
      if (telemetryTimer === undefined) telemetryTimer = window.setTimeout(applyTelemetry, 250);
    } else if (type.startsWith('task.') || type.startsWith('agent.') || type.startsWith('brain.turn_')) {
      if (reloadTimer === undefined)
        reloadTimer = window.setTimeout(() => {
          reloadTimer = undefined;
          void load();
        }, 500);
    }
  });
  const poll = setInterval(() => void load(), 30_000);
  const onVis = () => {
    if (!document.hidden) void load();
  };
  document.addEventListener('visibilitychange', onVis);

  // 全屏入口/退出：拒绝/不支持全屏时仍可正常查看（按钮仅切换 class，不影响布局可用性）
  const updateFs = () => {
    const isFs = document.fullscreenElement !== null;
    fsBtn.innerHTML = `${isFs ? iconCompress : iconExpand} ${isFs ? '退出全屏' : '全屏'}`;
    document.body.classList.toggle('cockpit-fullscreen', isFs);
  };
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  });
  backBtn.addEventListener('click', () => {
    location.hash = '#/fleet';
  });
  document.addEventListener('fullscreenchange', updateFs);
  updateFs();

  (el as unknown as { __cleanup?: () => void }).__cleanup = () => {
    disposed = true;
    unsub();
    clearInterval(poll);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('fullscreenchange', updateFs);
    document.body.classList.remove('cockpit-fullscreen');
    if (document.fullscreenElement) void document.exitFullscreen();
    if (telemetryTimer !== undefined) window.clearTimeout(telemetryTimer);
    if (reloadTimer !== undefined) window.clearTimeout(reloadTimer);
  };

  void load();
}