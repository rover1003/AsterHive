// Agent 总览（fleet 视图）：Nomad Jobs 风格，一屏纵览；SSE 驱动刷新
// 入口：侧栏「Agent 总览」组的子项（#/fleet?agent=<id>，定位高亮对应卡片）与 #/fleet 直链。
// 页头归 render，内容装配复用 renderFleetInto（数据拉取 + SSE 刷新 + 30s 兜底轮询）。
import { api, type Overview, type AgentOverview } from '../api.ts';
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

function agentCardHtml(a: AgentOverview): string {
  const taskBlock = a.currentTask
    ? `
      <div class="fleet-task">
        <span class="card-id">${esc(a.currentTask.id)}</span>
        <span class="fleet-title">${esc(a.currentTask.title)}</span>
        <span class="fleet-elapsed">${icon.clock} ${fmtDuration(a.currentTask.elapsedMs)}</span>
      </div>
      <div class="fleet-checkpoint">
        ${a.currentTask.lastCheckpoint ? `${icon.clock} ${fmtTime(a.currentTask.lastCheckpoint.time)} — ${esc(a.currentTask.lastCheckpoint.note)}` : '<span class="muted">暂无 checkpoint</span>'}
      </div>`
    : '<div class="fleet-task muted">空闲——未占用任务</div>';

  return `
    <div class="fleet-card status-${a.status}" id="fleet-agent-${esc(a.id)}" title="${a.status === 'stale' ? `心跳已超过服务器离线阈值（最近：${a.lastSeenAt ? fmtTime(a.lastSeenAt) : '从未上线'}）` : STATUS_LABEL[a.status]}">
      <div class="fleet-head">
        <span class="status-dot ${a.status}"></span>
        <b>${esc(a.name)}</b>
        <span class="handle">@${esc(a.handle)}${a.host ? ` · ${esc(a.host)}` : ''}</span>
        <span class="role-badge role-${a.role}">worker</span>
        <span class="fleet-status-label">${STATUS_LABEL[a.status]}</span>
        <span class="fleet-done" title="累计完成">${icon.check} ${a.doneCount}</span>
      </div>
      ${taskBlock}
      <div class="fleet-foot muted">
        ${STATUS_LABEL[a.status]} · 心跳 ${a.lastSeenAt ? fmtTime(a.lastSeenAt) : '从未'} · ${esc(a.id)}
      </div>
    </div>`;
}

/**
 * 把 Agent 总览内容（聚合条 + agent 卡片网格）装配进任意容器，并自管刷新：
 * 首帧拉取 /overview，订阅 task.* / agent.* 事件重拉，另有 30s 兜底轮询。
 * onFirstLoad：首次装配完成（成功或失败）后回调一次——深链 ?agent= 靠它确认卡片已进 DOM。
 * 返回 destroy：退订 SSE、清计时器（幂等）；销毁后不再写回容器，
 * 防止视图已卸载时迟到的响应还去改 DOM。
 */
export function renderFleetInto(
  container: HTMLElement,
  onFirstLoad?: () => void,
): { destroy: () => void } {
  container.innerHTML = '<div class="loading">加载中…</div>';
  let disposed = false;
  let firstLoad = true;

  const load = async () => {
    if (disposed) return;
    try {
      const ov = await api.get<Overview>('/overview');
      if (disposed) return; // 请求在途期间已被销毁：丢弃结果
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
      container.innerHTML = `
        <div class="agg-bar">
          <span class="agg working">工作中 <b>${counts.working}</b></span>
          <span class="agg idle">在线·空闲 <b>${counts.idle}</b></span>
          <span class="agg stale">心跳过期 <b>${counts.stale}</b></span>
          <span class="agg disabled">停用 <b>${counts.disabled}</b></span>
          <span class="sep"></span>${lanes}
        </div>
        <div class="fleet">${workers.length ? workers.map(agentCardHtml).join('') : '<div class="empty">尚无 worker 注册——到「Agent 接入」注册第一个 worker</div>'}</div>`;
    } catch (err) {
      if (disposed) return;
      container.innerHTML = `<div class="empty">加载失败：${esc(err instanceof Error ? err.message : '')}</div>`;
    }
    // 首次装配完成（成功或失败都算）：只回调一次，之后 SSE/轮询的刷新不再触发
    if (firstLoad) {
      firstLoad = false;
      onFirstLoad?.();
    }
  };
  void load();

  const unsub = subscribe((type) => {
    if (type.startsWith('task.') || type.startsWith('agent.')) void load();
  });
  const timer = setInterval(() => void load(), 30_000);

  return {
    destroy: () => {
      if (disposed) return;
      disposed = true;
      unsub();
      clearInterval(timer);
    },
  };
}

/** 整页视图：页头归页面，内容装配复用 renderFleetInto；?agent=<id> 深链定位高亮 */
export function render(el: HTMLElement): void {
  el.innerHTML = `
    <div class="view-head"><h2>${icon.hive} Agent 总览</h2><span class="hint">纯事件投影——agent 无需为此额外上报</span></div>
    <div class="fleet-body"></div>`;
  const body = el.querySelector('.fleet-body') as HTMLElement;
  // 深链 ?agent=<id>（侧栏 Agent 子导航直达）：首屏装配完成后滚动定位 + 2s 边框渐隐高亮
  const target = currentQuery().get('agent');
  const handle = renderFleetInto(body, target ? () => focusAgentCard(target) : undefined);
  // 视图可通过挂载元素上的 __cleanup 钩子登记清理逻辑（main.ts mount 统一调用）
  (el as unknown as { __cleanup?: () => void }).__cleanup = handle.destroy;
}

/** 滚动定位 agent 卡片：block:'center' 居中；加 focus class 点亮 --primary 边框，
 *  2s 后移除，靠 .fleet-card 自身的 border-color transition 渐隐回常态 */
function focusAgentCard(agentId: string): void {
  const card = document.getElementById(`fleet-agent-${agentId}`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('fleet-card-focus');
  window.setTimeout(() => card.classList.remove('fleet-card-focus'), 2000);
}
