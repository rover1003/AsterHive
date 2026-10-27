// T14 内置主脑（Pi 运行时，模式 B）测试。
// 不依赖真实模型与网络：
// - 本地 node:http 起一个 OpenAI 兼容 mock（stream:true SSE，脚本化四步：
//   list_boards → create_task → message → 纯文本收尾）；
// - 运行时管理器用注入执行器（stub npm），真实子进程路径不在此测。
import './_brain-env.ts'; // 必须第一条：先设 ASTERHIVE_BRAIN_* 再加载 brain.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type AddressInfo } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, getAgent, listAgents, ensureBrainAgent } from '../src/agents.ts';
import { createBoard, createTask, getTask } from '../src/tasks.ts';
import { nextTask } from '../src/verbs.ts';
import { listMessages } from '../src/messages.ts';
import { listEvents } from '../src/write.ts';
import { PiRuntimeManager } from '../src/pi-runtime.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- OpenAI 兼容 mock（SSE 流式）----

interface Step {
  kind: 'tool' | 'text';
  name?: string;
  args?: Record<string, unknown>;
  content?: string;
}

// 脚本：第1轮列板 → 第2轮建卡 → 第3轮房间汇报 → 第4轮纯文本结束
const SCRIPT: Step[] = [
  { kind: 'tool', name: 'asterhive_list_boards', args: {} },
  { kind: 'tool', name: 'asterhive_create_task', args: { boardId: 'b', id: 'T9', title: '主脑建卡测试', acceptance: '房间出现主脑的建卡汇报' } },
  { kind: 'tool', name: 'asterhive_message', args: { boardId: 'b', content: '@老板 已建卡 T9：主脑建卡测试' } },
  { kind: 'text', content: '路线图已建完并向用户汇报，本轮结束。' },
];

function chunk(id: string, delta: Record<string, unknown>, finish: string | null, usage = false): string {
  const payload: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-1',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) {
    payload.choices = [];
    payload.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  }
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(step: Step, id: string): string {
  let out = chunk(id, { role: 'assistant', content: '' }, null);
  if (step.kind === 'tool') {
    out += chunk(id, { tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: step.name, arguments: '' } }] }, null);
    out += chunk(id, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args ?? {}) } }] }, null);
    out += chunk(id, {}, 'tool_calls');
  } else {
    out += chunk(id, { content: step.content ?? '' }, null);
    out += chunk(id, {}, 'stop');
  }
  out += chunk(id, {}, null, true);
  return `${out}data: [DONE]\n\n`;
}

function startMock(): { server: Server; port: () => number; calls: () => number; systemPrompts: string[]; requestBodies: Record<string, unknown>[] } {
  let n = 0;
  const systemPrompts: string[] = [];
  const requestBodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      n += 1;
      try {
        const request = JSON.parse(body) as Record<string, unknown> & { messages?: { role?: string; content?: unknown }[] };
        requestBodies.push(request);
        const promptMessages = request.messages?.filter((m) => m.role === 'system' || m.role === 'developer') ?? [];
        systemPrompts.push(promptMessages.map((m) => String(m.content ?? '')).join('\n'));
      } catch {
        systemPrompts.push('');
      }
      const step = SCRIPT[Math.min(n - 1, SCRIPT.length - 1)];
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(sseResponse(step, String(n)));
    });
  });
  return {
    server,
    port: () => (server.address() as AddressInfo).port,
    calls: () => n,
    systemPrompts,
    requestBodies,
  };
}

function httpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', ...extra };
}

// 挂起型 mock：收到 chat/completions 后只计数、不写响应——SDK 侧请求一直挂着，
// 用于制造"轮次运行中、卡在模型调用"的窗口（abortTurn 测试用）
function startHangingMock(): { server: Server; port: () => number; calls: () => number } {
  let n = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
      return;
    }
    req.on('data', () => {}); // 消费请求体，保持连接但不响应
    n += 1;
  });
  return {
    server,
    port: () => (server.address() as AddressInfo).port,
    calls: () => n,
  };
}

// ---- 主脑端到端（mock 模型）----

