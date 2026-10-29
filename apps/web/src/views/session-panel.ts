import { api } from '../api.ts';
import { subscribe, onConnectionState } from '../sse.ts';
import { fmtTime } from '../ui.ts';
import type { Execution, SessionObservationEvent } from '../../../../packages/sdk/src/execution.ts';

type SessionSnapshot = {
  availability: 'not_enabled' | 'unsupported' | 'not_started' | 'streaming' | 'ended' | 'expired';
  executionId: string; events: SessionObservationEvent[]; cursor: number;
  oldestSequence: number | null; gap: boolean; receivedAt: number | null;
};
const AVAILABILITY: Record<SessionSnapshot['availability'], string> = {
  not_enabled: '尚未授权共享会话', unsupported: '此执行器暂不支持会话观察',
  not_started: '等待工蜂开始上报；旧工蜂需要升级', streaming: '正在接收会话事件',
  ended: '会话已结束，不代表任务已验收', expired: '会话片段已过期，无法恢复',
};

export function mountSessionPanel(host: HTMLElement, taskId: string): {
  setExecution: (execution: Execution | null) => void;
  dispose: () => void;
} {
  let disposed = false;
  let connected = false;
  let execution: Execution | null = null;
  let generation = 0;
  let cursor = 0;
  let loading = false;
  let pending = false;
  let enabled = false;
  let unavailable = '';
  const messages = new Map<string, { node: HTMLElement; blocks: Map<number, string> }>();
  const tools = new Map<string, HTMLElement>();
  host.innerHTML = `<h4>当前 Pi 会话（只读）</h4>
    <p class="muted small">仅经您启用后共享助手可见回复，可能含项目文字。思考、工具参数与结果不共享；代码块和可疑凭据片段隐藏。完整行经安全缓冲后显示，不逐字泄露前缀。会话片段最多保留 24 小时、512 条事件或 256 KiB，缺口不可恢复。</p>
    <button type="button" class="sm ghost" data-session-toggle>启用会话共享…</button>
    <p class="muted small" data-session-status role="status">暂无执行实例</p>
    <p class="muted small" data-session-gap hidden>会话存在缺口；以下片段不能视作完整历史。</p>
    <div data-session-log role="log" aria-label="会话可见片段" aria-live="polite" style="max-height: 320px; overflow: auto; overflow-wrap: anywhere;"></div>`;
  const button = host.querySelector<HTMLButtonElement>('[data-session-toggle]')!;
  const status = host.querySelector<HTMLElement>('[data-session-status]')!;
  const warning = host.querySelector<HTMLElement>('[data-session-gap]')!;
  const log = host.querySelector<HTMLElement>('[data-session-log]')!;
  const reset = () => { cursor = 0; messages.clear(); tools.clear(); log.replaceChildren(); warning.hidden = true; };
  const gap = () => {
    warning.hidden = false;
    messages.clear();
    tools.clear();
    const marker = document.createElement('p');
    marker.className = 'muted small';
    marker.textContent = '—— 会话缺口：未收到或已过期的内容不予补造 ——';
    log.append(marker);
  };
  const append = (event: SessionObservationEvent) => {
    if (event.gapBefore || event.kind === 'gap') gap();
    if (event.kind === 'assistant_start' || event.kind === 'assistant_text' || event.kind === 'assistant_end' || event.kind === 'redacted') {
      const id = event.messageId ?? 'hidden-message';
      let message = messages.get(id);
      if (!message) {
        const node = document.createElement('div');
        node.className = 'panel small';
        node.style.padding = '8px';
        node.style.marginBottom = '8px';
        node.style.whiteSpace = 'pre-wrap';
        node.textContent = event.kind === 'assistant_start' ? '助手\n' : '助手片段（前文可能未保留）\n';
        log.append(node);
        message = { node, blocks: new Map() };
        messages.set(id, message);
      }
      if (event.kind === 'assistant_text' && event.text !== undefined) {
        const index = event.contentIndex ?? 0;
        message.blocks.set(index, (message.blocks.get(index) ?? '') + event.text);
        message.node.textContent = '助手\n' + [...message.blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
      }
      if (event.kind === 'redacted') {
        const index = event.contentIndex ?? 0;
        message.blocks.set(index, (message.blocks.get(index) ?? '') + '[片段已隐藏：代码、凭据或无法安全展示的内容]\n');
        message.node.textContent = '助手\n' + [...message.blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
      }
    }
    if (event.kind === 'tool_start' || event.kind === 'tool_end') {
      const id = event.callId ?? `missing-${event.sequence}`;
      let node = tools.get(id);
      if (!node) { node = document.createElement('p'); node.className = 'small'; tools.set(id, node); log.append(node); }
      node.textContent = `${event.toolName ?? 'unknown'} · ${event.kind === 'tool_start' ? '执行中' : event.failed ? '失败' : '已结束'}（不展示参数或结果正文）`;
    }
  };
  const refresh = async () => {
    if (disposed || !host.isConnected || document.hidden) return;
    if (loading) { pending = true; return; }
    loading = true;
    const request = generation;
    try {
      const consent = await api.get<{ enabled: boolean }>(`/tasks/${encodeURIComponent(taskId)}/session-observation`);
      if (disposed || request !== generation) return;
      enabled = consent.enabled;
      button.textContent = enabled ? '停止会话共享' : '启用会话共享…';
      if (!enabled) { reset(); status.textContent = AVAILABILITY.not_enabled; return; }
      if (!execution) { status.textContent = '暂无执行实例，授权将在工蜂执行时生效'; return; }
      const snapshot = await api.get<SessionSnapshot>(`/tasks/${encodeURIComponent(taskId)}/executions/${encodeURIComponent(execution.id)}/session?after=${cursor}`);
      if (disposed || request !== generation) return;
      unavailable = AVAILABILITY[snapshot.availability];
      status.textContent = `${unavailable} · ${connected ? '实时连接正常' : '连接中断，显示最后快照'}${snapshot.receivedAt ? ` · 最后接收 ${fmtTime(snapshot.receivedAt)}` : ''}`;
      const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
      if (snapshot.gap) warning.hidden = false;
      if (snapshot.oldestSequence !== null && cursor < snapshot.oldestSequence - 1) gap();
      for (const event of snapshot.events) {
        if (event.sequence <= cursor) continue;
        append(event);
        cursor = event.sequence;
      }
      cursor = Math.max(cursor, snapshot.cursor);
      if (follow) log.scrollTop = log.scrollHeight;
    } catch (error) {
      if (!disposed && request === generation) status.textContent = `会话观察不可用：${error instanceof Error ? error.message : '读取失败'}`;
    } finally {
      loading = false;
      if (pending && !disposed) { pending = false; void refresh(); }
    }
  };
  button.addEventListener('click', async () => {
    const next = !enabled;
    if (next && !window.confirm('启用此任务的 Pi 会话共享？\n\n助手可见回复（可能含项目文字）会发送到 Hive，最多保留 24 小时。工具参数、结果正文、代码块及内部思考不共享；可疑片段隐藏。您可随时停止。')) return;
    button.disabled = true;
    try {
      await api.put(`/tasks/${encodeURIComponent(taskId)}/session-observation`, { enabled: next });
      reset();
      await refresh();
    } catch (error) { status.textContent = `设置失败：${error instanceof Error ? error.message : '请求失败'}`; }
    finally { button.disabled = false; }
  });
  const unsubscribe = subscribe((type, payload) => {
    if ((type === 'execution.session_updated' || type === 'execution.observation_consent') && payload.taskId === taskId) void refresh();
  });
  const disconnect = onConnectionState(online => {
    connected = online;
    if (!disposed && host.isConnected) {
      if (online) void refresh();
      else status.textContent = `${unavailable || '会话观察'} · 连接中断，显示最后快照`;
    }
  });
  void refresh();
  return {
    setExecution: (next) => {
      if (next?.id !== execution?.id) { generation++; reset(); }
      execution = next;
      void refresh();
    },
    dispose: () => { disposed = true; generation++; unsubscribe(); disconnect(); },
  };
}
