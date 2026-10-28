import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Hono, Context } from 'hono';
import type { Ctx } from './types.ts';
import { HttpError } from './types.ts';
import { authByToken, type Agent } from './agents.ts';
import { TOOL_DEFS } from './orchestrator-tools.ts';

// ---- 鉴权设计（关键）----
// token 绝不出现在工具参数里（避免进对话/日志）：HTTP 层读 Authorization: Bearer <token>，
// 用 authByToken 解析为 Agent，再以 AsyncLocalStorage 携带"本次请求身份"跨过 SDK 的
// 工具分发边界——工具处理器内从 ALS 取 actor 同进程直调领域函数（不走 HTTP 回环）。
// 兜底：每个 POST 都会把解析出的 agent 绑进本次新建 server 的闭包（无状态模式下
// transport/server 一请求一换，SDK 明确禁止复用），ALS 读不到时用闭包绑定，两者一致。
const actorStorage = new AsyncLocalStorage<Agent | null>();

const ERR_DOMAIN = -32000; // 领域层 HttpError（message 带 [状态码] 前缀）
const ERR_AUTH = -32001; // 无效/缺失 bearer token 的 tools/call

function bearer(c: Context): string | null {
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

// 工具分发处抛出：带数字 code 即被 SDK Protocol 映射为 JSON-RPC error envelope，
// message 原样透传（McpError 会自行加 "MCP error <code>: " 前缀，不符合本项目契约）。
class JsonRpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// 领域函数抛 HttpError → JSON-RPC error，message 带状态码前缀如 "[403] ..."
async function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) {
      throw new JsonRpcError(ERR_DOMAIN, `[${err.status}] ${err.message}`);
    }
    throw err;
  }
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

// 每个请求新建一个 McpServer：闭包绑定本次请求的 agent（bound），
// 运行时优先从 ALS 取（由 mountMcp 的 actorStorage.run 注入），两者互相兜底。
// 工具定义来自 orchestrator-tools.ts 单一事实源（T14：与内置主脑共用）。
function buildServer(ctx: Ctx, bound: Agent | null): McpServer {
  const server = new McpServer(
    { name: 'asterhive', version: '0.1.0' },
    {
      instructions:
        'AsterHive（星巢）分派服务器。worker 用 asterhive_next/claim/checkpoint/submit/release 领活交活；主脑用 asterhive_create_task/dispatch/move_task 派活。asterhive_me 查看当前身份。',
    },
  );

  const actor = (): Agent => {
    const agent = actorStorage.getStore() ?? bound;
    if (!agent) throw new JsonRpcError(ERR_AUTH, 'valid bearer token required');
    return agent;
  };

  const defs = TOOL_DEFS;

  // 注册进 McpServer：只为 tools/list 生成 schema 与元数据。
  // 实际执行不走这些 stub——tools/call 被下方 override 接管。
  for (const d of defs) {
    server.registerTool(
      d.name,
      { description: d.description, ...(d.shape ? { inputSchema: d.shape } : {}) },
      async () => {
        throw new JsonRpcError(ErrorCode.InternalError, 'asterhive tools/call is dispatched by override');
      },
    );
  }

  // Override tools/call（官方出口：McpServer.server 底层 Server）以保留 JSON-RPC error 语义：
  // McpServer 高层 API 会把 handler 抛错折叠成 isError 工具结果，而本项目契约要求
  // 鉴权/领域错误以 JSON-RPC error（-32001 / "[403] ..." 前缀）回给客户端。
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const def = defs.find((d) => d.name === name);
    if (!def) throw new JsonRpcError(ErrorCode.InvalidParams, `Tool ${name} not found`);
    let parsed: Record<string, unknown> = {};
    if (def.shape) {
      const result = z.object(def.shape).safeParse(request.params.arguments ?? {});
      if (!result.success) {
        throw new JsonRpcError(
          ErrorCode.InvalidParams,
          `Invalid arguments for ${name}: ${result.error.message}`,
        );
      }
      parsed = result.data as Record<string, unknown>;
    }
    const res = await call(async () => await def.handle(ctx, actor(), parsed));
    return text(res);
  });

  return server;
}

// 挂载到 Hono app：/mcp 走官方 Streamable HTTP（无状态模式）。
// 每个 POST 独立 transport + server（SDK 要求无状态 transport 不可复用），
// enableJsonResponse 使响应为普通 JSON 而非 SSE 流，天然与静态托管共存。
export function mountMcp(app: Hono, ctx: Ctx): void {
  app.all('/mcp', async (c) => {
    if (c.req.method !== 'POST') {
      // 无状态 JSON 模式不提供 GET SSE / DELETE 会话终结，按 MCP 规范回 405
      return c.body(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: ERR_DOMAIN, message: 'method not allowed: stateless JSON mode supports POST only' },
        }),
        405,
        { Allow: 'POST' },
      );
    }
    // HTTP 层鉴权：token 只出现在请求头；initialize / tools/list 无 token 也放行，
    // 其余工具调用在 tools/call 分发处拒绝（JSON-RPC error -32001）。
    const agent = authByToken(ctx, bearer(c));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态：不生成会话 id，不做会话校验
      enableJsonResponse: true,
    });
    const server = buildServer(ctx, agent);
    await server.connect(transport);
    try {
      // ALS 把本次请求身份带进 SDK 内部异步分发链；闭包绑定兜底（见 buildServer.actor）
      return await actorStorage.run(agent, () => transport.handleRequest(c.req.raw));
    } finally {
      await server.close().catch(() => {});
    }
  });
}
