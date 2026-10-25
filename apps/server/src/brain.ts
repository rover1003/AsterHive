// 内置主脑（T14，模式 B）：服务器内嵌一个 Pi agent 常驻"主脑"——
// 只做拆解建卡/分派/验收/汇报，绝不执行任务。
//
// 结构性约束（不依赖 prompt 自觉）：
// - 会话以 noTools:'builtin' 创建，内置 read/bash/edit/write 等工具全部关闭；
// - customTools 只注册 orchestrator-tools.ts 的 15 个星巢协议工具，别无其他；
// - actor 是 role='orchestrator' 的系统 agent，领域层对其禁用 claim/next 等执行动词。
//
// Pi SDK 实际 API 与调研报告（docs/research/pi-plugins.md）的差异，以类型定义为准：
//   - 工具注册不用扩展工厂的 pi.registerTool，而是 createAgentSession({ customTools }) 直接传
//     ToolDefinition[]（见 dist/core/sdk.d.ts；调研中"allowlist 门控扩展"因此也不需要——
//     工具面本身受限）；
//   - 自定义 OpenAI 兼容 provider 不走 models.json 文件，而是 ModelRuntime.registerProvider()
//     程序化注册（见 dist/core/provider-composer.d.ts ProviderConfigInput + docs/custom-provider.md），
//     apiKey 用解密后的字面量，不落盘；
//   - 会话持久化用 SessionManager.continueRecent(cwd, sessionDir)——崩溃重启后自动续接
//     最近的 JSONL 会话（examples/sdk/11-sessions.ts）；
//   - 中途注入用 session.steer()（返回 'queued' | 'handled'，见 dist/core/agent-session.d.ts）；
//   - 技能挂载：DefaultResourceLoaderOptions.additionalSkillPaths?: string[]（dist/core/
//     resource-loader.d.ts）支持目录路径，Pi 递归扫描找 SKILL.md（dist/core/skills.d.ts）。
//     挂载点 = <dataDir>/pi-runtime/skills/。注意两个运行时事实（实现注释均落在对应行）：
//     ① Pi 默认系统提示词的 <skills> 段只在会话声明了 read/bash 读文件工具时渲染
//        （dist/core/system-prompt.js skillFileReadTool），主脑 noTools:'builtin' 无执行面，
//        故技能清单不会出现在主脑系统提示词里——挂载依然生效于资源加载器（loader.getSkills()
//        可见、自定义扩展可读），这是有意为之：主脑不读文件，技能内容不该诱使其尝试执行面；
//     ② session.prompt() 默认展开轮首 /skill:<名>（agent-session.js _expandSkillCommand，
//        由 Pi 进程读文件全文注入该轮 prompt，与工具面无关）——为将来 UI 触发的定向调用预留。
//     自定义工具扩展走 extensions/（additionalExtensionPaths，工厂签名见 examples/brain-extension/）。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type, type TSchema } from 'typebox';
import type { ZodType } from 'zod';
import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { withWrite, logEvent } from './write.ts';
import { ensureBrainAgent, BRAIN_AGENT_ID, type Agent } from './agents.ts';
import { getOrchestratorSettings, activeGroup, type ActiveOrchestratorGroup } from './settings.ts';
import { messageInner } from './messages.ts';
import { TOOL_DEFS, type ToolDef } from './orchestrator-tools.ts';
import { listBoards, listTasks, LANES } from './tasks.ts';
import type { PiRuntimeManager } from './pi-runtime.ts';

// 单轮超时（默认 10 分钟）；去抖默认 3 秒——测试用环境变量缩短。
const TURN_TIMEOUT_MS = Number(process.env.ASTERHIVE_BRAIN_TURN_TIMEOUT_MS ?? 600_000);
const DEBOUNCE_MS = Number(process.env.ASTERHIVE_BRAIN_DEBOUNCE_MS ?? 3_000);

// brain.stream 流式发布：300ms 尾随节流 + 超 4000 字截断（节流器 opts 可注入覆盖，测试用）。
const STREAM_INTERVAL_MS = 300;
const STREAM_MAX_CHARS = 4000;

