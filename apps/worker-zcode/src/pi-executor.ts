// 托管工蜂的 Pi 执行器（T19）：worker 守护进程进程内直接嵌 Pi SDK 会话——
// 设备零外部 agent CLI 依赖（不需要 OMP/ZCode），Node + 本包即可干活。
//
// 与主脑嵌 Pi 的差异（brain.ts 对照）：
// - 保留全部内置工具（read/bash/edit/write…）——工蜂的任务就是动手执行；
// - 每张卡一个一次性 inMemory 会话（无状态，不落盘不续接），上下文随卡结束即弃；
// - 自定义工具只有 hive_checkpoint：模型在里程碑/受阻时主动汇报并带回干预消息；
// - 提供者配置来自设备本地 worker.json 的 model 段（baseURL/apiKey/model），
//   Key 设备自持（立项计划 §10 纪律），服务器不经手。
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ResourceLoader } from '@earendil-works/pi-coding-agent';
import { WORKER_SYSTEM_PROMPT, HIVE_CHECKPOINT_TOOL_DESCRIPTION } from './hive-prompt.ts';

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PiModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Pi thinking level; legacy configurations default to medium. */
  thinkingLevel?: PiThinkingLevel;
  /** Model-specific labels for Pi levels; null explicitly disables a level. */
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
}
export interface PiActivity {
  kind: 'tool' | 'model';
  toolName?: string;
  phase: 'start' | 'end';
  waitingFor?: string;
  timestamp: number;
}

export interface PiRunOptions {
  prompt: string;
  cwd: string;
  config: PiModelConfig;
  timeoutMs: number;
  log: (...args: unknown[]) => void;
  /** hive_checkpoint 落点：转发给守护进程的 worker.checkpoint(taskId, note) */
  checkpoint?: (note: string) => Promise<{ pendingMessages?: { author?: string; content?: string }[] }>;
  onActivity?: (activity: PiActivity) => void | Promise<void>;
  /** 随包技能目录（缺省 = 包内 hive-skills） */
  skillsDir?: string;
  /** Pi agentDir 隔离根（缺省 ~/.asterhive/pi-worker-agent，与用户 ~/.pi 完全隔离） */
  agentDir?: string;
}

export interface PiRunResult {
  stdout: string;
  code: number | null;
}

// 会话句柄最小接口（只声明用到的面，避免与 SDK 版本强耦合）
interface PiSessionLike {
  prompt(input: string): Promise<unknown>;
  abort(): Promise<unknown> | unknown;
  messages?: unknown[];
}

// 测试注入：替换 Pi 模块加载（不触真实 SDK）
let piOverride: Record<string, unknown> | null = null;
export function setPiModuleForTest(mod: Record<string, unknown> | null): void {
  piOverride = mod;
}

async function loadPi(): Promise<Record<string, any>> {
  if (piOverride) return piOverride;
  try {
    return await import('@earendil-works/pi-coding-agent');
  } catch (err) {
    throw new Error(
      `Pi 运行时未安装（@earendil-works/pi-coding-agent）：${err instanceof Error ? err.message : err}。` +
        '请在 worker 目录执行 npm install 后重试。',
    );
  }
}

function defaultSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'hive-skills');
}