test('主脑：启用后用户消息唤醒——建卡/汇报/turn_finished 落账；worker 语义不受影响', async () => {
  const rig = mkRig();
  const mock = startMock();
  try {
    const app = createApp(rig.ctx);
    createBoard(rig.ctx, { id: 'b', name: '测试板' });
    // 用户身份固定 id='user'；通过真实设置 API 修改可自定义 handle，验证主脑提示动态使用 @handle。
    const rename = await app.request('/api/user', {
      method: 'PUT',
      headers: httpHeaders(),
      body: JSON.stringify({ handle: '老板' }),
    });
    assert.equal(rename.status, 200);

    await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r));

    // 建主脑模型组（多模型组 API：每组独立 baseURL/apiKey/model），再启用主脑（零令牌：无 Authorization 即 user 身份）
    const grp = await app.request('/settings/orchestrator/groups', {
      method: 'POST',
      headers: httpHeaders(),
      body: JSON.stringify({ name: 'mock 通道', baseURL: `http://127.0.0.1:${mock.port()}/v1`, apiKey: 'sk-mock', model: 'mock-1' }),
    });
    assert.equal(grp.status, 201);
    const put = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: httpHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put.status, 200);
    const settings = (await put.json()) as { enabled?: boolean };
    assert.equal(settings.enabled, true);

    // 激活应同步完成：brain.started + 系统身份 brain.registered 已落账
    const earlyTypes = () => listEvents(rig.ctx, { limit: 100 }).map((e) => e.type);
    assert.ok(earlyTypes().includes('brain.started'), '启用后应有 brain.started');
    assert.ok(earlyTypes().includes('brain.registered'), '首次启动应注册系统主脑身份');
    const brainAgent = getAgent(rig.ctx, 'asterhive-brain');
    assert.equal(brainAgent.role, 'orchestrator');
    assert.equal(brainAgent.handle, '主脑');

    // 用户在房间发言（无 token → author='user'，intervention）→ 唤醒
    const post = await app.request('/boards/b/messages', {
      method: 'POST',
      headers: httpHeaders(),
      body: JSON.stringify({ content: '@主脑 请为测试目标建一张卡 T9' }),
    });
    assert.equal(post.status, 201);

    // 轮询台账等 brain.turn_finished（去抖 200ms + 会话创建 + 4 步 mock 轮次）
    let finished: { payload: Record<string, unknown> } | undefined;
    for (let i = 0; i < 300 && !finished; i++) {
      await sleep(200);
      finished = listEvents(rig.ctx, { type: 'brain.turn_finished', limit: 1 })[0];
    }
    assert.ok(finished, '60 秒内应出现 brain.turn_finished');
    assert.ok(finished.payload.turnMs !== undefined);

    // 板上出现新卡（主脑 create_task 生效，默认 Backlog）
    const t9 = getTask(rig.ctx, 'T9');
    assert.equal(t9.boardId, 'b');
    assert.equal(t9.lane, 'Backlog');
    assert.equal(t9.title, '主脑建卡测试');
    assert.ok(t9.acceptance.includes('建卡汇报'));

    // 房间出现 author=asterhive-brain 的消息（内容含"已建卡"）
    const msgs = listMessages(rig.ctx, 'b', {});
    const brainMsg = msgs.find((m) => m.author === 'asterhive-brain');
    assert.ok(brainMsg, '房间应有主脑发言');
    assert.ok(brainMsg.content.includes('已建卡'), `主脑消息内容不符：${brainMsg.content}`);
    assert.ok(brainMsg.mentions.includes('老板'));
    assert.ok(mock.systemPrompts.some((p) => p.includes('@老板')), 'Pi 系统提示必须注入当前用户 handle');
    assert.equal(mock.requestBodies[0]?.reasoning_effort, 'low', 'Pi 发给上游的真实 OpenAI 兼容请求体必须带 reasoning_effort=low');

    // 台账关键事件齐全；mock 恰好被调 4 次（list_boards/create_task/message/收尾）
    const types = earlyTypes();
    assert.ok(types.includes('brain.turn_started'));
    assert.ok(types.includes('task.created'));
    assert.equal(mock.calls(), 4, `mock 应被调 4 次，实际 ${mock.calls()}`);

    // turn_started 标注本次通道（多模型组：排查"这次用的哪条通道"）
    const started = listEvents(rig.ctx, { type: 'brain.turn_started', limit: 1 })[0];
    assert.equal(started.payload.groupName, 'mock 通道');
    assert.ok(typeof started.payload.groupId === 'string' && started.payload.groupId.startsWith('g'));
    // 自定义映射必须穿过 Pi 序列化为上游 max 标签。
    const finishedBeforeMap = listEvents(rig.ctx, { type: 'brain.turn_finished', limit: 10 }).length;
    const mappedLevel = await app.request(`/settings/orchestrator/groups/${started.payload.groupId}`, {
      method: 'PUT',
      headers: httpHeaders(),
      body: JSON.stringify({ thinkingLevel: 'xhigh', thinkingLevelMap: { xhigh: 'max' } }),
    });
    assert.equal(mappedLevel.status, 200);
    const mappedPost = await app.request('/boards/b/messages', {
      method: 'POST',
      headers: httpHeaders(),
      body: JSON.stringify({ content: '@主脑 使用新等级' }),
    });
    assert.equal(mappedPost.status, 201);
    for (let i = 0; i < 300 && listEvents(rig.ctx, { type: 'brain.turn_finished', limit: 10 }).length <= finishedBeforeMap; i++) {
      await sleep(200);
    }
    assert.equal(mock.calls(), 5);
    assert.equal(mock.requestBodies[4]?.reasoning_effort, 'max', 'Pi xhigh 按显式模型组映射序列化为上游 max');

    // 单独关闭思考后再重建 Pi session；真实请求体应不再包含 reasoning_effort。
    const finishedBeforeOff = listEvents(rig.ctx, { type: 'brain.turn_finished', limit: 10 }).length;
    const offLevel = await app.request(`/settings/orchestrator/groups/${started.payload.groupId}`, {
      method: 'PUT',
      headers: httpHeaders(),
      body: JSON.stringify({ thinkingLevel: 'off' }),
    });
    assert.equal(offLevel.status, 200);
    const offPost = await app.request('/boards/b/messages', {
      method: 'POST',
      headers: httpHeaders(),
      body: JSON.stringify({ content: '@主脑 请继续' }),
    });
    assert.equal(offPost.status, 201);
    for (let i = 0; i < 300 && listEvents(rig.ctx, { type: 'brain.turn_finished', limit: 10 }).length <= finishedBeforeOff; i++) {
      await sleep(200);
    }
    assert.equal(mock.calls(), 6, '设置 off 后应重建 session 并完成下一次上游请求');
    assert.equal(mock.requestBodies[5]?.reasoning_effort, undefined, 'thinkingLevel=off 不向上游发送 reasoning_effort');
    // ---- worker 语义不受影响：领卡/交活动词照常 ----
    const bee = registerAgent(rig.ctx, { name: '工蜂', handle: 'bee' });
    createTask(rig.ctx, 'b', { id: 'T1', title: '执行卡', lane: 'Ready' });
    const claimed = nextTask(rig.ctx, bee.agent, 'b');
    assert.equal(claimed.task?.id, 'T1');
    assert.equal(claimed.task?.assignee, bee.agent.id);

    // 主脑结构性约束：orchestrator 调执行动词被领域层 403
    assert.throws(() => nextTask(rig.ctx, getAgent(rig.ctx, 'asterhive-brain'), 'b'), /orchestrator never executes/);

    // 关闭主脑 → brain.stopped 落账，去抖计时器与会话被清理（匿名即 user，无凭据可写）
    const off = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: httpHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    await sleep(300);
    assert.ok(earlyTypes().includes('brain.stopped'), '关闭后应有 brain.stopped');
  } finally {
    mock.server.close();
    rig.cleanup();
  }
});

