import { api, type Task } from '../api.ts';
import { subscribe, onConnectionState } from '../sse.ts';
import { esc, fmtTime } from '../ui.ts';
import type { Execution, ExecutionState } from '../../../../packages/sdk/src/execution.ts';
import { mountSessionPanel } from './session-panel.ts';

const STATES: Record<ExecutionState, string> = {
  dispatched: '已指定，等待接收', accepted: '已接收', running: '执行中',
  waiting_model: '等待模型', waiting_tool: '等待工具', waiting_user: '等待用户',
  awaiting_review: '执行结束，等待验收', failed: '执行失败', cancelling: '取消中，尚未确认物理停止',
  cancelled: '已确认取消', unknown: '结果未知', completed: '已验收',
};

function time(value: number | null): string {
  return value === null ? '未知 / 尚未记录' : fmtTime(value);
}

/** One task drawer owns this subscription; reopening or navigating disposes it. */
export function mountExecutionPanel(host: HTMLElement, task: Task): () => void {
  let disposed = false;
  let loading = false;
  let refreshAgain = false;
  let connected = false;
  let selectedId = '';
  let executions: Execution[] = [];
  let latestTask = task;
  let lastReceivedAt: number | null = null;
  let eventSummary = '';
  const taskPath = `/tasks/${encodeURIComponent(task.id)}`;
  host.innerHTML = `<h4>执行实例与观察</h4><p data-execution-connection class="muted small"></p><div data-execution-content>正在读取执行记录…</div><div data-execution-session style="margin-top: 16px;"></div>`;
  const sessionHost = host.querySelector<HTMLElement>('[data-execution-session]')!;
  const sessionPanel = mountSessionPanel(sessionHost, task.id);
  const connection = host.querySelector<HTMLElement>('[data-execution-connection]')!;
  const content = host.querySelector<HTMLElement>('[data-execution-content]')!;
  const render = () => {
    connection.textContent = `${connected ? '实时连接已建立' : '实时连接中断，以下为最后快照'} · 最近接收 ${time(lastReceivedAt)}`;
    if (!executions.length) {
      content.textContent = '暂无执行实例；未开始或旧任务尚无可恢复记录。';
      return;
    }
    const current = executions[0];
    const selected = executions.find(e => e.id === selectedId) ?? current;
    const historical = selected.id !== current.id;
    const progress = latestTask.progress;
    const offline = !historical && progress?.status === 'offline';
    const stale = !historical && progress?.status === 'no_recent_activity';
    const elapsed = Math.max(0, Math.floor(((selected.endedAt ?? Date.now()) - (selected.startedAt ?? selected.createdAt)) / 1000));
    const phaseSeconds = Math.max(0, Math.floor((Date.now() - selected.phaseSince) / 1000));
    const waiting = selected.state.startsWith('waiting_');
    content.innerHTML = `
      <div class="field"><label for="execution-history">执行轮次</label>
        <select id="execution-history">${executions.map((e, index) => `<option value="${esc(e.id)}"${e.id === selected.id ? ' selected' : ''}>第 ${e.attempt} 轮 · ${index === 0 ? '当前' : '历史'} · @${esc(e.workerId)}</option>`).join('')}</select>
      </div>
      <div class="progress-panel">
        <p role="status"><b>${historical ? '历史执行 · ' : ''}${esc(STATES[selected.state])}</b>${selected.waitingFor ? ` · ${esc(selected.waitingFor)}` : ''}</p>
        ${offline ? '<p class="muted">工蜂失联，当前结果未知。下列阶段仅为最后观测，不证明仍在执行或已经停止。</p>' : ''}
        ${stale ? '<p class="muted">近期未观察到新活动；保活不等于实际进展。</p>' : ''}
        <dl class="small">
          <dt>执行 ID</dt><dd><code>${esc(selected.id)}</code></dd>
          <dt>仓库基线</dt><dd><code>${esc(selected.baseCommit ?? '未知')}</code></dd>
          <dt>执行器</dt><dd>${esc(selected.executor ?? '未知')}</dd>
          <dt>接收 / 开始 / 结束</dt><dd>${time(selected.acceptedAt)} / ${time(selected.startedAt)} / ${time(selected.endedAt)}</dd>
          <dt>本轮耗时</dt><dd>${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒${!historical && waiting && !offline ? ` · 当前等待 ${Math.floor(phaseSeconds / 60)} 分 ${phaseSeconds % 60} 秒` : ''}</dd>
          <dt>工蜂最近心跳${historical ? '（设备当前值，非历史心跳）' : ''}</dt><dd>${time(progress?.workerLastSeenAt ?? null)}</dd>
          <dt>最近可观察活动</dt><dd>${time(selected.lastActivityAt)}</dd>
          <dt>最近主动里程碑</dt><dd>${time(selected.lastMilestoneAt)}</dd>
        </dl>
        <p class="muted small">${esc(eventSummary)}</p>
      </div>`;
    content.querySelector<HTMLSelectElement>('#execution-history')!.addEventListener('change', (event) => {
      selectedId = (event.target as HTMLSelectElement).value;
      void refresh();
    });
    sessionPanel.setExecution(selected);
  };
  const refresh = async () => {
    if (disposed || document.hidden || !host.isConnected) return;
    if (loading) { refreshAgain = true; return; }
    loading = true;
    try {
      const [instances, snapshot] = await Promise.all([
        api.get<{ executions: Execution[] }>(`${taskPath}/executions`),
        api.get<{ task: Task }>(taskPath),
      ]);
      if (disposed || !host.isConnected) return;
      executions = instances.executions;
      latestTask = snapshot.task;
      const selected = executions.find(e => e.id === selectedId) ?? executions[0];
      if (selected) {
        const history = await api.get<{ events: { kind: string }[]; cursor: number }>(`${taskPath}/executions/${encodeURIComponent(selected.id)}/events`);
        eventSummary = history.events.some(e => e.kind === 'gap')
          ? '活动记录存在缺口；不可将缺失部分视为连续执行。'
          : '显示服务端已收到的执行状态；执行结束不等于审核通过。';
      }
      if (disposed || !host.isConnected) return;
      lastReceivedAt = Date.now();
      render();
    } catch (error) {
      if (!disposed && host.isConnected) {
        connection.textContent = `执行观察暂不可用 · ${error instanceof Error ? error.message : '读取失败'} · 最后接收 ${time(lastReceivedAt)}`;
      }
    } finally {
      loading = false;
      if (refreshAgain && !disposed) { refreshAgain = false; void refresh(); }
    }
  };
  const unsubscribe = subscribe((type, payload) => {
    if (payload.taskId === task.id && (type.startsWith('task.') || type === 'execution.updated')) void refresh();
    if (type === 'agent.disabled' || type === 'agent.enabled') void refresh();
  });
  const disconnect = onConnectionState((online) => {
    connected = online;
    if (!disposed) {
      render();
      if (online) void refresh();
    }
  });
  const interval = setInterval(() => { if (!disposed && !document.hidden) { render(); void refresh(); } }, 5000);
  const visible = () => { if (!document.hidden) void refresh(); };
  document.addEventListener('visibilitychange', visible);
  void refresh();
  return () => {
    disposed = true;
    unsubscribe();
    disconnect();
    clearInterval(interval);
    document.removeEventListener('visibilitychange', visible);
    sessionPanel.dispose();
  };
}
