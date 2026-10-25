// 聊天主舞台组件：嵌入项目工作台左栏（主操作面），消息流限宽居中
// 由独立「聊天室」路由视图重构而来——消息渲染/发送/SSE 增量/目标下拉/自动 @前缀/目标态持久化逻辑不变；
// 变化点：① 板由宿主传入（opts.boardId），切板 = 宿主销毁重挂；② taskRef 点击回调宿主
//（opts.onTaskClick → 看板页开任务抽屉，同页联动），不再跳路由；③ UI 翻新：user 气泡右对齐、
// 头像角色状态点、composer 单行化、目标下拉移除「全体」并默认主脑。
import { api, type Message } from '../api.ts';
import { subscribe } from '../sse.ts';
import { esc, fmtTime, KIND_LABELS, agentsCached, roleOf, displayAuthor, toast } from '../ui.ts';
import { icon } from '../icons.ts';

// 内置主脑的 agent id（服务端 agents.ts BRAIN_AGENT_ID）：目标下拉里它有独立选项，不进 worker 列表
const BRAIN_AGENT_ID = 'asterhive-brain';
// 发送目标持久化键：跨会话记住"上次发给谁"（全局一份；落到不可选目标时自动回落主脑）
const MSG_TARGET_KEY = 'asterhive.msgTarget';

export interface ChatPanelOpts {
  /** 面板归属的看板（项目）id；宿主切板时销毁重挂 */
  boardId: string;
  /** 预填输入框（兼容旧 ?reply=T42 深链：填入 @主脑 引导语并聚焦） */
  replyTo?: string;
  /** 消息内任务号（taskRef）点击回调 → 宿主打开任务抽屉 */
  onTaskClick?: (taskId: string) => void;
}

export interface ChatPanelHandle {
  /** 宿主在参与者变更后刷新目标下拉（如看板管理里保存参与者） */
  refreshTargets: () => void;
  /** 宿主在卸载/切板时调用：退订 SSE，防止重复增量与泄漏 */
  destroy: () => void;
}

// kind 小标签仅这些类型展示（灰阶弱化）；日常 chat/question/progress/system 不打标
const BADGE_KINDS = new Set(['dispatch', 'submit', 'intervention', 'report']);