// 从会话消息里取最后一段 assistant 文本（与主脑/审核员同款提取逻辑）
function lastAssistantText(session: PiSessionLike): string {
  const msgs = (session.messages ?? []) as { message?: { role?: string; content?: unknown } ; role?: string; content?: unknown }[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const raw = msgs[i] as { message?: { role?: string; content?: { type?: string; text?: string }[] }; role?: string; content?: { type?: string; text?: string }[] };
    const msg = raw.message ?? raw;
    if (msg.role !== 'assistant') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/**
 * 执行一段任务 prompt：一次性 Pi 会话跑完即弃。
 * 返回与 CLI 执行器同形的 { stdout, code }：code=0 正常；-1 = 超时中止或未配置。
 */
export async function runPiPrompt(opts: PiRunOptions): Promise<PiRunResult> {
  const { prompt, cwd, config, timeoutMs, log, checkpoint, onActivity } = opts;
  const pi = await loadPi();

  const agentDir = opts.agentDir ?? join(homedir(), '.asterhive', 'pi-worker-agent');
  const skillsDir = opts.skillsDir ?? defaultSkillsDir();
  for (const d of [agentDir, skillsDir]) mkdirSync(d, { recursive: true });

  // 自定义 OpenAI 兼容 provider（明文仅内存，不落盘；离线安全不访问模型目录网络）
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const thinkingLevel = config.thinkingLevel ?? 'medium';
  const thinkingLevelMap = { ...(config.thinkingLevelMap ?? {}) };
  if ((thinkingLevel === 'xhigh' || thinkingLevel === 'max') && thinkingLevelMap[thinkingLevel] === undefined) {
    thinkingLevelMap[thinkingLevel] = thinkingLevel;
  }
  modelRuntime.registerProvider('asterhive-worker', {
    name: 'AsterHive 工蜂',
    baseUrl: config.baseURL,
    apiKey: config.apiKey,
    api: 'openai-completions',
    models: [
      {
        type: 'chat',
        id: config.model,
        name: config.model,
        ...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}),
        reasoning: thinkingLevel !== 'off',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ],
  });
  const model = modelRuntime.getModel('asterhive-worker', config.model);
  if (!model) throw new Error(`provider 注册后未找到模型 asterhive-worker/${config.model}`);

  // hive_checkpoint：模型侧的主动汇报通道（守护进程定时保活心跳之外的里程碑补充）
  const checkpointTool = {
    name: 'hive_checkpoint',
    label: 'hive_checkpoint',
    description: HIVE_CHECKPOINT_TOOL_DESCRIPTION,
    parameters: Type.Object({ note: Type.String({ description: '一行实况：进展或阻塞点' }) }),
    execute: async (_toolCallId: string, params: { note?: string }) => {
      const note = String(params?.note ?? '').trim() || '(空汇报)';
      let delivered: { author?: string; content?: string }[] = [];
      try {
        if (checkpoint) {
          const res = await checkpoint(note);
          delivered = res?.pendingMessages ?? [];
        }
      } catch (err) {
        log('hive_checkpoint 上报失败（非致命）：', err instanceof Error ? err.message : err);
      }
      const body = delivered.length
        ? { ok: true, deliveredInterventions: delivered.length, messages: delivered }
        : { ok: true, deliveredInterventions: 0 };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] , isError: false };
    },
  };

  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: [skillsDir], // Hive 配套技能：按需展开，不占每轮上下文
  });
  await loader.reload();

  // 资源加载器包装（与主脑 brainResourceLoader 同款）：技能照常透传，系统提示词换成工蜂纪律
  const workerResourceLoader = {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => WORKER_SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    extendResources: (paths: unknown) => loader.extendResources(paths as Parameters<typeof loader.extendResources>[0]),
    reload: (options?: unknown) => loader.reload(options as Parameters<typeof loader.reload>[0]),
  } as unknown as ResourceLoader;

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    thinkingLevel,
    resourceLoader: workerResourceLoader,
    settingsManager: pi.SettingsManager.inMemory({}),
    sessionManager: pi.SessionManager.inMemory(cwd), // 一次性会话：随卡结束即弃
    // 注意：不传 noTools——工蜂保留 read/bash/edit/write 等全部执行面
    customTools: [checkpointTool],
  });

  const seenToolStarts = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  const subscribable = session as unknown as {
    subscribe?: (fn: (event: Record<string, unknown>) => void) => () => void;
  };
  if (typeof subscribable.subscribe === 'function') {
    unsubscribe = subscribable.subscribe((event: Record<string, unknown>) => {
      if (!event || typeof event !== 'object') return;
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'tool_execution_start') {
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
        onActivity?.({
          kind: 'tool',
          toolName,
          phase: 'start',
          waitingFor: `tool:${toolName}`,
          timestamp: Date.now(),
        });
      } else if (type === 'tool_execution_end') {
        const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
        onActivity?.({
          kind: 'tool',
          toolName,
          phase: 'end',
          timestamp: Date.now(),
        });
      } else if (type === 'turn_start' || type === 'message_start') {
        onActivity?.({
          kind: 'model',
          phase: 'start',
          waitingFor: 'model',
          timestamp: Date.now(),
        });
      } else if (type === 'message_update') {
        const msg = event.message as { content?: unknown[] } | undefined;
        if (msg && Array.isArray(msg.content)) {
          for (let i = 0; i < msg.content.length; i++) {
            const b = msg.content[i] as { type?: string; name?: string } | undefined;
            if (b && (b.type === 'tool_call' || b.type === 'tool_use')) {
              const toolName = typeof b.name === 'string' ? b.name : 'tool';
              const key = `${toolName}|${i}`;
              if (!seenToolStarts.has(key)) {
                seenToolStarts.add(key);
                onActivity?.({
                  kind: 'tool',
                  toolName,
                  phase: 'start',
                  waitingFor: `tool:${toolName}`,
                  timestamp: Date.now(),
                });
              }
            }
          }
        }
      }
    });
  }
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  timer = setTimeout(() => {
    aborted = true;
    log(`Pi 会话超时（${Math.round(timeoutMs / 60000)} 分钟），触发中止请求，执行结果未知，后台仍在运行中`);
    try {
      void Promise.resolve((session as PiSessionLike).abort()).catch(() => {});
    } catch {
      /* abort 失败 */
    }
    // 立即向服务端上报观察到超时的 checkpoint，明确执行结果未知，保活继续，绝不假冒已停止
    if (checkpoint) {
      void checkpoint(
        '执行达到超时上限，已触发中止请求；执行结果未知，后台仍在运行中；保活继续，工作区现场保留',
      ).catch(() => {});
    }
    onActivity?.({
      kind: 'model',
      phase: 'start',
      waitingFor: 'abort_settle',
      timestamp: Date.now(),
    });
  }, timeoutMs);

  try {
    // 真实 await 原始 prompt 直到真正 settled；绝不提前 fake-resolve 退出
    await (session as PiSessionLike).prompt(prompt);

    const text = lastAssistantText(session as PiSessionLike);
    if (aborted) {
      return {
        stdout: `${text}\n[pi-executor] 会话超时被中止，已真正中止退出；工作区现场已保留。`.trim(),
        code: -1,
      };
    }
    return { stdout: text || '(无文本输出)', code: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('Pi 会话执行出错：', msg);
    if (aborted) {
      const partial = lastAssistantText(session as PiSessionLike);
      return {
        stdout: `${partial}\n[pi-executor] 会话超时被中止，已真正中止退出：${msg}；工作区现场已保留。`.trim(),
        code: -1,
      };
    }
    return { stdout: `[pi-executor] 执行出错：${msg}`, code: 1 };
  } finally {
    unsubscribe?.();
    clearTimeout(timer);
  }
}