test('主脑：停止按钮——运行中 abort 落账 turn_finished(aborted) 且不计失败；未运行幂等 false', async () => {
  const rig = mkRig();
  const mock = startHangingMock();
  try {
    const app = createApp(rig.ctx);
    createBoard(rig.ctx, { id: 'b', name: '板' });
    await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r));
    const grp = await app.request('/settings/orchestrator/groups', {
      method: 'POST',
      headers: httpHeaders(),
      body: JSON.stringify({ name: '挂起通道', baseURL: `http://127.0.0.1:${mock.port()}/v1`, apiKey: 'sk-mock', model: 'mock-1' }),
    });
    assert.equal(grp.status, 201);
    const put = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: httpHeaders(),
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(put.status, 200);

    // 授权：worker token 403（requireElevated）；匿名（=user）放行
    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'bee' });
    const forbidden = await app.request('/settings/orchestrator/abort', {
      method: 'POST',
      headers: httpHeaders({ authorization: `Bearer ${worker.token}` }),
    });
    assert.equal(forbidden.status, 403);

    // 未运行：幂等 false
    const idle = await app.request('/settings/orchestrator/abort', { method: 'POST', headers: httpHeaders() });
    assert.equal(idle.status, 200);
    assert.equal(((await idle.json()) as { aborted: boolean }).aborted, false);

    // 用户消息唤醒 → 等轮次开始 → 等模型请求抵达挂起 mock（此刻轮次卡在模型调用中）
    await app.request('/boards/b/messages', {
      method: 'POST',
      headers: httpHeaders(),
      body: JSON.stringify({ content: '@主脑 停止测试' }),
    });
    let started: { id: number } | undefined;
    for (let i = 0; i < 150 && !started; i++) {
      await sleep(200);
      started = listEvents(rig.ctx, { type: 'brain.turn_started', limit: 1 })[0];
    }
    assert.ok(started, '30 秒内应出现 brain.turn_started');
    for (let i = 0; i < 100 && mock.calls() === 0; i++) await sleep(100);
    assert.ok(mock.calls() >= 1, '模型请求应已抵达挂起 mock');
    await sleep(500); // 留出请求在途窗口，确保 abort 打断的是 prompt 而非会话创建

    // 运行中 abort：返回 true，brain.turn_aborted 落账
    const abort = await app.request('/settings/orchestrator/abort', { method: 'POST', headers: httpHeaders() });
    assert.equal(abort.status, 200);
    assert.equal(((await abort.json()) as { aborted: boolean }).aborted, true);
    assert.equal(listEvents(rig.ctx, { type: 'brain.turn_aborted', limit: 5 }).length, 1);

    // 立即二次 abort：会话已在第一次 abort 中同步弃置（#session=null）→ 幂等 false
    const again = await app.request('/settings/orchestrator/abort', { method: 'POST', headers: httpHeaders() });
    assert.equal(((await again.json()) as { aborted: boolean }).aborted, false);

    // 轮次收尾：turn_finished 照常落账，payload 标注 aborted: true（modelError 可能非空但不进失败统计）
    let finished: { payload: Record<string, unknown> } | undefined;
    for (let i = 0; i < 150 && !finished; i++) {
      await sleep(200);
      finished = listEvents(rig.ctx, { type: 'brain.turn_finished', limit: 1 })[0];
    }
    assert.ok(finished, '30 秒内应出现 brain.turn_finished（abort 后轮次正常收尾）');
    assert.equal(finished.payload.aborted, true);

    // 失败计数隔离：中止轮不计 modelError 失败 → 不排 60s 自动重试。若被误计，
    // 会排自动重试并在去抖后开新轮——观察窗口内 turn_started 不应增多；
    // 也不应出现"连续失败停止自动重试"的系统提示
    const before = listEvents(rig.ctx, { type: 'brain.turn_started', limit: 10 }).length;
    await sleep(2000);
    const after = listEvents(rig.ctx, { type: 'brain.turn_started', limit: 10 }).length;
    assert.equal(after, before, '中止轮不应触发自动重试（失败计数未递增）');
    const sysMsgs = listMessages(rig.ctx, 'b', {}).filter(
      (m) => m.author === 'asterhive-brain' && m.kind === 'system',
    );
    assert.equal(sysMsgs.length, 0, '主动中止不应产生失败系统提示');
  } finally {
    mock.server.close();
    rig.cleanup();
  }
});