// ---- brain.stream 发布节流器（纯函数：可注入时钟/定时器，测试不睡真实时间）----
// 契约（web 端按此渲染流式气泡）：
// - 每次增量到达 push() 当前 assistant 全文（推全文而非 delta，web 直接替换渲染，免乱序）；
// - 尾随节流：首个增量开 300ms 窗口，窗口内后续增量只更新待发文本，到期合并发布一次
//   （窗口内多次增量只发布一次，内容为窗口末最新全文）；
// - 发布帧 text 超过 maxChars 截断尾部加 …（前端展示用截断，不影响真实消息）；
// - end()：清挂起定时器，若有未发布余量先补发一次全文，再发布 phase:'end'；
// - 从未 push（纯工具轮/无产出轮）→ end() 一帧不发。
// 帧不含 boardId：由调用方（Brain）闭包补充——纯函数只关心节流与截断。

export type BrainStreamFrame = { phase: 'streaming'; text: string } | { phase: 'end' };

export interface ThrottledStreamOpts {
  intervalMs?: number; // 节流窗口，默认 300
  maxChars?: number; // 发布文本截断阈值，默认 4000
  setTimer?: (fn: () => void, ms: number) => unknown; // 定时器注入（默认 setTimeout）
  clearTimer?: (handle: unknown) => void; // 定时器清理注入（默认 clearTimeout）
}

export interface ThrottledStream {
  /** 增量到达：记录当前 assistant 全文，300ms 窗口合并发布 */
  push: (fullText: string) => void;
  /** 轮次结束：补发全文余量 + phase:'end'；无产出轮一帧不发 */
  end: () => void;
}

export function throttledStreamPublish(
  publish: (frame: BrainStreamFrame) => void,
  opts: ThrottledStreamOpts = {},
): ThrottledStream {
  const intervalMs = opts.intervalMs ?? STREAM_INTERVAL_MS;
  const maxChars = opts.maxChars ?? STREAM_MAX_CHARS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let last = ''; // 最近一次增量到达时的 assistant 全文
  let produced = false; // 本轮是否出现过增量（决定 end() 是否发帧）
  let dirty = false; // 是否有尚未发布的增量
  let timer: unknown = null; // 挂起的节流定时器（null = 窗口未开）

  const truncate = (text: string): string => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);

  const fire = (): void => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    publish({ phase: 'streaming', text: truncate(last) });
  };

  return {
    push(fullText) {
      last = fullText;
      produced = true;
      dirty = true;
      if (timer === null) timer = setTimer(fire, intervalMs); // 尾随节流：窗口只开一次，不因后续增量顺延
    },
    end() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (!produced) return; // 无产出轮：一帧不发
      if (dirty) {
        dirty = false;
        publish({ phase: 'streaming', text: truncate(last) }); // 补发窗口未到期的余量全文
      }
      publish({ phase: 'end' });
    },
  };
}

// 提取 assistant 消息的累积全文（text 块拼接；thinking/toolCall 块不进聊天流）。
// message_update 事件的 message 即 SDK 维护的累积消息——直接取全文，比手工拼 delta 更稳：
// 即使错过个别 text_delta 也不会丢字。
type StreamAssistantMessage = Extract<AgentSessionEvent, { type: 'message_update' }>['message'];

