import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPiPrompt, setPiModuleForTest, type PiModelConfig } from '../src/pi-executor.ts';
import { pollNextDirectedTask } from '../src/polling.ts';

function tmpCwd(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'exec-prog-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CONFIG: PiModelConfig = { baseURL: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' };

test('pi-executor: hive_checkpoint 上报里程碑并返回干预消息', async () => {
  const rig = tmpCwd();
  let checkpointCalled = false;
  let receivedNote = '';

  const stub = {
    ModelRuntime: {
      create: async () => ({
        registerProvider: () => {},
        getModel: (_p: string, id: string) => ({ id }),
      }),
    },
    DefaultResourceLoader: class {
      async reload() {}
      getExtensions() { return []; }
      getSkills() { return []; }
      getPrompts() { return []; }
      getThemes() { return []; }
      getAgentsFiles() { return []; }
      getSystemPrompt() { return ''; }
      getAppendSystemPrompt() { return ''; }
    },
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (args: Record<string, unknown>) => {
      const customTools = (args.customTools ?? []) as { name: string; execute: (id: string, params: { note?: string }) => Promise<unknown> }[];
      const cpTool = customTools.find((t) => t.name === 'hive_checkpoint');
      assert.ok(cpTool, '必须注册 hive_checkpoint 工具');

      const session = {
        messages: [
          { message: { role: 'assistant', content: [{ type: 'text', text: '完成代码改动并自测通过' }] } },
        ],
        prompt: async () => {
          // 模拟模型在执行过程中调用 hive_checkpoint
          await cpTool?.execute('tool-call-1', { note: '已完成数据层迁移' });
        },
        abort: async () => {},
      };
      return { session };
    },
  };

  setPiModuleForTest(stub);
  try {
    const result = await runPiPrompt({
      prompt: '执行任务',
      cwd: rig.dir,
      config: CONFIG,
      timeoutMs: 60_000,
      log: () => {},
      agentDir: join(rig.dir, 'agent'),
      skillsDir: join(rig.dir, 'skills'),
      checkpoint: async (note) => {
        checkpointCalled = true;
        receivedNote = note;
        return { pendingMessages: [{ author: 'boss', content: '继续执行' }] };
      },
    });

    assert.equal(result.code, 0);
    assert.equal(checkpointCalled, true);
    assert.equal(receivedNote, '已完成数据层迁移');
    assert.match(result.stdout, /完成代码改动并自测通过/);
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

test('pi-executor: 超时中止保留现场输出并返回 code -1', async () => {
  const rig = tmpCwd();
  let aborted = false;

  const stub = {
    ModelRuntime: {
      create: async () => ({
        registerProvider: () => {},
        getModel: (_p: string, id: string) => ({ id }),
      }),
    },
    DefaultResourceLoader: class {
      async reload() {}
      getExtensions() { return []; }
      getSkills() { return []; }
      getPrompts() { return []; }
      getThemes() { return []; }
      getAgentsFiles() { return []; }
      getSystemPrompt() { return ''; }
      getAppendSystemPrompt() { return ''; }
    },
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => {
      let triggerResolve: (() => void) | undefined;
      const session = {
        messages: [
          { message: { role: 'assistant', content: [{ type: 'text', text: '部分执行过程输出' }] } },
        ],
        prompt: async () => {
          const { promise, resolve } = Promise.withResolvers<void>();
          triggerResolve = resolve;
          await promise;
        },
        abort: async () => {
          aborted = true;
          triggerResolve?.();
        },
      };
      return { session };
    },
  };

  setPiModuleForTest(stub);
  try {
    const result = await runPiPrompt({
      prompt: '耗时过长任务',
      cwd: rig.dir,
      config: CONFIG,
      timeoutMs: 5, // 极短超时模拟
      log: () => {},
      agentDir: join(rig.dir, 'agent'),
      skillsDir: join(rig.dir, 'skills'),
    });

    assert.equal(aborted, true, '超时必须触发 abort');
    assert.equal(result.code, -1, '超时必须返回退出码 -1');
    assert.match(result.stdout, /部分执行过程输出/, '超时必须保留中止前最后输出');
    assert.match(result.stdout, /会话超时被中止/, '必须明确包含超时中止声明');
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});
test('pi-executor: 订阅实际事件序列 (tool_execution_start/end, turn_start) 并安全通知 activity', async () => {
  const rig = tmpCwd();
  const capturedActivities: { kind: string; toolName?: string; phase: string }[] = [];

  const stub = {
    ModelRuntime: {
      create: async () => ({
        registerProvider: () => {},
        getModel: (_p: string, id: string) => ({ id }),
      }),
    },
    DefaultResourceLoader: class {
      async reload() {}
      getExtensions() { return []; }
      getSkills() { return []; }
      getPrompts() { return []; }
      getThemes() { return []; }
      getAgentsFiles() { return []; }
      getSystemPrompt() { return ''; }
      getAppendSystemPrompt() { return ''; }
    },
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => {
      const listeners: ((event: Record<string, unknown>) => void)[] = [];
      const session = {
        messages: [
          { message: { role: 'assistant', content: [{ type: 'text', text: '完成工具执行' }] } },
        ],
        subscribe: (fn: (event: Record<string, unknown>) => void) => {
          listeners.push(fn);
          return () => {};
        },
        prompt: async () => {
          // 模拟实际事件触发序列
          for (const fn of listeners) {
            fn({ type: 'turn_start' });
            fn({ type: 'tool_execution_start', toolName: 'read' });
            fn({ type: 'tool_execution_end', toolName: 'read' });
          }
        },
        abort: async () => {},
      };
      return { session };
    },
  };

  setPiModuleForTest(stub);
  try {
    const result = await runPiPrompt({
      prompt: '运行测试',
      cwd: rig.dir,
      config: CONFIG,
      timeoutMs: 60_000,
      log: () => {},
      agentDir: join(rig.dir, 'agent'),
      skillsDir: join(rig.dir, 'skills'),
      onActivity: (act) => {
        capturedActivities.push({ kind: act.kind, toolName: act.toolName, phase: act.phase });
      },
    });

    assert.equal(result.code, 0);
    assert.ok(capturedActivities.length >= 3);
    assert.equal(capturedActivities[0].kind, 'model');
    assert.equal(capturedActivities[1].kind, 'tool');
    assert.equal(capturedActivities[1].toolName, 'read');
    assert.equal(capturedActivities[1].phase, 'start');
    assert.equal(capturedActivities[2].phase, 'end');
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

test('pi-executor: 模拟工具超时，timer 立即上报观察到超时中止请求，但 await 持续直到真正 settled', async () => {
  const rig = tmpCwd();
  let abortInvoked = false;
  let checkpointNote = '';
  const { promise: promptPromise, resolve: finishPrompt } = Promise.withResolvers<void>();

  const stub = {
    ModelRuntime: {
      create: async () => ({
        registerProvider: () => {},
        getModel: (_p: string, id: string) => ({ id }),
      }),
    },
    DefaultResourceLoader: class {
      async reload() {}
      getExtensions() { return []; }
      getSkills() { return []; }
      getPrompts() { return []; }
      getThemes() { return []; }
      getAgentsFiles() { return []; }
      getSystemPrompt() { return ''; }
      getAppendSystemPrompt() { return ''; }
    },
    SettingsManager: { inMemory: () => ({}) },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => {
      const session = {
        messages: [
          { message: { role: 'assistant', content: [{ type: 'text', text: '卡在外部死锁工具中' }] } },
        ],
        prompt: async () => {
          // 底层 prompt 持续挂起，等待真正结束
          await promptPromise;
        },
        abort: async () => {
          abortInvoked = true;
        },
      };
      return { session };
    },
  };

  setPiModuleForTest(stub);
  try {
    let runSettled = false;
    const runPromise = runPiPrompt({
      prompt: '卡死任务',
      cwd: rig.dir,
      config: CONFIG,
      timeoutMs: 15,
      log: () => {},
      agentDir: join(rig.dir, 'agent'),
      skillsDir: join(rig.dir, 'skills'),
      checkpoint: async (note) => {
        checkpointNote = note;
        return { pendingMessages: [] };
      },
    }).then((res) => {
      runSettled = true;
      return res;
    });

    // 等待超时 timer 触发
    const { promise: waitTimer, resolve: timerFired } = Promise.withResolvers<void>();
    setTimeout(timerFired, 30);
    await waitTimer;

    // 验证：timer 触发时立即向服务端上报了超时 checkpoint，且尝试调用了 abort()
    assert.equal(abortInvoked, true, '超时必须尝试触发 abort');
    assert.match(checkpointNote, /执行达到超时上限，已触发中止请求/, 'timer 必须立即上报超时 checkpoint');

    // 关键：底层 prompt 尚未 settled 时，runPiPrompt 绝不提前 fake-resolve 退出！
    assert.equal(runSettled, false, '底层 prompt 尚未 settled 前，runPiPrompt 严禁提前 resolve 导致工蜂重复领活！');

    // 此时外部子进程真正退出或被杀死，prompt 真正 settled
    finishPrompt();
    const result = await runPromise;
    assert.equal(runSettled, true);
    assert.equal(result.code, -1, '真实 settle 后返回 code -1');
    assert.match(result.stdout, /已真正中止退出/);
    assert.match(result.stdout, /卡在外部死锁工具中/);
  } finally {
    setPiModuleForTest(null);
    rig.cleanup();
  }
});

test('polling: 被 Review 退回重做的任务通过 InProgress 渠道认领，保留工作区现场', async () => {
  const reworkTask = {
    id: 'T107-rework',
    title: 'Review 退回任务',
    lane: 'InProgress',
    reviewStatus: 'rework',
    assignee: 'worker-1',
  };

  let claimCalled = false;
  const pollResult = await pollNextDirectedTask(['board-1'], {
    listMine: async (_b, lane) => {
      if (lane === 'InProgress') return [reworkTask];
      return [];
    },
    claim: async (id) => {
      claimCalled = true;
      return { id, title: 'claimed', lane: 'InProgress', reviewStatus: 'none' };
    },
  });
  assert.ok(pollResult);
  assert.equal(pollResult.channel, 'rework');
  assert.equal(pollResult.task.id, 'T107-rework');
  assert.equal(claimCalled, false, '退回重做的 InProgress 任务不重复触发 claim');
});

test('integration: 永不结束的 prompt 驱动多次巡检，rework 状态门禁确保仅执行一次，绝不并发重启', async () => {
  const ongoingTask = {
    id: 'HANGING-TASK',
    title: '挂死任务',
    lane: 'InProgress',
    reviewStatus: 'none',
    assignee: 'worker-1',
  };

  let executionCount = 0;
  // 模拟主循环经历 3 轮巡检
  for (let round = 1; round <= 3; round++) {
    const polled = await pollNextDirectedTask(['board-1'], {
      listMine: async (_b, lane) => {
        if (lane === 'InProgress') return [ongoingTask];
        return [];
      },
      claim: async () => {
        executionCount += 1;
        throw new Error('should not claim');
      },
    });
    // 必须被 rework 状态门禁拦截：普通 InProgress 任务绝不能被重新当成 rework 领取
    assert.equal(polled, null, `第 ${round} 轮巡检严禁把正常 InProgress 任务当成 rework 重新领活`);
  }

  assert.equal(executionCount, 0, '多次巡检下，正常 InProgress 任务绝不能被重复领起');
});
