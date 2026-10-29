// SSE 接入层：命名事件统一分发；EventSource 断线自动重连
export type SseHandler = (type: string, payload: Record<string, unknown>) => void;

const KNOWN_EVENTS = [
  'server.started',
  'server.restored',
  'snapshot.manual',
  'agent.registered',
  'agent.enabled',
  'agent.telemetry',
  'agent.disabled',
  'board.created',
  'board.updated',
  'board.deleted', // 项目子导航依赖：看板增删改只重建侧栏 nav 区
  'task.created',
  'task.updated',
  'task.lane_changed',
  'task.auto_unlocked',
  'task.depends_added',
  'task.dispatched',
  'task.claimed',
  'task.checkpoint',
  'task.released',
  'task.ttl_released',
  'task.submitted',
  'execution.updated',
  'execution.session_updated',
  'execution.observation_consent',
  'message.created',
  'settings.orchestrator_updated',
  // 蜂后体验：思考中指示（A）与流式回复（B）。brain.stream 为瞬态事件（服务端直接总线发布，不入台账）
  'brain.turn_started',
  'brain.turn_finished',
  'brain.stream',
  'brain.error', // 上游模型异常轮：无 turn_finished，收到即撤"思考中"指示防残留
  'brain.turn_aborted', // 用户主动停止当前轮次：收到即撤指示行/流式气泡（turn_finished 随后照常到达）
];

const handlers = new Set<SseHandler>();
let source: EventSource | null = null;
const stateListeners = new Set<(connected: boolean) => void>();

export function onConnectionState(fn: (connected: boolean) => void): () => void {
  if (source) fn(source.readyState === EventSource.OPEN);
  return () => stateListeners.delete(fn);
}
export function startSse(): void {
  if (source) return;
  source = new EventSource('/events');
  source.onopen = () => {
    for (const fn of stateListeners) fn(true);
  };
  source.onerror = () => {
    for (const fn of stateListeners) fn(false);
  };
  const dispatch = (type: string) => (ev: MessageEvent) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      /* heartbeat 等 非 JSON 帧 */
    }
    for (const fn of handlers) fn(type, payload);
  };
  for (const name of KNOWN_EVENTS) {
    source.addEventListener(name, dispatch(name) as EventListener);
  }
}

export function subscribe(fn: SseHandler): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}
