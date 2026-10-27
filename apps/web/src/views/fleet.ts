// Agent 总览：聚合状态与节点资源遥测；SSE/轻量刷新驱动更新
// 入口：侧栏「Agent 总览」组的子项（#/fleet?agent=<id>，定位高亮对应卡片）与 #/fleet 直链。
// 页头由 render 装配；Agent 总览和任务上下文均保留。
import { api, type Overview, type AgentOverview, type FleetRadarReport, type FleetTelemetryReport, type AgentTelemetry } from '../api.ts';
import { subscribe } from '../sse.ts';
import { currentQuery } from '../main.ts';
import { esc, fmtDuration, fmtTime } from '../ui.ts';
import { icon } from '../icons.ts';

const STATUS_LABEL: Record<AgentOverview['status'], string> = {
  working: '工作中',
  idle: '在线·空闲',
  stale: '心跳过期/疑似离线',
  disabled: '停用',
};

function metric(value: number | null | undefined, suffix = '', digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : '未知';
}

function sparkline(history: AgentTelemetry[], key: 'cpuPercent' | 'memoryPercent', label: string): string {
  const values = history.map((sample) => sample[key]);
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!valid.length) return `<span class="telemetry-no-history">${label} 暂无走势</span>`;
  const width = 240;
  const height = 42;
  const points = values.map((value, index) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const x = values.length < 2 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - (Math.max(0, Math.min(100, value)) / 100) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const segments: string[] = [];
  let segment: string[] = [];
  for (const point of points) {
    if (point) segment.push(point);
    else if (segment.length) { segments.push(segment.join(' ')); segment = []; }
  }
  if (segment.length) segments.push(segment.join(' '));
  const last = valid[valid.length - 1];
  return `<svg class="telemetry-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}历史走势，最近 ${metric(last, '%')}">${segments.map((line) => `<polyline points="${line}" />`).join('')}</svg>`;
}

function telemetryHtml(node: FleetTelemetryReport['nodes'][number] | undefined): string {
  if (!node) return '<section class="telemetry-panel telemetry-missing" aria-label="节点资源遥测"><b>资源遥测</b><span>尚无遥测数据</span></section>';
  const t = node.telemetry;
  const time = t?.timestamp;
  const expired = !t || !time || Date.now() - time > 60_000;
  const state = !t ? '暂无遥测' : expired ? '上报已过期' : '实时上报';
  const cpu = t?.cpuPercent ?? null;
  const mem = t?.memoryPercent ?? null;
  const progress = (value: number | null) => value === null || !Number.isFinite(value) ? '' : `--usage:${Math.max(0, Math.min(100, value))}%`;
  const specs = node.specs;
  const cores = typeof specs?.cpus === 'number' && Number.isFinite(specs.cpus) ? `${specs.cpus} 核` : '未知核心数';
  const uptime = t?.uptimeSec === null || t?.uptimeSec === undefined ? '未知' : fmtDuration(t.uptimeSec * 1000);
  const taskCount = t?.taskInProgress === null || t?.taskInProgress === undefined ? '未知' : esc(t.taskInProgress);
  return `<section class="telemetry-panel${expired ? ' telemetry-expired' : ''}" aria-label="${esc(node.name)} 节点资源遥测">
    <div class="telemetry-heading"><b>节点资源</b><span class="telemetry-state">${state}</span></div>
    <div class="telemetry-metrics">
      <div class="telemetry-metric"><div><span>CPU 实测</span><b>${metric(cpu, '%')}</b></div><div class="telemetry-track" role="img" aria-label="CPU 使用率 ${metric(cpu, '%')}"><i style="${progress(cpu)}"></i></div><small>${cores}</small></div>
      <div class="telemetry-metric"><div><span>内存</span><b>${metric(t?.memoryUsedGb)} / ${metric(t?.memoryTotalGb)} GB</b></div><div class="telemetry-track" role="img" aria-label="内存使用率 ${metric(mem, '%')}"><i style="${progress(mem)}"></i></div><small>可用 ${metric(t?.memoryFreeGb)} GB</small></div>
    </div>
    <div class="telemetry-trends"><div><span>CPU 走势</span>${sparkline(node.history ?? [], 'cpuPercent', 'CPU')}</div><div><span>内存走势</span>${sparkline(node.history ?? [], 'memoryPercent', '内存')}</div></div>
    <div class="telemetry-meta"><span>活动任务 <b>${taskCount}</b></span><span>运行时长 <b>${uptime}</b></span><span>${expired ? '最近上报' : '上报时间'} <b>${time ? fmtTime(time) : '未知'}</b></span></div>
  </section>`;
}

