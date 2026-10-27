import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkRig } from './helpers.ts';
import { createApp } from '../src/http.ts';
import { registerAgent, type Agent } from '../src/agents.ts';
import { createBoard, createTask, type Task } from '../src/tasks.ts';

// MCP 工具清单（与 mcp.ts 保持一致；新增工具时同步补这里）
const ALL_TOOLS = [
  'asterhive_me',
  'asterhive_inbox',
  'asterhive_next',
  'asterhive_claim',
  'asterhive_checkpoint',
  'asterhive_submit',
  'asterhive_release',
  'asterhive_message',
  'asterhive_list_boards',
  'asterhive_list_tasks',
  'asterhive_get_task',
  'asterhive_overview',
  'asterhive_create_task',
  'asterhive_dispatch',
  'asterhive_move_task',
];

interface RpcBody {
  jsonrpc?: string;
  id?: number | null;
  result?: {
    serverInfo?: { name?: string };
    capabilities?: Record<string, unknown>;
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
  };
  error?: { code: number; message: string };
}

// 无状态 Streamable HTTP：每个 POST 独立、自带 Accept 双类型（MCP 规范要求）
async function rpc(
  app: ReturnType<typeof createApp>,
  method: string,
  params: Record<string, unknown>,
  token?: string,
  id = 1,
): Promise<{ status: number; body: RpcBody }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: (await res.json()) as RpcBody };
}

function callTool(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, arguments: args };
}

function resultJson(body: RpcBody): Record<string, unknown> {
  const text = body.result?.content?.[0]?.text;
  assert.ok(typeof text === 'string', 'tool result 应含 content[0].text');
  return JSON.parse(text) as Record<string, unknown>;
}

interface Seed {
  orch: { agent: Agent; token: string };
  bee: { agent: Agent; token: string };
}

// 借领域函数直接播种：一块板 + 一张 Ready 卡（不经过 MCP/HTTP）
function seed(rig: ReturnType<typeof mkRig>): Seed {
  const orch = registerAgent(rig.ctx, { name: '主脑', handle: 'brain-a', role: 'orchestrator' });
  const bee = registerAgent(rig.ctx, { name: '工蜂', handle: 'zcode' });
  createBoard(rig.ctx, { id: 'b', name: '板' });
  createTask(rig.ctx, 'b', { id: 'T1', title: '活', lane: 'Ready', assignee: bee.agent.id });
  return { orch, bee };
}

test('MCP: initialize 握手（带合法 worker token）返回 serverInfo 与 capabilities', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const { bee } = seed(rig);
    const res = await rpc(
      app,
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' } },
      bee.token,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.jsonrpc, '2.0');
    assert.equal(res.body.id, 1);
    assert.equal(res.body.result?.serverInfo?.name, 'asterhive');
    assert.ok(res.body.result?.capabilities?.tools, '应声明 tools 能力');
  } finally {
    rig.cleanup();
  }
});

test('MCP: 无 token——initialize/tools/list 放行，tools/call 一律 -32001 拒绝', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    seed(rig);

    const list = await rpc(app, 'tools/list', {}, undefined, 2);
    assert.equal(list.status, 200);
    const names = (list.body.result?.tools ?? []).map((t) => t.name);
    for (const expected of ALL_TOOLS) {
      assert.ok(names.includes(expected), `tools/list 应含 ${expected}`);
    }

    const me = await rpc(app, 'tools/call', callTool('asterhive_me'), undefined, 3);
    assert.equal(me.body.error?.code, -32001);
    assert.equal(me.body.error?.message, 'valid bearer token required');

    // 伪 token 同样拒绝
    const fake = await rpc(app, 'tools/call', callTool('asterhive_next', { boardId: 'b' }), 'ah_fake', 4);
    assert.equal(fake.body.error?.code, -32001);
  } finally {
    rig.cleanup();
  }
});

test('MCP: worker 全流程——me→next→checkpoint→submit→move_task(Done) 得 [403]', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const { orch, bee } = seed(rig);

    // asterhive_me：身份按发起请求的 token 解析（ALS/闭包双通道验证）
    const me = await rpc(app, 'tools/call', callTool('asterhive_me'), bee.token, 1);
    const identity = resultJson(me.body) as unknown as Agent;
    assert.equal(identity.id, bee.agent.id);
    assert.equal(identity.handle, 'zcode');
    assert.equal(identity.role, 'worker');

    const orchMe = await rpc(app, 'tools/call', callTool('asterhive_me'), orch.token, 2);
    const orchIdentity = resultJson(orchMe.body) as unknown as Agent;
    assert.equal(orchIdentity.role, 'orchestrator', '不同 token 的请求身份互相隔离');

    // asterhive_next：按优先级原子领卡
    const next = await rpc(app, 'tools/call', callTool('asterhive_next', { boardId: 'b' }), bee.token, 3);
    const nextOut = resultJson(next.body) as { task: Task | null; swept: string[] };
    assert.equal(nextOut.task?.id, 'T1');
    assert.equal(nextOut.task?.lane, 'InProgress');
    assert.equal(nextOut.task?.assignee, bee.agent.id);
    assert.deepEqual(nextOut.swept, []);

    // asterhive_checkpoint：打卡并带回未达消息
    const cp = await rpc(
      app,
      'tools/call',
      callTool('asterhive_checkpoint', { taskId: 'T1', note: '正在改 http 路由' }),
      bee.token,
      4,
    );
    const cpOut = resultJson(cp.body) as { task: Task; pendingMessages: unknown[] };
    assert.equal(cpOut.task?.lane, 'InProgress');
    assert.deepEqual(cpOut.pendingMessages, []);

    // asterhive_submit：总结 + 证据 → Review
    const sub = await rpc(
      app,
      'tools/call',
      callTool('asterhive_submit', {
        taskId: 'T1',
        summary: '路由挂载完成',
        evidence: [{ path: 'apps/server/src/mcp.ts', machine: 'dev', note: '新增 /mcp' }],
      }),
      bee.token,
      5,
    );
    const subOut = resultJson(sub.body) as unknown as Task;
    assert.equal(subOut.lane, 'Review');
    assert.equal(subOut.evidence?.[0]?.path, 'apps/server/src/mcp.ts');

    // 信任边界：worker 把卡移到 Done → 领域层 403，JSON-RPC error 带 [403] 前缀
    const moved = await rpc(
      app,
      'tools/call',
      callTool('asterhive_move_task', { taskId: 'T1', lane: 'Done' }),
      bee.token,
      6,
    );
    assert.equal(moved.body.error?.code, -32000);
    assert.ok(moved.body.error?.message.startsWith('[403]'), `应带 [403] 前缀: ${moved.body.error?.message}`);
  } finally {
    rig.cleanup();
  }
});

test('MCP: GET /mcp 在无状态 JSON 模式下按规范拒绝（405 Method Not Allowed）', async () => {
  const rig = mkRig();
  try {
    const app = createApp(rig.ctx);
    const res = await app.request('/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } });
    assert.equal(res.status, 405);
  } finally {
    rig.cleanup();
  }
});