function assistantText(message: StreamAssistantMessage): string {
  const content = (message as { content?: ReadonlyArray<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text ?? '')
    .join('');
}

// ---- 主脑系统提示（角色纪律）----

const BRAIN_SYSTEM_PROMPT = `你是 AsterHive（星巢）的内置主脑（@主脑）——舰队的大脑、唯一的调度者与验收者。
你的产出只有五种：追问、任务卡、分派、验收结论、汇报。其余一切都不是你的工作。

## 身份边界（结构性约束，不是自觉）
你可用的工具只有 15 个 asterhive_* 协议工具；没有 shell、文件读写、浏览器等任何执行面。
claim/next/checkpoint/submit 是 worker 的动词，你调用会被领域层 403，绝不尝试绕过。
推论：哪怕一件事你"顺手就能做"——写一段代码、跑一条命令、查一个网页——也必须建成卡
分派给 worker。你永远不参与任何实际的具体任务；你亲手干活的那一刻就是系统失职的那一刻。

## 纪律一：先澄清真实意图，再动手拆解
用户的目标往往带着隐含假设。建卡前自检四问：目标是什么？边界内/边界外各是什么？怎样算
完成（可检验的证据）？优先级与顺序？
- 四问中有任何一问模糊且影响拆解方向 → 先用 asterhive_message 向用户追问：给具体选项
  （"是 A 还是 B？各意味着什么"），不抛开放性问题；一次问全，不挤牙膏式反复打扰。
- 用户已表达清楚 → 建完卡用一两句复述你的理解与拆解思路即可，不逐张卡求确认。

## 纪律二：拆解 = 有明确边界的 Todo 列表
用 asterhive_create_task 建卡。每张卡必须同时具备，缺一就是不合格的卡：
- title：动词开头的一句话（如"对接 GitHub Actions 产物上传"）；禁用"优化/完善/处理"
  这类无法验收的词。
- detail：做什么 + **明确不做什么**（范围外写"本卡不含…"）+ 涉及文件/模块。
- acceptance：可检验的证据清单，逐条列（文件路径、测试名、命令输出、commit hash）。
- dependsOn：依赖的先行卡。粒度：一个 worker 一次领取可完成；需要半天以上的活就是没拆开。
一次性把完整路线图建全：先行卡放 Ready，后续卡留 Backlog 靠依赖解锁，不建半截路线图。

## 纪律三：分派
用 asterhive_dispatch 把 Ready 的卡派给合适的 worker：按卡面 category 与对方自报 models
选人，@handle 写清任务要点、涉及文件与验收标准。只分派，绝不执行。

## 纪律四：回收与验收
worker submit 后，用 asterhive_get_task 读提交摘要、checkpoint 链与 evidence（文件清单、
commit hash），对照卡面 acceptance **逐条**核对：
- 全部满足 → asterhive_move_task 移入 Done，向用户汇报结论与关键证据；
- 有差距 → asterhive_dispatch 退回该 worker，写明"差在哪、补什么"，绝不笼统说"不合格"；
- 需要用户主观判断的（文案风格、方案取舍等）→ 把证据摆给用户请其拍板，不替用户验收。
验收的唯一标准是卡面 acceptance；"我觉得差不多"不是验收。

## 纪律五：汇报与节制
关键动作（建完路线图、派活、验收结论、受阻）后用 asterhive_message 在对应看板向用户汇报
（@用户句柄），简短、说结论。每轮先看快照里"待处理"清单，做完该做的事就直接结束本轮；
不空转、不重复建已有卡、无变化不刷屏。

## 输出格式（面向用户的汇报一律如此）
聊天室按 Markdown 渲染消息，你的每一条面向用户的汇报都按此排版：
- 一律 Markdown：结论先行（第一句直接给结论），分节用小标题，条目用列表，
  路径/命令/文件名一律放进行内代码或代码块，验收/清单逐条列出；
- 禁止整段流水账式长文——超过 3 行的汇报若无法分节/列表化，重写再发；
- 短确认（一两句话）不必强加结构。

## 纪律六：静默同步
用户可能直接 @worker 派活或干预（绕过你）。这类消息你同样会收到：应据其意图**静默**更新
对应任务卡（改派 assignee、调整优先级/泳道、把备注记入 detail 或消息），除非用户明确问到
你或需要你决策，否则不要在聊天室回应——避免刷屏。

## 纪律七：托管中立与敏感分层
看板的 repo 不绑定任何托管商——GitHub / 自建 Gitea / 局域网裸仓库都是普通 git remote，
worker 协作模型对三者完全一致。用户项目含未公开内容时：
- 引导用户把**完整主仓放内网自建 git 服务**，公开 GitHub 只作为"要开源的部分"的镜像
  出口；不要让用户把完整项目直接推公开仓库；
- **密钥与私有配置永不入 git**（.gitignore + 环境变量/secret 管理）——这是 agent 与人
  共守的纪律；验收时若在提交内容或证据中发现密钥/凭据 → 一律打回，并提醒用户轮换
  已泄露的凭据后再补卡重做。`;

// ---- zod → TypeBox（Pi ToolDefinition.parameters 用 TypeBox schema）----
// 只覆盖 orchestrator-tools.ts 用到的子集：string/number/enum/array/object/record/optional。

type ZodDef = {
  type?: string;
  innerType?: unknown;
  element?: unknown;
  valueType?: unknown;
  shape?: Readonly<Record<string, unknown>>;
  values?: unknown;
  entries?: unknown;
};

function zodToTypeBox(schema: ZodType): TSchema {
  const def = (schema as unknown as { def?: ZodDef }).def ?? {};
  switch (def.type) {
    case 'optional':
      return Type.Optional(zodToTypeBox(def.innerType as ZodType));
    case 'string':
      return Type.String();
    case 'number':
      return Type.Number();
    case 'enum': {
      const values = Array.isArray(def.values) ? def.values : Object.values((def.entries as Record<string, unknown>) ?? {});
      return Type.Unsafe({ type: 'string', enum: values });
    }
    case 'array':
      return Type.Array(zodToTypeBox(def.element as ZodType));
    case 'object': {
      const props: Record<string, TSchema> = {};
      for (const [k, v] of Object.entries(def.shape ?? {})) props[k] = zodToTypeBox(v as ZodType);
      return Type.Object(props);
    }
    case 'record':
      return Type.Unsafe({ type: 'object', additionalProperties: zodToTypeBox(def.valueType as ZodType) });
    default:
      return Type.Unknown(); // 未覆盖类型兜底：不约束
  }
}

function zodShapeToTypeBox(shape: Readonly<Record<string, ZodType>> | Record<string, unknown>): TSchema {
  const props: Record<string, TSchema> = {};
  for (const [k, v] of Object.entries(shape)) props[k] = zodToTypeBox(v as ZodType);
  return Type.Object(props);
}

// ---- 星巢工具 → Pi ToolDefinition ----
// 错误以 isError 结果回给模型（带 [状态码] 前缀，与 MCP 侧 JSON-RPC 语义对齐），
// Pi 会把它作为工具结果文本呈现在对话里，模型可据此纠正。

function toPiTool(
  def: ToolDef,
  actor: Agent,
  ctx: Ctx,
): ToolDefinition {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: (def.shape ? zodShapeToTypeBox(def.shape) : Type.Object({})) as TSchema,
    execute: async (_toolCallId, params) => {
      try {
        const out = def.handle(ctx, actor, params as Record<string, unknown>);
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], details: {} };
      } catch (err) {
        const msg =
          err instanceof HttpError
            ? `[${err.status}] ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        return { content: [{ type: 'text', text: msg }], details: {}, isError: true };
      }
    },
  };
}

// ---- 状态快照（每轮 prompt 注入）----
// 直接 SQL/领域函数取：各板任务概要、Review 队列（含提交摘要与证据）、最近 20 条房间消息。

function buildSnapshot(ctx: Ctx): string {
  const lines: string[] = [];
  const { db } = ctx.holder;
  lines.push(`【看板快照】${new Date().toISOString()}`);

  const reviewTasks: ReturnType<typeof listTasks> = [];
  for (const b of listBoards(ctx)) {
    const parts: string[] = [];
    for (const lane of LANES) {
      const tasks = listTasks(ctx, b.id, { lane });
      if (tasks.length === 0) continue;
      parts.push(
        `${lane}: ${tasks
          .map((t) => `${t.id} ${t.title}(${t.priority}${t.assignee !== 'unassigned' ? `,@${t.assignee}` : ''})`)
          .join('；')}`,
      );
      if (lane === 'Review') reviewTasks.push(...tasks);
    }
    if (parts.length > 0) lines.push(`板 ${b.id}（${b.name}）：`);
    for (const p of parts) lines.push(`  ${p}`);
  }

  if (reviewTasks.length > 0) {
    // 提交摘要存在 task.submitted 事件里（任务表只存证据）：取最近 100 条建立映射
    const rows = db
      .prepare("SELECT payload FROM event WHERE type = 'task.submitted' ORDER BY id DESC LIMIT 100")
      .all() as { payload: string }[];
    const summaries = new Map<string, string>();
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { taskId?: string; summary?: string };
      if (p.taskId && !summaries.has(p.taskId)) summaries.set(p.taskId, p.summary ?? '');
    }
    lines.push('【Review 待验收】');
    for (const t of reviewTasks) {
      lines.push(`  ${t.id}「${t.title}」@板${t.boardId}（提交人 ${t.assignee}）`);
      lines.push(`    验收标准：${t.acceptance || '（卡面未写验收标准）'}`);
      lines.push(`    提交摘要：${summaries.get(t.id) || '（无）'}`);
      lines.push(`    证据：${t.evidence.map((e) => e.path).join(', ') || '（无）'}`);
    }
  }

  const msgs = db
    .prepare('SELECT id, board_id, author, kind, content FROM message ORDER BY id DESC LIMIT 20')
    .all() as { id: number; board_id: string; author: string; kind: string; content: string }[];
  lines.push('【最近 20 条房间消息】（旧→新）');
  for (const m of msgs.reverse()) {
    lines.push(`  #${m.id} [板${m.board_id}] ${m.author}(${m.kind}): ${m.content.slice(0, 200)}`);
  }
  return lines.join('\n');
}