function agentCardHtml(a: AgentOverview, telemetry: FleetTelemetryReport['nodes'][number] | undefined): string {
  const taskBlock = a.currentTask
    ? `<div class="fleet-task"><span class="card-id">${esc(a.currentTask.id)}</span><span class="fleet-title">${esc(a.currentTask.title)}</span><span class="fleet-elapsed">${icon.clock} ${fmtDuration(a.currentTask.elapsedMs)}</span></div><div class="fleet-checkpoint">${a.currentTask.lastCheckpoint ? `${icon.clock} ${fmtTime(a.currentTask.lastCheckpoint.time)} — ${esc(a.currentTask.lastCheckpoint.note)}` : '<span class="muted">暂无 checkpoint</span>'}</div>`
    : '<div class="fleet-task muted">空闲——未占用任务</div>';
  const specs = a.specs;
  const specParts = [
    specs?.os && specs?.arch ? `${specs.os}/${specs.arch}` : (specs?.os || specs?.arch || ''),
    specs?.cpus || specs?.memoryTotalGb ? `${specs?.cpus ? `${specs.cpus}核` : ''}${specs?.memoryTotalGb ? `/${specs.memoryTotalGb}GB` : ''}` : '',
    specs?.executor ? `内核 ${specs.executor}` : '',
  ].filter(Boolean);
  const specBlock = specParts.length ? `<div class="fleet-specs muted small">💻 ${esc(specParts.join(' · '))}</div>` : '';
  return `<article class="fleet-card status-${a.status}" id="fleet-agent-${esc(a.id)}" aria-label="${esc(a.name)}，${STATUS_LABEL[a.status]}，${esc(a.handle)}" title="${a.status === 'stale' ? `心跳已超过服务器离线阈值（最近：${a.lastSeenAt ? fmtTime(a.lastSeenAt) : '从未上线'}）` : STATUS_LABEL[a.status]}">
    <div class="fleet-head"><span class="status-dot ${a.status}" aria-hidden="true"></span><b>${esc(a.name)}</b><span class="handle">@${esc(a.handle)}${a.host ? ` · ${esc(a.host)}` : ''}</span><span class="role-badge role-${a.role}">${a.role === 'orchestrator' ? '蜂后 Queen' : '工蜂 Bee'}</span><span class="fleet-status-label">${STATUS_LABEL[a.status]}</span><span class="fleet-done" title="累计完成">${icon.check} ${a.doneCount}</span></div>
    ${taskBlock}${specBlock}${telemetryHtml(telemetry)}
    <div class="fleet-foot muted">${STATUS_LABEL[a.status]} · 心跳 ${a.lastSeenAt ? fmtTime(a.lastSeenAt) : '从未'} · ${esc(a.id)}</div>
  </article>`;
}

function updateTelemetry(container: HTMLElement, report: FleetTelemetryReport, agentId?: string): void {
  const nodes = agentId ? report.nodes.filter((item) => item.agentId === agentId) : report.nodes;
  for (const node of nodes) {
    const card = document.getElementById(`fleet-agent-${node.agentId}`);
    if (!card || !container.contains(card)) continue;
    const current = card.querySelector('.telemetry-panel');
    if (!current) continue;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = telemetryHtml(node);
    current.replaceWith(wrapper.firstElementChild!);
  }
}

/**
 * 把 Agent 总览内容装配进容器，并自管刷新；资源快照由 /api/fleet/telemetry 提供。
 * onFirstLoad：首次装配完成后回调一次。返回 destroy 清理订阅和计时器。
 */