test('主脑：未配置模型组（无激活组）时唤醒不产生轮次', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const boss = registerAgent(rig.ctx, { name: '老板', handle: 'boss', role: 'user' });
    createBoard(rig.ctx, { id: 'b', name: '板' });
    const put = await app.request('/settings/orchestrator', {
      method: 'PUT',
      headers: httpHeaders({ authorization: `Bearer ${boss.token}` }),
      body: JSON.stringify({ enabled: true }), // 没有任何模型组
    });
    assert.equal(put.status, 200);
    await app.request('/boards/b/messages', {
      method: 'POST',
      headers: httpHeaders(),
      body: JSON.stringify({ content: '@主脑 试试' }),
    });
    await sleep(800); // 越过去抖窗口
    const types = listEvents(rig.ctx, { limit: 100 }).map((e) => e.type);
    assert.ok(types.includes('brain.started'), '主脑激活（身份注册）照常');
    assert.ok(!types.includes('brain.turn_started'), '未配置模型不应有轮次');
  } finally {
    rig.cleanup();
  }
});

// ---- Pi 运行时管理器 ----

// 在数据卷伪造一个"安装完成"的 Pi 包（update 的 stub 执行器调用）
function fakeInstall(dataDir: string, version: string): void {
  const pkgDir = join(dataDir, 'pi-runtime', 'versions', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
  writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {}');
}

test('运行时：无数据卷回落仓库基线，版本读取正确，状态读侧可用', () => {
  const rig = mkRig();
  try {
    const rt = new PiRuntimeManager(rig.ctx);
    const resolved = rt.resolveRuntime();
    assert.equal(resolved.source, 'baseline');
    const pkg = JSON.parse(readFileSync(join(resolved.pkgDir, 'package.json'), 'utf8')) as { version: string };
    assert.equal(resolved.version, pkg.version, '基线版本应读自实际安装的包');

    const st = rt.status();
    assert.equal(st.source, 'baseline');
    assert.equal(st.current, pkg.version);
    assert.equal(st.updating, null);
    assert.ok(st.extensionsDir.includes(join('pi-runtime', 'extensions')));
    // 社区插件挂载点：目录不存在时返回空数组（不预装任何）
    assert.deepEqual(rt.communityExtensionPaths(), []);
  } finally {
    rig.cleanup();
  }
});

test('运行时：技能挂载点随启动建目录，状态读侧给出 extensionsDir/skillsDir', () => {
  const rig = mkRig();
  try {
    // brain.start()（createApp 内调用）应已确保挂载点目录存在（幂等，空目录 = 未挂载任何）
    const rt = new PiRuntimeManager(rig.ctx);
    rt.ensureMountDirs();
    assert.ok(existsSync(join(rig.ctx.cfg.dataDir, 'pi-runtime', 'extensions')), 'extensions/ 已建');
    assert.ok(existsSync(join(rig.ctx.cfg.dataDir, 'pi-runtime', 'skills')), 'skills/ 已建');
    const st = rt.status();
    assert.ok(st.skillsDir.includes(join('pi-runtime', 'skills')), 'status 暴露技能挂载点');
    // 技能挂载点目录本身不参与扩展发现（communityExtensionPaths 只看 extensions/ 子目录）
    assert.deepEqual(rt.communityExtensionPaths(), []);
  } finally {
    rig.cleanup();
  }
});

test('运行时：数据卷 current 指针优先于基线', () => {  const rig = mkRig();
  try {
    fakeInstall(rig.ctx.cfg.dataDir, '1.2.3-test');
    // 指针文件形态
    const rt = new PiRuntimeManager(rig.ctx);
    mkdirSync(join(rig.ctx.cfg.dataDir, 'pi-runtime', 'current'), { recursive: true });
    writeFileSync(
      join(rig.ctx.cfg.dataDir, 'pi-runtime', 'current', 'version.json'),
      JSON.stringify({ version: '1.2.3-test' }),
    );
    const resolved = rt.resolveRuntime();
    assert.equal(resolved.source, 'volume');
    assert.equal(resolved.version, '1.2.3-test');
    assert.ok(resolved.pkgDir.includes(join('versions', '1.2.3-test')));
    // 主脑入口解析应给出该包的 dist/index.js
    const entry = rt.ensureRuntimeEntry();
    assert.equal(entry.version, '1.2.3-test');
    assert.ok(entry.entryUrl.endsWith('dist/index.js'));
  } finally {
    rig.cleanup();
  }
});

test('运行时：update/rollback（stub npm）——指针切换、事件落账、旧版保留', async () => {
  const rig = mkRig();
  try {
    const calls: string[] = [];
    const rt = new PiRuntimeManager(rig.ctx, {
      executor: async (cmd) => {
        calls.push(cmd);
        // 模拟 npm install 的落盘结果：从命令尾部解析 @<version>
        const m = cmd.match(/@([\w.-]+)$/);
        if (m) fakeInstall(rig.ctx.cfg.dataDir, m[1]);
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    // update 到指定版本
    const baselineBefore = rt.resolveRuntime();
    assert.equal(baselineBefore.source, 'baseline');
    const r1 = await rt.update('9.9.9');
    assert.equal(r1.to, '9.9.9');
    assert.equal(r1.from, baselineBefore.version); // from=当时的基线版本（此前无 volume）
    assert.equal(rt.resolveRuntime().source, 'volume');
    assert.equal(rt.resolveRuntime().version, '9.9.9');
    assert.ok(calls[0].includes('npm install --prefix'), `应调 npm install：${calls[0]}`);
    assert.ok(calls[0].includes('@earendil-works/pi-coding-agent@9.9.9'));
    // 指针文件落账
    const pointer = JSON.parse(
      readFileSync(join(rig.ctx.cfg.dataDir, 'pi-runtime', 'current', 'version.json'), 'utf8'),
    ) as { version: string };
    assert.equal(pointer.version, '9.9.9');
    // 事件 pi.runtime_updated
    const ev1 = listEvents(rig.ctx, { type: 'pi.runtime_updated', limit: 5 });
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0].payload.to, '9.9.9');

    // 再装一个更早"安装"的版本（台账顺序：9.9.9 → 8.8.8）
    await rt.update('8.8.8');
    assert.equal(rt.resolveRuntime().version, '8.8.8');
    assert.ok(existsSync(join(rig.ctx.cfg.dataDir, 'pi-runtime', 'versions', '9.9.9')), '旧版本目录保留');

    // 回滚 → 回到 9.9.9
    const rb = await rt.rollback();
    assert.deepEqual([rb.from, rb.to], ['8.8.8', '9.9.9']);
    assert.equal(rt.resolveRuntime().version, '9.9.9');
    const ev2 = listEvents(rig.ctx, { type: 'pi.runtime_rolled_back', limit: 5 });
    assert.equal(ev2.length, 1);

    // 已是最早版本 → 409
    await assert.rejects(() => rt.rollback(), /没有更早的可回滚版本/);

    // npm 失败 → 明确错误，指针不动
    const failing = new PiRuntimeManager(rig.ctx, {
      executor: async () => ({ code: 127, stdout: '', stderr: 'npm: command not found' }),
    });
    await assert.rejects(() => failing.update('7.7.7'), /npm install 失败|npm 不可用/);
    assert.equal(rt.resolveRuntime().version, '9.9.9');
  } finally {
    rig.cleanup();
  }
});

test('运行时：update 缺省版本走 npm view 查 latest；GET /settings/runtime 授权与形态', async () => {
  const rig = mkRig();
  const mock = startMock();
  try {
    const app = createApp(rig.ctx);
    const worker = registerAgent(rig.ctx, { name: '工蜂', handle: 'bee' });

    // REST 读侧（无需授权；latest 查询会失败→null，UI 显示未知——此环境无 npm view 指向 mock）
    const res = await app.request('/settings/runtime');
    assert.equal(res.status, 200);
    const st = (await res.json()) as { current: string | null; source: string; latest: string | null; updating: unknown; extensionsDir: string };
    assert.ok(typeof st.current === 'string' && st.current.length > 0);
    assert.equal(st.source, 'baseline');
    assert.equal(st.updating, null);
    assert.ok(st.extensionsDir.includes('pi-runtime'));

    // 写侧授权（requireElevated）：无效 token 401，worker 403
    const badAuth = await app.request('/settings/runtime/update', {
      method: 'POST',
      headers: httpHeaders({ authorization: 'Bearer ah-invalid' }),
      body: JSON.stringify({ version: '9.9.9' }),
    });
    assert.equal(badAuth.status, 401, '无效 bearer 401');
    const workerTry = await app.request('/settings/runtime/update', {
      method: 'POST',
      headers: httpHeaders({ authorization: `Bearer ${worker.token}` }),
      body: JSON.stringify({ version: '9.9.9' }),
    });
    assert.equal(workerTry.status, 403);

    // 匿名（=user）放行 → 真正走完 update。测试环境装不了真包：
    // 把垫片目录前置到 PATH 顶替 npm（exit 0），并预置安装结果让包完整性校验通过。
    const shimDir = join(rig.ctx.cfg.dataDir, 'npm-shim');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, 'npm.cmd'), '@echo off\r\nexit /b 0\r\n'); // Windows: cmd.exe 按 PATHEXT 解析
    const npmSh = join(shimDir, 'npm');
    writeFileSync(npmSh, '#!/bin/sh\nexit 0\n'); // POSIX 兜底
    chmodSync(npmSh, 0o755);
    fakeInstall(rig.ctx.cfg.dataDir, '9.9.9');
    const prevPath = process.env.PATH ?? '';
    process.env.PATH = `${shimDir}${delimiter}${prevPath}`;
    let noAuth: Response;
    try {
      noAuth = await app.request('/settings/runtime/update', {
        method: 'POST',
        headers: httpHeaders(),
        body: JSON.stringify({ version: '9.9.9' }),
      });
    } finally {
      process.env.PATH = prevPath;
    }
    assert.equal(noAuth.status, 200, '匿名（=user）放行：update 完成');
    const noAuthBody = (await noAuth.json()) as { ok: boolean; to: string };
    assert.equal(noAuthBody.ok, true);
    assert.equal(noAuthBody.to, '9.9.9');

    // stub 执行器 + 缺省版本：latestVersion 从 stub 的 stdout 解析
    const rt = new PiRuntimeManager(rig.ctx, {
      executor: async (cmd) => {
        if (cmd.startsWith('npm view')) return { code: 0, stdout: '9.9.9\n', stderr: '' };
        const m = cmd.match(/@([\w.-]+)$/);
        if (m) fakeInstall(rig.ctx.cfg.dataDir, m[1]);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const r = await rt.update(); // 不传 version → latest=9.9.9
    assert.equal(r.to, '9.9.9');
    assert.equal(rt.resolveRuntime().version, '9.9.9');
  } finally {
    mock.server.close();
    rig.cleanup();
  }
});

test('主脑身份：registerSystemAgent 幂等、token 占位不外发、未启用不注册', () => {
  const rig = mkRig();
  try {
    createApp(rig.ctx); // 启动 Brain（未启用状态：仅订阅总线）
    assert.equal(listAgents(rig.ctx).length, 0, '未启用主脑时不注册任何身份');

    // 直接注册系统身份：返回 Agent 无 token 字段（占位 token 只存哈希，永不返回）
    const agent = ensureBrainAgent(rig.ctx);
    assert.equal(agent.id, 'asterhive-brain');
    assert.equal(agent.handle, '主脑');
    assert.equal(agent.role, 'orchestrator');
    assert.ok(!('token' in agent));
    // 幂等：再次注册返回同一身份，不重复插行
    const again = ensureBrainAgent(rig.ctx);
    assert.equal(again.id, 'asterhive-brain');
    assert.equal(listAgents(rig.ctx).length, 1);
    // 只产生一次 brain.registered 事件
    const regs = listEvents(rig.ctx, { type: 'brain.registered', limit: 5 });
    assert.equal(regs.length, 1);
  } finally {
    rig.cleanup();
  }
});