// ---- 资源加载器包装：社区插件与挂载技能照常透传（getSkills），系统提示词换成主脑纪律 ----

function brainResourceLoader(loader: ResourceLoader): ResourceLoader {
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => BRAIN_SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    extendResources: (paths) => loader.extendResources(paths),
    reload: (options) => loader.reload(options),
  };
}

type PiModule = typeof import('@earendil-works/pi-coding-agent');

export class Brain {
  #unsub: (() => void) | null = null;
  #active = false; // 已激活（agent 已注册、brain.started 已落账）
  #session: AgentSession | null = null;
  #sessionKey = ''; // 会话指纹：运行时入口 + 模型配置；变更即重建会话
  #running = false;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #reasons: string[] = []; // 本轮唤醒原因（下一轮 prompt 的"待处理"清单）
  #lastBoardId: string | null = null; // 最近一次唤醒事件所在板（失败提示要发回对应的房）
  #errorRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #modelErrorRetried = false; // 上游瞬时失败只静默重试一轮，再败必须让用户看见
  #piCache = new Map<string, PiModule>(); // 运行时入口 → 已加载模块（版本更替即换 URL 重载）
  #streamer: ThrottledStream | null = null; // 本轮 brain.stream 节流发布器（null = 本轮不发流）
  #streamUnsub: (() => void) | null = null; // Pi 会话增量订阅退订器
  #streamBoardId: string | null = null; // 最近一次消息触发唤醒所在板：流式发布的目标板（非消息触发的轮为 null）