function messageHtml(m: Message, agents: Awaited<ReturnType<typeof agentsCached>>): string {
  const role = roleOf(m.author, agents);
  const name = esc(displayAuthor(m.author, agents));
  const content = esc(m.content)
    .replace(/@([\w\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)/g, '<span class="mention">@$1</span>')
    .replace(/\b([A-Z][A-Z0-9]*-?\d+)\b/g, (full) => {
      if (m.taskRef && full === m.taskRef) {
        // 不再跳路由：交给事件委托调 opts.onTaskClick（见下方 list 绑定）
        return `<a class="taskref" data-task="${esc(full)}">${esc(full)}</a>`;
      }
      return full;
    });
  const kindBadge = BADGE_KINDS.has(m.kind) ? `<span class="kind-badge">${KIND_LABELS[m.kind] ?? m.kind}</span>` : '';
  // 我的消息：右对齐气泡（accent 描边、右下 2px 圆角），不带头像
  if (m.author === 'user') {
    return `
    <div class="msg me kind-${m.kind}">
      <div class="bubble">
        <div class="meta"><b class="role-${role}">${name}</b><time>${fmtTime(m.createdAt)}</time></div>
        <div class="content">${content}</div>
      </div>
    </div>`;
  }
  // 其他作者：左对齐 + 头像（panel-2 底 + 首字符，角色状态点在头像右下角）
  return `
    <div class="msg kind-${m.kind}">
      <div class="avatar role-${role}"><span>${name.slice(0, 1)}</span><i class="avatar-dot"></i></div>
      <div class="bubble">
        <div class="meta"><b class="role-${role}">${name}</b>${kindBadge}<time>${fmtTime(m.createdAt)}</time></div>
        <div class="content">${content}</div>
      </div>
    </div>`;
}

export function mountChatPanel(container: HTMLElement, opts: ChatPanelOpts): ChatPanelHandle {
  const { boardId } = opts;
  container.innerHTML = '<div class="loading">加载中…</div>';

  let destroyed = false; // 防止异步初始化在销毁后仍写 DOM / 订阅
  let unsub: (() => void) | null = null;
  let refreshTargetsImpl: () => void = () => {}; // 面板渲染完成前的占位
  let cleanupImpl: () => void = () => {}; // 指示行/流式气泡清理（渲染完成前为占位空操作）

  void (async () => {
    const agents = await agentsCached();
    if (destroyed) return;

    // 主脑显示身份（思考指示行/流式气泡头像用）：与消息渲染同一套 roleOf/displayAuthor
    const brainName = displayAuthor(BRAIN_AGENT_ID, agents);
    const brainRole = roleOf(BRAIN_AGENT_ID, agents);

    // composer 单行化：目标 pill + 自适应输入框 + 方形发送按钮；提示小字挪进 select 的 title
    container.innerHTML = `
      <div class="messages"></div>
      <div class="composer">
        <div class="composer-row">
          <select class="composer-target" title="发送目标：选主脑=找它调度；选 worker=直接派活/干预，主脑仍会同步收到"></select>
          <textarea class="composer-input" rows="1" placeholder="说点什么…（Enter 发送，Shift+Enter 换行；@某人 定向，@主脑 找主脑）"></textarea>
          <button class="composer-send" title="发送">${icon.send}</button>
        </div>
      </div>`;

    const list = container.querySelector('.messages') as HTMLElement;
    const input = container.querySelector('.composer-input') as HTMLTextAreaElement;
    const targetSelect = container.querySelector('.composer-target') as HTMLSelectElement;
    let msgTarget = localStorage.getItem(MSG_TARGET_KEY) ?? '主脑'; // 默认发给主脑

    // 输入框自适应：输入时按内容撑高（封顶 220px ≈ 十行，让长提示词完整可读），
    // 发送/清空后弹回初始高度
    const fitInput = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    };
    input.addEventListener('input', fitInput);

    // 目标下拉选项：主脑固定第一项（默认目标）+ 该项目的启用 agent（「全体」选项已按需求移除）。
    // 数据规则：GET /agents（已排除 user）过滤 enabled 且排除内置主脑（主脑有独立选项），
    // 再 GET /boards/:b/participants——agentIds 非空则只列其中，为空则开放全部。
    const refreshTargets = async () => {
      let pool = agents.filter((a) => a.enabled && a.id !== BRAIN_AGENT_ID);
      try {
        const part = await api.get<{ agentIds: string[] }>(`/boards/${boardId}/participants`);
        if (part.agentIds.length > 0) {
          const allow = new Set(part.agentIds);
          pool = pool.filter((a) => allow.has(a.id));
        } // 空数组 = 该板开放给全部启用 agent
      } catch {
        /* 参与者拉取失败：退化为列全部启用 agent */
      }
      const saved = msgTarget;
      targetSelect.innerHTML =
        `<option value="主脑">主脑</option>` +
        pool.map((a) => `<option value="${esc(a.handle)}">@${esc(a.handle)}（${esc(a.name)}）</option>`).join('');
      // 记住的目标不在本项目可选范围（切板/被移出参与者/已停用，含旧版存过的「全体」空值）→ 回落主脑
      if (![...targetSelect.options].some((o) => o.value === saved)) msgTarget = '主脑';
      targetSelect.value = msgTarget;
    };
    refreshTargetsImpl = () => void refreshTargets();
    await refreshTargets();

    targetSelect.addEventListener('change', () => {
      msgTarget = targetSelect.value;
      localStorage.setItem(MSG_TARGET_KEY, msgTarget);
    });

    const scrollToBottom = () => {
      list.scrollTop = list.scrollHeight;
    };

    // taskRef 点击委托：整条消息列表一个监听器（消息会整段重渲，委托比逐条绑定稳）
    list.addEventListener('click', (ev) => {
      const a = (ev.target as HTMLElement).closest('a.taskref') as HTMLElement | null;
      if (!a) return;
      ev.preventDefault();
      opts.onTaskClick?.(a.dataset.task!);
    });

    // ---- 功能A：主脑"思考中"指示行 ----
    // 生命周期：brain.turn_started 显示 → brain.turn_finished / brain.error / 主脑消息到达 撤除
    //（多路撤除是防事件乱序/异常轮残留的双保险）。计时秒数每秒递增。
    let thinkingRow: HTMLElement | null = null;
    let thinkingTimer: ReturnType<typeof setInterval> | null = null;
    let thinkingSeconds = 0;

    const showThinking = (elapsedSeconds = 0) => {
      if (thinkingRow) return; // 已在显示（恢复场景防重复）
      thinkingSeconds = elapsedSeconds;
      const row = document.createElement('div');
      row.className = 'thinking-indicator';
      row.innerHTML = `
        <div class="avatar role-${brainRole}"><span>${esc(brainName.slice(0, 1))}</span><i class="avatar-dot"></i></div>
        <div class="thinking-bubble">
          <span class="thinking-dots"><i></i><i></i><i></i></span>
          <span>主脑思考中…</span>
          <span class="thinking-elapsed"></span>
        </div>`;
      thinkingRow = row;
      list.appendChild(row);
      const elapsedEl = row.querySelector('.thinking-elapsed') as HTMLElement;
      elapsedEl.textContent = `${thinkingSeconds}s`;
      thinkingTimer = setInterval(() => {
        thinkingSeconds += 1;
        elapsedEl.textContent = `${thinkingSeconds}s`;
      }, 1000);
      scrollToBottom();
    };

    const hideThinking = () => {
      if (thinkingTimer !== null) {
        clearInterval(thinkingTimer);
        thinkingTimer = null;
      }
      thinkingRow?.remove();
      thinkingRow = null;
      thinkingSeconds = 0;
    };

    // ---- 功能B：主脑流式回复气泡 ----
    // 生命周期：brain.stream phase='streaming' 创建/更新全文（textContent 替换渲染，免乱序）；
    // phase='end' 或主脑正式消息（message.created）到达 → 撤除，正式消息由既有流程照常插入。
    let streamRow: HTMLElement | null = null;
    let streamContent: HTMLElement | null = null;
    let streamSuppressed = false; // 正式消息已插入：本轮剩余流式增量不再显示（end / 下一轮 turn_started 复位）

    const showStreamBubble = (text: string) => {
      if (!streamRow) {
        const row = document.createElement('div');
        row.className = 'msg stream-msg';
        row.innerHTML = `
          <div class="avatar role-${brainRole}"><span>${esc(brainName.slice(0, 1))}</span><i class="avatar-dot"></i></div>
          <div class="bubble stream-bubble">
            <div class="meta"><b class="role-${brainRole}">${esc(brainName)}</b><span class="stream-hint">正在回复…</span></div>
            <div class="content stream-content"></div>
          </div>`;
        streamRow = row;
        streamContent = row.querySelector('.stream-content') as HTMLElement;
        list.appendChild(row);
      }
      if (streamContent) streamContent.textContent = text;
      scrollToBottom();
    };

    const hideStreamBubble = () => {
      streamRow?.remove();
      streamRow = null;
      streamContent = null;
    };

    // 卸载清理：destroy 时停计时器、撤节点（SSE 已随 unsub 退订），防闭包持有旧 DOM 继续跑
    cleanupImpl = () => {
      hideThinking();
      hideStreamBubble();
    };

    const renderAll = (msgs: Message[]) => {
      list.innerHTML = msgs.map((m) => messageHtml(m, agents)).join('');
      // 整段重渲会清掉尾部指示行/流式气泡：仍活跃则原节点挂回（引用不变，计时/状态不丢）
      if (thinkingRow) list.appendChild(thinkingRow);
      if (streamRow) list.appendChild(streamRow);
      scrollToBottom();
    };

    // 先订阅再拉全量：订阅与 GET 响应之间的新消息由 SSE 补一条，
    // 随后 load 的整段重渲会以服务端事实去重，不会出现双份
    if (destroyed) return; // 宿主已销毁（如切板）：不再订阅，防泄漏
    unsub = subscribe((type, payload) => {
      if (type === 'message.created' && payload.boardId === boardId) {
        list.insertAdjacentHTML(
          'beforeend',
          messageHtml(
            {
              id: Number(payload.messageId),
              boardId: String(payload.boardId),
              author: String(payload.author),
              kind: String(payload.kind),
              mentions: (payload.mentions as string[]) ?? [],
              taskRef: (payload.taskRef as string) ?? null,
              content: String(payload.content),
              createdAt: Number(payload.time ?? Date.now()),
            },
            agents,
          ),
        );
        scrollToBottom();
        // 主脑正式消息已插入：撤"思考中"指示与流式气泡（与 turn_finished/end 双保险，防乱序残留）；
        // 本轮剩余流式增量不再显示（正式消息已在上方），end / 下一轮 turn_started 复位
        if (String(payload.author) === BRAIN_AGENT_ID) {
          hideThinking();
          hideStreamBubble();
          streamSuppressed = true;
        }
        return;
      }
      if (type === 'brain.turn_started') {
        streamSuppressed = false; // 新轮开始：解除上一轮的增量抑制
        showThinking();
        return;
      }
      if (type === 'brain.turn_finished' || type === 'brain.error') {
        hideThinking(); // 轮次结束/上游异常（异常轮没有 turn_finished，brain.error 兜底）
        return;
      }
      if (type === 'brain.stream' && payload.boardId === boardId) {
        if (payload.phase === 'end') {
          hideStreamBubble();
          streamSuppressed = false;
          return;
        }
        // streaming：主脑已开始输出 → 撤"思考中"指示行，改显流式气泡
        hideThinking();
        if (streamSuppressed) return;
        showStreamBubble(typeof payload.text === 'string' ? payload.text : '');
      }
    });

    try {
      const r = await api.get<{ messages: Message[] }>(`/boards/${boardId}/messages?limit=300`);
      if (destroyed) return;
      renderAll(r.messages);
    } catch (err) {
      container.innerHTML = `<div class="empty">聊天加载失败：${esc(err instanceof Error ? err.message : '')}<br/>请确认服务已启动。</div>`;
      return;
    }

    // 恢复检查：页面在主脑轮次中刷新/重开时 SSE 只送增量、缺起始事件——
    // 对比台账最近一次 brain.turn_started / brain.turn_finished，前者更新 = 轮仍活跃 → 恢复
    // 指示行（已进行秒数按事件时间补算）。brain.stream 是瞬态事件不入台账，不恢复流式文本
    //（该轮的正式消息到达时照常显示，不会丢内容）。
    try {
      const [started, finished] = await Promise.all([
        api.get<{ events: { id: number; time_created: number }[] }>(
          '/api/events?type=brain.turn_started&limit=1',
        ),
        api.get<{ events: { id: number; time_created: number }[] }>(
          '/api/events?type=brain.turn_finished&limit=1',
        ),
      ]);
      if (destroyed) return; // 宿主已销毁：cleanupImpl 已在 destroy() 里清掉一切
      const s = started.events[0];
      const f = finished.events[0];
      if (s && (!f || f.id < s.id)) {
        showThinking(Math.max(0, Math.round((Date.now() - s.time_created) / 1000)));
      }
    } catch {
      /* 事件台账不可达：跳过恢复，会话内实时事件照常驱动 */
    }

    const send = async () => {
      let content = input.value.trim();
      if (!content) return;
      // 定向发言：用户尚未手写 @目标 开头 → 自动前置（已手写则不重复加）
      if (msgTarget && !content.startsWith(`@${msgTarget}`)) {
        content = `@${msgTarget} ${content}`;
      }
      try {
        await api.post(`/boards/${boardId}/messages`, { content });
        input.value = '';
        fitInput(); // 清空后弹回单行
      } catch (err) {
        toast(`发送失败：${err instanceof Error ? err.message : ''}`, true);
      }
    };
    (container.querySelector('.composer-send') as HTMLElement).addEventListener('click', () => void send());
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void send();
      }
    });

    // 兼容旧 ?reply= 深链（如从卡片回复入口进入）：预填引导语并聚焦
    if (opts.replyTo) {
      input.value = `@主脑 关于 ${opts.replyTo}：`;
      fitInput();
      input.focus();
    }
  })();

  return {
    refreshTargets: () => refreshTargetsImpl(),
    destroy: () => {
      destroyed = true;
      unsub?.();
      unsub = null;
      cleanupImpl(); // 停计时器、撤"思考中"指示行/流式气泡（容器 DOM 即将被宿主丢弃，防闭包泄漏）
    },
  };
}
