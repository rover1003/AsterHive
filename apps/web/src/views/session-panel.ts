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
const MAX_WINDOW_EVENTS = 512;
const MAX_WINDOW_BYTES = 256 * 1024;
const SESSION_RETENTION_MS = 24 * 60 * 60_000;
const encoder = new TextEncoder();

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
  const messages = new Map<string, { node: HTMLElement; blocks: Map<number, HTMLElement> }>();
  const tools = new Map<string, HTMLElement>();
  const retained: { event: SessionObservationEvent; bytes: number; receivedAt: number }[] = [];
  let retainedBytes = 0;
  let historyGap = false;
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
  const prune = (): boolean => {
    const now = Date.now();
    let trimmed = false;
    while (retained.length && now - retained[0].receivedAt > SESSION_RETENTION_MS) {
      retainedBytes -= retained.shift()!.bytes;
      trimmed = true;
    }
    while (retained.length > MAX_WINDOW_EVENTS || retainedBytes > MAX_WINDOW_BYTES) {
      retainedBytes -= retained.shift()!.bytes;
      trimmed = true;
    }
    if (trimmed) {
      historyGap = true;
      log.replaceChildren();
      gap(`—— 更早内容已超出本地保留窗口（${MAX_WINDOW_EVENTS} 条事件 / ${MAX_WINDOW_BYTES / 1024} KiB）或超过 24 小时已过期，仅显示最近有效片段 ——`);
      for (const frame of retained) append(frame.event);
    }
    return trimmed;
  };
  const reset = () => {
    cursor = 0;
    retained.length = 0;
    retainedBytes = 0;
    historyGap = false;
    messages.clear();
    tools.clear();
    log.replaceChildren();
    warning.hidden = true;
  };
  const gap = (markerText = '—— 会话缺口：未收到或已过期的内容不予补造 ——') => {
    warning.hidden = false;
    messages.clear();
    tools.clear();
    const marker = document.createElement('p');
    marker.className = 'muted small';
    marker.textContent = markerText;
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
      if (event.kind === 'assistant_text' || event.kind === 'redacted') {
        const index = event.contentIndex ?? 0;
        let block = message.blocks.get(index);
        if (!block) {
          block = document.createElement('span');
          block.dataset.contentIndex = String(index);
          block.style.display = 'block';
          const next = [...message.node.children].find(child => Number(child.getAttribute('data-content-index')) > index);
          message.node.insertBefore(block, next ?? null);
          message.blocks.set(index, block);
        }
        const part = document.createElement('span');
        part.dataset.sessionKey = `frame:${event.sequence}`;
        part.textContent = event.kind === 'redacted'
          ? '[片段已隐藏：代码、凭据或无法安全展示的内容]\n'
          : event.text ?? '';
        block.append(part);
      }
    }
    if (event.kind === 'tool_start' || event.kind === 'tool_end') {
      const id = event.callId ?? `missing-${event.sequence}`;
      let node = tools.get(id);
      if (!node) { node = document.createElement('p'); node.className = 'small'; tools.set(id, node); log.append(node); }
      node.dataset.sessionKey = `tool:${id}`;
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
      if (snapshot.availability === 'not_enabled' || snapshot.availability === 'expired') {
        reset();
        return;
      }
      const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
      const viewportTop = log.getBoundingClientRect().top;
      const anchor = [...log.querySelectorAll<HTMLElement>('[data-session-key]')]
        .find(node => node.getBoundingClientRect().bottom > viewportTop);
      const anchorKey = anchor?.dataset.sessionKey;
      const anchorTop = anchor?.getBoundingClientRect().top;
      const previousLength = retained.length;
      const now = snapshot.receivedAt ?? Date.now();
      historyGap ||= snapshot.gap;
      for (const event of snapshot.events) {
        if (event.sequence <= cursor) continue;
        const frame = event.sequence > cursor + 1 ? { ...event, gapBefore: true } : event;
        historyGap ||= frame.gapBefore === true || frame.kind === 'gap';
        const bytes = encoder.encode(JSON.stringify(frame)).byteLength;
        retained.push({ event: frame, bytes, receivedAt: now });
        retainedBytes += bytes;
        cursor = event.sequence;
      }
      cursor = Math.max(cursor, snapshot.cursor);
      const trimmed = prune();
      if (!trimmed) {
        for (let index = previousLength; index < retained.length; index++) append(retained[index].event);
      }
      warning.hidden = !historyGap;
      if (follow) log.scrollTop = log.scrollHeight;
      else if (anchorKey !== undefined && anchorTop !== undefined) {
        const current = [...log.querySelectorAll<HTMLElement>('[data-session-key]')]
          .find(node => node.dataset.sessionKey === anchorKey);
        if (current) log.scrollTop += current.getBoundingClientRect().top - anchorTop;
        else if (trimmed) log.scrollTop = 0;
      }
    } catch (error) {
      if (!disposed && request === generation && enabled) status.textContent = `会话观察不可用：${error instanceof Error ? error.message : '读取失败'}`;
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
      generation++;
      enabled = next;
      reset();
      button.textContent = enabled ? '停止会话共享' : '启用会话共享…';
      if (!enabled) status.textContent = AVAILABILITY.not_enabled;
      await refresh();
    } catch (error) { status.textContent = `设置失败：${error instanceof Error ? error.message : '请求失败'}`; }
    finally { button.disabled = false; }
  });
  const unsubscribe = subscribe((type, payload) => {
    if (payload.taskId !== taskId) return;
    if (type === 'execution.observation_consent') {
      generation++;
      enabled = payload.enabled === true;
      reset();
      button.textContent = enabled ? '停止会话共享' : '启用会话共享…';
      if (!enabled) status.textContent = AVAILABILITY.not_enabled;
    }
    if (type === 'execution.session_updated' || type === 'execution.observation_consent') void refresh();
  });
  const disconnect = onConnectionState(online => {
    connected = online;
    if (!disposed && host.isConnected) {
      if (online) void refresh();
      else status.textContent = `${unavailable || '会话观察'} · 连接中断，显示最后快照`;
    }
  });
  const visible = () => {
    if (document.hidden || disposed || !host.isConnected) return;
    prune();
    void refresh();
  };
  document.addEventListener('visibilitychange', visible);
  const expiry = setInterval(() => {
    if (disposed || !host.isConnected) return;
    prune();
  }, 30_000);
  void refresh();
  return {
    setExecution: (next) => {
      if (next?.id !== execution?.id) { generation++; reset(); }
      execution = next;
      void refresh();
    },
    dispose: () => {
      disposed = true;
      generation++;
      clearInterval(expiry);
      document.removeEventListener('visibilitychange', visible);
      unsubscribe();
      disconnect();
      reset();
      execution = null;
    },
  };
}