  #ctx: Ctx;
  #runtime: PiRuntimeManager;

  constructor(ctx: Ctx, runtime: PiRuntimeManager) {
    this.#ctx = ctx;
    this.#runtime = runtime;
  }

  // ---- 生命周期 ----

  /** 服务器启动时调用：只订阅总线；是否激活由 settings.enabled 决定 */
  start(): void {
    // 挂载点目录随服务器启动建好（幂等）：extensions/、skills/ 空目录即"未挂载任何"，
    // 用户往里放东西对主脑下个会话生效，无需重启进程
    this.#runtime.ensureMountDirs();
    this.#unsub = this.#ctx.bus.subscribe((type, payload) => this.#onEvent(type, payload));
    if (getOrchestratorSettings(this.#ctx).enabled) this.#activate();
  }

  /** 服务器停机关闭时调用（常规部署进程直接退出，不必调） */
  stop(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#deactivate('server stopped');
  }

  #activate(): void {
    if (this.#active) return;
    this.#active = true;
    ensureBrainAgent(this.#ctx); // 首次启动主脑：自动注册系统 agent（幂等）
    withWrite(this.#ctx, 'brain.start', () => {
      logEvent(this.#ctx, 'brain.started', {});
    });
  }

  #deactivate(reason: string): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#errorRetryTimer) {
      clearTimeout(this.#errorRetryTimer);
      this.#errorRetryTimer = null;
    }
    this.#dirty = false;
    this.#reasons = [];
    this.#streamBoardId = null;
    this.#stopStreamer(); // 停用即收尾流式发布：退订增量 + 补发 end 相位（web 收到即撤流式气泡）；方法幂等，轮次 finally 再调是空操作
    this.#disposeSession();
    withWrite(this.#ctx, 'brain.stop', () => {
      logEvent(this.#ctx, 'brain.stopped', { reason });
    });
  }

  // ---- 唤醒（事件订阅 → 去抖 → 串行轮次）----

  #onEvent(type: string, payload: Record<string, unknown>): void {
    // 设置开关驱动激活/停用（settings.orchestrator_updated 在 withWrite 提交后发布，
    // 此处再开事务不会嵌套）
    if (type === 'settings.orchestrator_updated') {
      const s = getOrchestratorSettings(this.#ctx);
      if (s.enabled && !this.#active) this.#activate();
      else if (!s.enabled && this.#active) this.#deactivate('settings: enabled=false');
      // 配置变更（换模型/URL/KEY）必须丢弃现有会话：Pi 会话创建时绑定 provider/model，
      // 不重建的话切了设置旧会话仍走旧通道（曾致用户切模型后仍 503）。
      // 多模型组切换（PUT /settings/orchestrator/active 必发本事件）同样在此闭环：
      // 旧会话被弃、下一轮用激活组重建——换通道即刻生效，无需重启。
      else if (s.enabled) {
        this.#disposeSession();
        this.#markDirty(); // 尽快用新配置开一轮，验证新通道
      }
      return;
    }
    if (!this.#active) return;
    const s = getOrchestratorSettings(this.#ctx);
    if (!s.enabled) return;
    const wakeOn = s.wakeOn ?? {};
    if (typeof payload.boardId === 'string' && payload.boardId) {
      this.#lastBoardId = payload.boardId; // 失败提示要发回事件所在板的房间
    }

    let reason: string | null = null;
    let steerable = false;
    switch (type) {
      case 'message.created': {
        if (payload.author === BRAIN_AGENT_ID) return; // 自己发的消息不唤醒（防自激）
        const isQuestion = payload.kind === 'question';
        // blockedReport 映射：worker 的 question 消息视为受阻上报；userMessage 覆盖其余消息
        if (isQuestion && wakeOn.blockedReport !== false) reason = `worker 提问/受阻 #${payload.messageId} [板${payload.boardId}] ${payload.author}：${String(payload.content ?? '').slice(0, 120)}`;
        else if (wakeOn.userMessage !== false) reason = `新消息 #${payload.messageId} [板${payload.boardId}] ${payload.author}：${String(payload.content ?? '').slice(0, 120)}`;
        steerable = true; // 用户在房间说话即指令：运行中尝试 steer 注入
        break;
      }
      case 'task.submitted':
        if (wakeOn.taskSubmitted !== false) reason = `任务 ${payload.taskId} 提交待验收：${String(payload.summary ?? '').slice(0, 120)}`;
        break;
      case 'task.lane_changed':
        if (payload.to === 'Review' && wakeOn.taskSubmitted !== false) {
          reason = `任务 ${payload.taskId} 进入 Review`;
        }
        break;
      case 'agent.registered':
        reason = `新 agent 加入 @${payload.handle}（role=${payload.role}）`;
        break;
      default:
        return; // scheduleDigest 暂无事件源（无调度器），预留
    }
    if (!reason) return;
    if (this.#reasons.length < 10) this.#reasons.push(reason);
    // 消息触发的唤醒：记下所在板——本轮的 brain.stream 流式发布推到这个房间。
    // task.submitted 等非消息触发的轮不设置（#turn 里为 null 即不发流式事件）。
    if (type === 'message.created' && typeof payload.boardId === 'string') {
      this.#streamBoardId = payload.boardId;
    }

    // 运行中干预：SDK 支持 steer（注入当前运行）；成功排队即由本轮消化（原因出列），
    // 失败/未排队则保留原因排到下一轮
    if (steerable && this.#running && this.#session) {
      const idx = this.#reasons.length - 1;
      this.#session
        .steer(`[房间插话] ${reason}`)
        .then((r) => {
          if (r === 'queued') this.#reasons.splice(idx, 1);
          else this.#markDirty();
        })
        .catch(() => this.#markDirty());
      return;
    }
    this.#markDirty();
  }

  #markDirty(): void {
    if (this.#running) {
      this.#dirty = true; // 本轮结束后由 finally 排下一轮
      return;
    }
    if (this.#timer) return; // 去抖窗口已开：合并
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#turn();
    }, DEBOUNCE_MS);
  }

  // ---- 轮次 ----

  async #turn(): Promise<void> {
    const s = getOrchestratorSettings(this.#ctx);
    if (!s.enabled || this.#running) return;
    // 多模型组：轮次通道一律取激活组（activeGroup）。无激活组，或组缺 baseURL/model/apiKey
    // 任一项 → 沿用"未配置"语义：主脑不启动轮次（设置页明示），唤醒原因丢弃
    const g = activeGroup(this.#ctx);
    if (!g || !g.baseURL || !g.model || !g.apiKey) {
      this.#reasons = [];
      return;
    }
    this.#running = true;
    const started = Date.now();
    const reasons = this.#reasons;
    this.#reasons = [];
    // 流式发布目标板：取走即清——本轮固定推这个板；中途 steer 进来的新消息由下一轮决定
    const streamBoardId = this.#streamBoardId;
    this.#streamBoardId = null;
    withWrite(this.#ctx, 'brain.turnStart', () => {
      // groupName/groupId：排查"这次轮次用的哪条通道"（多模型组切换后对账用）
      logEvent(this.#ctx, 'brain.turn_started', { reasons, groupId: g.id, groupName: g.name });
    });
    try {
      const agent = ensureBrainAgent(this.#ctx);
      const session = await this.#ensureSession(g);
      const reasonLines = reasons.length > 0 ? reasons.map((r) => `- ${r}`) : ['- （无未处理唤醒，按快照巡检）'];
      const prompt = [
        '【本轮唤醒】',
        ...reasonLines,
        '',
        buildSnapshot(this.#ctx),
        '',
        '请按纪律处理上述事项：该建卡建卡、该分派分派、该验收验收、该汇报汇报，然后直接结束本轮。',
      ].join('\n');

      // 单轮超时：到点 abort 当前运行（abort 会等 idle），轮次记 brain.turn_timeout
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void this.#session?.abort().catch(() => {});
      }, TURN_TIMEOUT_MS);
      // 流式发布：订阅 Pi 增量（message_update/text_delta），节流合并成 brain.stream。
      // 仅消息触发的轮发布（streamBoardId 非空）；异常/超时路径由 finally 兜底收尾。
      if (streamBoardId) this.#startStreamer(session, streamBoardId);
      try {
        await session.prompt(prompt);
      } finally {
        clearTimeout(timer);
        this.#stopStreamer(); // 补发全文余量 + phase:'end'（无产出轮一帧不发）
      }
      if (timedOut) {
        withWrite(this.#ctx, 'brain.turnTimeout', () => {
          logEvent(this.#ctx, 'brain.turn_timeout', { turnMs: Date.now() - started });
        });
      }
      // 模型侧失败（如端点不可达）不抛异常——pi 以 errorMessage 结束轮次；一并落账供 UI 显示
      const modelError = session.agent.state.errorMessage;
      withWrite(this.#ctx, 'brain.turnFinish', () => {
        logEvent(this.#ctx, 'brain.turn_finished', { turnMs: Date.now() - started, modelError });
      });
      // 上游瞬时故障（如中转站账号池瞬时耗尽 503）先静默重试一轮（60s 后）；
      // 重试仍败则必须让用户看见——往事件所在板的房间发系统提示，不再无声吞掉唤醒
      if (modelError) {
        if (!this.#modelErrorRetried) {
          this.#modelErrorRetried = true;
          if (this.#errorRetryTimer) clearTimeout(this.#errorRetryTimer);
          const brief = modelError.slice(0, 160);
          this.#errorRetryTimer = setTimeout(() => {
            this.#errorRetryTimer = null;
            this.#reasons.push(`[自动重试] 上一轮上游模型调用失败（${brief}），请重新处理本清单`);
            this.#markDirty();
          }, 60_000);
        } else {
          this.#modelErrorRetried = false;
          const board = this.#lastBoardId;
          if (board) {
            withWrite(this.#ctx, 'brain.upstreamError', () => {
              messageInner(this.#ctx, {
                boardId: board,
                author: BRAIN_AGENT_ID,
                kind: 'system',
                content:
                  `⚠ 主脑调用上游模型失败（已自动重试一轮仍败）：${modelError.slice(0, 200)}。` +
                  '本轮唤醒未处理。请到「设置 → 主脑设置」刷新模型列表并切换可用模型，或稍后再 @主脑。',
                mentions: [],
              });
            });
          }
        }
      } else {
        this.#modelErrorRetried = false; // 成功即复位，下次瞬时故障重新享受一轮静默重试
      }
    } catch (err) {
      withWrite(this.#ctx, 'brain.error', () => {
        logEvent(this.#ctx, 'brain.error', {
          reason: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 6).join('\n') : undefined,
        });
      });
      this.#disposeSession(); // 会话可能已坏：下次唤醒重建
    } finally {
      this.#running = false;
      this.#streamBoardId = null; // 运行中 steer 进来的消息会重设此值：本轮流已固定目标板，清掉防残留到无关轮
      if (this.#dirty) {
        this.#dirty = false;
        this.#markDirty(); // 运行期间又来了事件 → 去抖后排下一轮
      }
    }
  }

  // ---- Pi 会话 ----

  /**
   * 开启本轮流式发布：订阅 Pi 会话增量事件，经节流器合并为 brain.stream 总线事件。
   * 真实 API 路径（非轮询兜底）：AgentSession.subscribe（agent-session.d.ts）给出
   * AgentSessionEvent，其中 message_update 仅在 assistant 消息流式期间发出——
   * assistantMessageEvent.type='text_delta' 携带增量，event.message 即累积全文。
   */
  #startStreamer(session: AgentSession, boardId: string): void {
    const streamer = throttledStreamPublish((frame) => {
      // 瞬态事件：直接总线发布（SSE 实时下发），不落事件台账——流式增量不该进库
      this.#ctx.bus.publish('brain.stream', { ...frame, boardId });
    }, { intervalMs: STREAM_INTERVAL_MS, maxChars: STREAM_MAX_CHARS });
    this.#streamer = streamer;
    this.#streamUnsub = session.subscribe((event) => {
      if (event.type !== 'message_update') return;
      if (event.assistantMessageEvent.type !== 'text_delta') return; // thinking/toolcall 增量不进聊天流
      streamer.push(assistantText(event.message));
    });
  }

  /** 收尾本轮流式发布：先退订再 end（补发余量全文 + end 相位；无产出轮一帧不发） */
  #stopStreamer(): void {
    this.#streamUnsub?.();
    this.#streamUnsub = null;
    const streamer = this.#streamer;
    this.#streamer = null;
    streamer?.end();
  }

  #disposeSession(): void {
    const s = this.#session;
    this.#session = null;
    this.#sessionKey = '';
    if (s) {
      try {
        s.dispose();
      } catch {
        /* 已释放则忽略 */
      }
    }
  }

  async #loadPi(entryUrl: string): Promise<PiModule> {
    let mod = this.#piCache.get(entryUrl);
    if (!mod) {
      mod = (await import(entryUrl)) as PiModule;
      this.#piCache.set(entryUrl, mod);
    }
    return mod;
  }

  /**
   * 取主脑会话（指纹相同则复用常驻会话；模型/端点/KEY/运行时变更即重建）。
   * 会话持久化：<dataDir>/brain-session/sessions（SessionManager JSONL 树），
   * 服务器重启后用 continueRecent 续接最近会话——上下文不丢。
   * 多模型组：入参即本轮激活组（activeGroup 已解密 KEY）；组切换经
   * settings.orchestrator_updated → #onEvent → #disposeSession 到达这里时指纹必变。
   */
  async #ensureSession(g: ActiveOrchestratorGroup): Promise<AgentSession> {
    const rt = this.#runtime.ensureRuntimeEntry(); // 数据卷优先，回落仓库基线；包不完整直接报错
    // 指纹含解密后的 apiKey：仅换 KEY/换组也能触发会话重建
    const key = JSON.stringify([rt.entryUrl, g.baseURL, g.model, g.apiKey]);
    if (this.#session && key === this.#sessionKey) return this.#session;
    this.#disposeSession();

    const pi = await this.#loadPi(rt.entryUrl);
    const brainDir = join(this.#ctx.cfg.dataDir, 'brain-session');
    const workspace = join(brainDir, 'workspace'); // 主脑不碰文件系统，cwd 仅为 SDK 发现路径
    const sessionsDir = join(brainDir, 'sessions');
    const agentDir = join(brainDir, 'agent'); // 专用 agentDir：与用户 ~/.pi 完全隔离
    for (const d of [workspace, sessionsDir, agentDir, this.#runtime.skillsDir]) mkdirSync(d, { recursive: true });

    // 自定义 OpenAI 兼容 provider：baseURL/model/apiKey 来自激活组（明文仅内存，不落盘）
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null, // 不读任何 models.json，避免读到用户环境配置
      refreshOnCreate: false, // 离线安全：启动时不访问模型目录网络
    });
    modelRuntime.registerProvider('asterhive-brain', {
      name: 'AsterHive 主脑',
      baseUrl: g.baseURL,
      apiKey: g.apiKey ?? 'asterhive-unset', // #turn 已保证非空，兜底仅为类型收窄
      api: 'openai-completions',
      models: [
        {
          type: 'chat',
          id: g.model!,
          name: g.model!,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    });
    const model = modelRuntime.getModel('asterhive-brain', g.model!);
    if (!model) throw new Error(`provider 注册后未找到模型 asterhive-brain/${g.model}`);

    // 主脑身份：工具执行的 actor（幂等；激活时已注册，此处兜底）
    const agent = ensureBrainAgent(this.#ctx);

    // 资源加载：专用目录隔离；additionalExtensionPaths = 社区插件挂载点（不预装任何），
    // additionalSkillPaths = 数据卷技能挂载点（整目录递归扫描 SKILL.md，空目录 = 零技能，无害）
    const loader = new pi.DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      additionalExtensionPaths: this.#runtime.communityExtensionPaths(),
      additionalSkillPaths: [this.#runtime.skillsDir],
    });
    await loader.reload();

    const { session } = await pi.createAgentSession({
      cwd: workspace,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel: 'off',
      resourceLoader: brainResourceLoader(loader), // 系统提示词 = 主脑纪律
      settingsManager: pi.SettingsManager.inMemory({}),
      sessionManager: pi.SessionManager.continueRecent(workspace, sessionsDir),
      noTools: 'builtin', // 关闭全部内置工具（read/bash/edit/write…）
      customTools: TOOL_DEFS.map((d) => toPiTool(d, agent, this.#ctx)), // 只有 15 个协议工具
    });
    // 触发 session_start：社区插件（如 MCP 类扩展）在此连接。无扩展时是空操作。
    await session.bindExtensions({}).catch(() => {});

    this.#session = session;
    this.#sessionKey = key;
    return session;
  }
}
