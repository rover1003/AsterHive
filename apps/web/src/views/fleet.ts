// Agent 总览（fleet 视图）：Nomad Jobs 风格，一屏纵览；SSE 驱动刷新
// 同一套内容装配服务两种形态：
// · 整页视图（#/fleet 深链）：render() 补页头后交给 renderFleetInto；
// · 全局抽屉（侧栏「Agent 总览」直接唤出）：main.ts 把抽屉内容区交给 renderFleetInto，
//   当前页面（通常是聊天工作台）不被打断；关闭时 destroy 退订 SSE / 清计时器。
import { api, type Overview, type AgentOverview } from '../api.ts';
import { subscribe } from '../sse.ts';
import { esc, fmtDuration, fmtTime } from '../ui.ts';
import { icon } from '../icons.ts';

const STATUS_LABEL: Record<AgentOverview['status'], string> = {
  working: '工作中',
  idle: '空闲',
  stale: '断线候选',
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
    <div class="fleet-card status-${a.status}">
      <div class="fleet-head">
        <span class="status-dot ${a.status}"></span>
        <b>${esc(a.name)}</b>
        <span class="handle">@${esc(a.handle)}${a.host ? ` · ${esc(a.host)}` : ''}</span>
        <span class="role-badge role-${a.role}">${a.role === 'orchestrator' ? '主脑' : a.role === 'user' ? '用户' : 'worker'}</span>
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
 * 返回 destroy：退订 SSE、清计时器（幂等）；销毁后不再写回容器，
 * 防止抽屉已关闭时迟到的响应还去改 DOM。
 */
export function renderFleetInto(container: HTMLElement): { destroy: () => void } {
  container.innerHTML = '<div class="loading">加载中…</div>';
  let disposed = false;

  const load = async () => {
    if (disposed) return;
    try {
      const ov = await api.get<Overview>('/overview');
      if (disposed) return; // 请求在途期间已被销毁：丢弃结果
      const lanes = Object.entries(ov.aggregates.lanes)
        .map(([lane, v]) => `<span class="lane-pill">${esc(lane)} <b>${v.count}</b>${v.limit ? `/${v.limit}` : ''}</span>`)
        .join('');
      container.innerHTML = `
        <div class="agg-bar">
          <span class="agg working">在岗 <b>${ov.aggregates.working}</b></span>
          <span class="agg idle">空闲 <b>${ov.aggregates.idle}</b></span>
          <span class="agg stale">断线 <b>${ov.aggregates.stale}</b></span>
          <span class="agg disabled">停用 <b>${ov.aggregates.disabled}</b></span>
          <span class="sep"></span>${lanes}
        </div>
        <div class="fleet">${ov.agents.length ? ov.agents.map(agentCardHtml).join('') : '<div class="empty">尚无 agent 注册——到「Agent 接入」注册第一个 worker</div>'}</div>`;
    } catch (err) {
      if (disposed) return;
      container.innerHTML = `<div class="empty">加载失败：${esc(err instanceof Error ? err.message : '')}</div>`;
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

/** 整页视图（#/fleet 深链兼容）：页头归页面，内容装配复用 renderFleetInto */
export function render(el: HTMLElement): void {
  el.innerHTML = `
    <div class="view-head"><h2>${icon.hive} Agent 总览</h2><span class="hint">纯事件投影——agent 无需为此额外上报</span></div>
    <div class="fleet-body"></div>`;
  const body = el.querySelector('.fleet-body') as HTMLElement;
  const handle = renderFleetInto(body);
  // 视图可通过挂载元素上的 __cleanup 钩子登记清理逻辑（main.ts mount 统一调用）
  (el as unknown as { __cleanup?: () => void }).__cleanup = handle.destroy;
}