export function renderFleetInto(
  container: HTMLElement,
  onFirstLoad?: () => void,
): { destroy: () => void } {
  container.innerHTML = '<div class="loading">加载中…</div>';
  let disposed = false;
  let firstLoad = true;
  let loading = false;
  let telemetryTimer: number | undefined;
  let telemetrySnapshot: FleetTelemetryReport | null = null;
  const pendingTelemetry = new Map<string, AgentTelemetry>();
  const applyTelemetryEvents = () => {
    telemetryTimer = undefined;
    if (!telemetrySnapshot) return;
    for (const [agentId, sample] of pendingTelemetry) {
      const node = telemetrySnapshot.nodes.find((item) => item.agentId === agentId);
      if (!node) continue;
      node.telemetry = sample;
      node.history = [...node.history, sample].slice(-60);
      telemetrySnapshot.timestamp = Math.max(telemetrySnapshot.timestamp, sample.timestamp);
      updateTelemetry(container, telemetrySnapshot, agentId);
    }
    pendingTelemetry.clear();
  };
  const queueTelemetryEvent = (payload: Record<string, unknown>) => {
    if (typeof payload.agentId !== 'string' || !payload.telemetry) return;
    pendingTelemetry.set(payload.agentId, payload.telemetry as AgentTelemetry);
    if (telemetryTimer === undefined) telemetryTimer = window.setTimeout(applyTelemetryEvents, 250);
  };

  const load = async () => {
    if (disposed || loading) return;
    loading = true;
    try {
      const [ov, radar, telemetry] = await Promise.all([
        api.get<Overview>('/overview'),
        api.get<FleetRadarReport>('/api/fleet/radar').catch(() => null),
        api.get<FleetTelemetryReport>('/api/fleet/telemetry').catch(() => null),
      ]);
      if (telemetry) telemetrySnapshot = telemetry;
      if (disposed) return;
      const workers = ov.agents.filter((a) => a.role !== 'orchestrator');
      const counts = {
        working: workers.filter((a) => a.status === 'working').length,
        idle: workers.filter((a) => a.status === 'idle').length,
        stale: workers.filter((a) => a.status === 'stale').length,
        disabled: workers.filter((a) => a.status === 'disabled').length,
      };
      const lanes = Object.entries(ov.aggregates.lanes)
        .map(([lane, v]) => `<span class="lane-pill">${esc(lane)} <b>${v.count}</b>${v.limit ? `/${v.limit}` : ''}</span>`)
        .join('');
      let radarHtml = '';
      if (radar) {
        const sum = radar.summary;
        const alertHtml = radar.alerts.length
          ? `<div class="radar-alerts" style="margin:8px 0;padding:8px 12px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.25);border-radius:6px;color:#ef4444;font-size:12px">
              <b>⚠ 停滞预警（${radar.alerts.length} 项）：</b>
              ${radar.alerts.map((al) => `<div>· 任务 <b>${esc(al.taskId)}</b>（工蜂 @${esc(al.agentHandle)}）已进行 ${al.elapsedMinutes} 分钟，已 ${al.idleCheckpointMinutes} 分钟无进展：${esc(al.recommendation)}</div>`).join('')}
            </div>`
          : '';
        radarHtml = `<div class="radar-bar muted small" style="margin:8px 0;padding:6px 12px;background:var(--secondary);border-radius:6px;display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:12px">
          <span>💻 <b>全蜂群算力：</b>${sum.onlineWorkers}/${sum.totalWorkers} 在线 · <b>${sum.totalCpus}</b> 核心 · <b>${sum.totalMemoryGb}</b> GB 内存</span>
          <span>🤖 <b>可用模型：</b>${sum.uniqueModels.length ? esc(sum.uniqueModels.slice(0, 3).join('、')) + (sum.uniqueModels.length > 3 ? ' 等' : '') : '未自报'}</span>
        </div>${alertHtml}`;
      }
      const cards = workers.map((agent) => {
        const node = telemetry?.nodes.find((item) => item.agentId === agent.id);
        return agentCardHtml(agent, node);
      }).join('');
      container.innerHTML = `<div class="agg-bar"><span class="agg working">工作中 <b>${counts.working}</b></span><span class="agg idle">在线·空闲 <b>${counts.idle}</b></span><span class="agg stale">心跳过期 <b>${counts.stale}</b></span><span class="agg disabled">停用 <b>${counts.disabled}</b></span><span class="sep"></span>${lanes}</div>
        ${radarHtml}
        <div class="telemetry-summary" aria-label="资源遥测概览"><b>节点资源遥测</b><span>${telemetry ? `${telemetry.reportingNodes}/${telemetry.totalNodes} 个节点上报` : '遥测数据暂不可用'}</span><span>更新时间 ${telemetry?.timestamp ? fmtTime(telemetry.timestamp) : '未知'}</span></div>
        <div class="fleet">${cards || '<div class="empty">尚无工蜂注册——到「Agent 管理」注册第一只工蜂</div>'}</div>`;
    } catch (err) {
      if (disposed) return;
      container.innerHTML = `<div class="empty">加载失败：${esc(err instanceof Error ? err.message : '')}</div>`;
    } finally {
      loading = false;
      if (firstLoad) {
        firstLoad = false;
        onFirstLoad?.();
      }
    }
  };
  void load();
  const unsub = subscribe((type, payload) => {
    if (type === 'agent.telemetry') queueTelemetryEvent(payload);
    else if (type.startsWith('task.') || type.startsWith('agent.')) void load();
  });
  const timer = setInterval(() => void load(), 30_000);
  return {
    destroy: () => {
      if (disposed) return;
      disposed = true;
      unsub();
      clearInterval(timer);
      window.clearTimeout(telemetryTimer);
    },
  };
}


/** 整页视图：页头归页面，内容装配复用 renderFleetInto；?agent=<id> 深链定位高亮 */
export function render(el: HTMLElement): void {
  el.innerHTML = `
    <div class="view-head"><h2>${icon.hive} Agent 总览</h2><span class="hint">设备资源由工蜂心跳上报</span></div>
    <div class="fleet-body"></div>`;
  const body = el.querySelector('.fleet-body') as HTMLElement;
  // 深链 ?agent=<id>（侧栏 Agent 子导航直达）：首屏装配完成后滚动定位 + 2s 边框渐隐高亮
  const target = currentQuery().get('agent');
  const handle = renderFleetInto(body, target ? () => focusAgentCard(target) : undefined);
  // 视图可通过挂载元素上的 __cleanup 钩子登记清理逻辑（main.ts mount 统一调用）
  (el as unknown as { __cleanup?: () => void }).__cleanup = handle.destroy;
}

/** Scroll to and highlight a deep-linked Agent card, respecting reduced motion. */
function focusAgentCard(agentId: string): void {
  const card = document.getElementById(`fleet-agent-${agentId}`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  card.classList.add('fleet-card-focus');
  window.setTimeout(() => card.classList.remove('fleet-card-focus'), 2000);
}
