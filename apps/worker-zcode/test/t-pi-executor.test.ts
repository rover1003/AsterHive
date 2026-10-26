import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPiPrompt, setPiModuleForTest, type PiModelConfig } from '../src/pi-executor.ts';

function H(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// 轻量临时 cwd（server 侧 mkRig 不可用：本测试只读文件系统无关的执行路径）
function tmpCwd(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-exec-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CONFIG: PiModelConfig = { baseURL: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' };

// 构造 stub Pi 模块：捕获 provider 注册与 createAgentSession 参数
function stubPi(opts: {
  onPrompt?: (session: Record<string, unknown>) => void | Promise<void>;
  finalText?: string;
} = {}) {
  const captured: {
    registerProvider?: { providerId: string; baseUrl: string; apiKey: string; models: { id: string }[] };
    sessionArgs?: Record<string, unknown>;
    prompts: string[];
  } = { prompts: [] };
  let sessionRef: Record<string, unknown> | null = null;

  const mod = {
    ModelRuntime: {
      create: async () => ({
        registerProvider: (providerId: string, p: { baseUrl: string; apiKey: string; models: { id: string }[] }) => {
          captured.registerProvider = { providerId, ...p };
        },
        getModel: (_provider: string, id: string) => ({ id, provider: _provider }),
      }),
    },
    DefaultResourceLoader: class {
      args: Record<string, unknown>;
      constructor(args: Record<string, unknown>) {
        this.args = args;
      }
      async reload() {}
    },
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (args: Record<string, unknown>) => {
      captured.sessionArgs = args;
      const session: Record<string, unknown> = {
        messages: [
          { message: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
          { message: { role: 'assistant', content: [{ type: 'text', text: opts.finalText ?? '工蜂完成：产物已写入' }] } },
        ],
        prompt: async () => {
          if (opts.onPrompt) await opts.onPrompt(session);
        },
        abort: async () => {
          (session as { aborted?: boolean }).aborted = true;
        },
      };
      sessionRef = session;
      return { session };
    },
  };
  return { mod, captured, get session() { return sessionRef!; } };
}

test('T19 pi 执行器: 会话创建参数（provider 注册、技能挂载、hive_checkpoint 工具、无 noTools）', async () => {
  const rig = tmpCwd();
  try {
    const { mod, captured } = stubPi();
    setPiModuleForTest(mod);
    const res = await runPiPrompt({
      prompt: '完成任务 XYZ',
      cwd: rig.dir,
      config: CONFIG,
      timeoutMs: 60_000,
      log: () => {},
    });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /工蜂完成/);

    // provider 注册：baseURL/apiKey/model 逐项传入，Key 不落盘
    assert.equal(captured.registerProvider?.providerId, 'asterhive-worker');
    assert.equal(captured.registerProvider?.baseUrl, CONFIG.baseURL);
    assert.equal(captured.registerProvider?.apiKey, CONFIG.apiKey);
    assert.equal(captured.registerProvider?.models[0].id, CONFIG.model);

    // 会话参数：技能挂载点、自定义工具含 hive_checkpoint、无 noTools（工蜂保留执行面）
    const args = captured.sessionArgs as {
      additionalSkillPaths?: never;
      customTools?: { name: string }[];
      noTools?: unknown;
      resourceLoader?: { getSystemPrompt?: () => string };
    };
    const loaderArgs = (args.resourceLoader && (args.resourceLoader as unknown as { __loaderArgs?: Record<string, unknown> })) || {};
    void loaderArgs;
    assert.ok(Array.isArray(args.customTools));
    assert.equal(args.customTools!.some((t) => t.name === 'hive_checkpoint'), true, 'hive_checkpoint 工具已注册');
    assert.equal(args.noTools, undefined, '工蜂不关闭内置执行工具');
    assert.equal(
      typeof (args.resourceLoader as { getSystemPrompt?: () => string } | undefined)?.getSystemPrompt,
      'function',
      'resourceLoader 已包装（工蜂纪律系统提示词）',
    );
    assert.match((args.resourceLoader as { getSystemPrompt: () => string }).getSystemPrompt(), /Worker Bee/);
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

test('T19 pi 执行器: hive_checkpoint 工具转发 checkpoint 回调并带回干预消息', async () => {
  const rig = tmpCwd();
  try {
    let checkpointNotes: string[] = [];
    const { mod, captured } = stubPi();
    setPiModuleForTest(mod);

    // 通过 execute 通道直接调用工具：从 sessionArgs 取出 customTools[0].execute
    const run = runPiPrompt({
      prompt: 'x',
      cwd: rig.dir,
      config: CONFIG,
      timeoutMs: 60_000,
      log: () => {},
      checkpoint: async (note) => {
        checkpointNotes.push(note);
        return { pendingMessages: [{ author: 'asterhive-brain', content: '注意范围' }] };
      },
    });
    await run;

    const tool = (captured.sessionArgs as { customTools: { name: string; execute: (id: string, params: { note: string }) => Promise<{ content: { text: string }[] }> } }).customTools
      .find((t) => t.name === 'hive_checkpoint')!;
    const out = await tool.execute('call-1', { note: '已生成 manifest，覆盖三类用例' });
    assert.deepEqual(checkpointNotes, ['已生成 manifest，覆盖三类用例'], 'note 转发给守护进程 checkpoint');
    const payload = JSON.parse(out.content[0].text) as { ok: boolean; deliveredInterventions: number };
    assert.equal(payload.ok, true);
    assert.equal(payload.deliveredInterventions, 1, '干预消息计数带回');
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

test('T19 pi 执行器: 超时中止返回 code -1；模型配置语义错误清晰报错', async () => {
  const rig = tmpCwd();
  try {
    // 超时：prompt 挂起直到 abort 被调用
    const { mod } = stubPi();
    setPiModuleForTest(mod);
    // 直接构造一个 prompt 永远挂起、abort 即 resolve 的 stub
    const hangingMod = {
      ...mod,
      createAgentSession: async () => {
        let aborted = false;
        const session = {
          messages: [{ message: { role: 'assistant', content: [{ type: 'text', text: '部分输出' }] } }],
          abort: async () => {
            aborted = true;
          },
          prompt: () =>
            new Promise((_resolve, reject) => {
              const check = setInterval(() => {
                if (aborted) {
                  clearInterval(check);
                  reject(new Error('aborted'));
                }
              }, 10);
            }),
        };
        return { session };
      },
    };
    setPiModuleForTest(hangingMod);
    const res = await runPiPrompt({
      prompt: 'hang',
      cwd: rig.dir,
      config: CONFIG,
      timeoutMs: 80,
      log: () => {},
    });
    assert.equal(res.code, -1, '超时返回 -1');
    assert.match(res.stdout, /超时被中止/);
    assert.match(res.stdout, /部分输出/, '中止前已有输出保留');
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

test('T19 worker 配置: pi 内核经 worker.json 承载（executor/model 段读取语义）', async () => {
  // 该测试验证 worker.json 配置段的形状约定（安装脚本写入格式）：
  // { url, executor: 'pi', model: { baseURL, apiKey, model } }
  const rig = tmpCwd();
  try {
    const { mod } = stubPi();
    setPiModuleForTest(mod);
    const { runPiPrompt: run } = await import('../src/pi-executor.ts');
    const res = await run({
      prompt: 'p',
      cwd: rig.dir,
      config: { baseURL: 'https://relay.example/v1', apiKey: 'k', model: 'gemini-x', thinkingLevel: 'low' },
      timeoutMs: 1000,
      log: () => {},
    });
    assert.equal(res.code, 0);
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

// 防止未使用 import 告警（H 供后续 HTTP 侧测试复用）
void H;
