# Pi 插件/扩展生态调研（面向内置主脑选型）

> 调研日期 2026-10-25 · 由子代理完成，信息源与热度数据见文内 · 服务对象：二期 T14 内置主脑（Pi）
> 结论速览：**Pi 1.0 原生具备完整 MCP client（streamable HTTP + Bearer），主脑直连我们 /mcp 零胶水**；值得装的第三方插件极少，核心增强靠"内置 MCP + 自写 allowlist 门控"，记忆优先做服务器侧。

## 一、生态概览

Pi 扩展体系四层，全部围绕"TypeScript 模块直接改 harness"：

1. **扩展（extensions）**：导出默认工厂函数的 TS 模块（jiti 免编译加载），经 `ExtensionAPI` 可 `registerTool/registerCommand/registerProvider/registerVirtualModel/registerMcpServer`，可监听全生命周期事件（`before_agent_start` 改系统提示词、`tool_call` 门控事件可 `{ block: true }` 拦截且 handler 异常时 **fail-closed**、`session_start`、`agent_end` 等）。CLI 内置扩展 `builtin:mcp / builtin:codemode / builtin:tool_search` 可 `-builtin:mcp` 禁用。
2. **skills**：提示词/上下文层资源，非可执行代码。
3. **packages**：`pi install npm:<pkg>`，官方目录 pi.dev/packages（5343 包，头部包月下载 25K–1.8M，主包周下载 287 万）。
4. **SDK 嵌入**：`createAgentSession()` + `DefaultResourceLoader` 的 `extensionFactories`（内联工厂）与 `additionalExtensionPaths`。关键差异——**SDK 会话不自动加载内置扩展**（MCP 需显式 `createMcpExtension()` 工厂并 `session.bindExtensions()`）；会话持久化 JSONL 树（`SessionManager`，原生 compaction），`steer()/followUp()` 原生支持中途注入。

## 二、插件清单（按主脑需求类别）

| 名称 | 来源 | 热度 | 功能 | 主脑适配度 | 许可证 |
|---|---|---|---|---|---|
| 内置 MCP（builtin:mcp） | pi.dev/docs/latest/mcp | 随 Pi 1.0 | 原生 MCP client：stdio + streamable HTTP，headers 支持 `Bearer ${ENV}` | **高**——直连 /mcp 的正解 | MIT |
| pi-mcp-adapter | nicobailon/pi-mcp-adapter | 160 万/月 | 第三方 MCP 适配器（懒启动/多服务器） | 中——单服务器场景内置即可 | MIT |
| billion-context | ranxianglei/billion-context | 180 万/月 | 模型驱动可逆上下文压缩，95%+ 前缀缓存命中 | 高——长期会话压缩升级项 | **MIT+署名附加条款** |
| @earendil-works/pi-durable | 官方 monorepo | 官方实验 v1.3.0 | "活过自身崩溃"的持久运行时，工具可标 `replay:"safe"` | 高——常驻进程崩溃恢复（二期先原生 JSONL） | MIT |
| gentle-engram | Gentleman-Programming/engram | 2.73 万/月 | 跨会话/跨压缩持久记忆（Go+SQLite/FTS5） | 高——但架构上更优是服务器侧 remember/recall | MIT |
| pi-memory | pi.dev/packages | 4.2 万/月 | qmd 语义搜索记忆 | 中（两个月未更新） | 未核实 |
| pi-schedule-prompt | tintinweb/pi-schedule-prompt | 1,223/月 | 会话内心跳：到期注入 prompt | 中——与服务器事件唤醒重复 | MIT |
| agents-cron | fookhsu/agents-cron | 966/月 | 外部 cron 拉起无头进程 | 低——与常驻单会话架构冲突 | MIT |
| @juicesharp/rpiv-todo | pi.dev/packages | 15.15 万/月 | 模型 todo + overlay | 低——看板就是主脑的 todo，勿双源 | 未核实 |
| pi-goal-x | pi.dev/packages | 8.89 万/月 | 目标规划/进度/完成审计 | 低——目标态在服务器侧 | 未核实 |
| pi-subagents | pi.dev/packages | 55.83 万/月 | 委托与多 agent 工作流 | 低（反向）——给主脑加执行面，违反约束 | 未核实 |
| pi-background-tasks | pi.dev/packages | 4.49 万/月 | 持久后台 shell + 只读委托 | 低——shell 执行面禁用 | 未核实 |
| pi-cuttle | pi.dev/packages | 8 天前更新 | 虚拟模型路由器（按原生 model role） | 中/低——单模型主脑不必 | 未核实 |
| @gotgenes/pi-permission-system | pi.dev/packages | 6 万/月 | 权限强制 | 低——自写 30 行 allowlist 更贴合 | 未核实 |
| @langfuse/@braintrust 观测插件 | pi.dev/packages | 24.9 万/2.84 万每月 | turns/工具调用追踪 | 中/低——事件台账已是权威审计源 | 未核实 |

## 三、推荐短名单

1. **内置 MCP（必开项，非选购）**：CLI `pi mcp add asterhive --url <server>/mcp --bearer-token-env-var ASTERHIVE_TOKEN`；SDK 侧 `createMcpExtension()` 入 `extensionFactories` 或扩展内 `pi.registerMcpServer("asterhive", { url, headers, exposure: "direct" })`。**两个坑**：exposure 默认 codemode（模型看不到工具），必须 `exposure: "direct"`（或 deferred+tool_search）；工具名为 `mcp__asterhive__*` 前缀。
2. **自写薄扩展：工具 allowlist 门控（30–50 行）**：用官方 `tool_call` gate 事件只放行 `mcp__asterhive__*`（写操作按角色再筛），其余一律 block——handler 异常 fail-closed，语义就是为安全门设计的。这把"只分派不执行"做成硬约束。SDK 侧 `tools/excludeTools` 只留 MCP 工具双保险。
3. **@earendil-works/pi-durable（官方实验）**：崩溃恢复增强。二期先用原生 SessionManager JSONL；遇恢复痛点再上（15 个协议工具多为幂等台账操作，适合标 `replay:"safe"`）。
4. **billion-context**：主脑数周不换会话时的压缩升级项。注意 MIT+署名附加条款（闭源商用需评估）与 Early 状态；先靠原生 compaction。
5. **记忆：gentle-engram vs 服务器侧方案**——推荐**服务器侧**：加一对 remember/recall MCP 工具让主脑读写，多主脑/worker 共享、事件台账为唯一事实源；engram 作为 Pi 本地兜底备选。

## 四、MCP client 能力查证（文档级证据）

来源 pi.dev/docs/latest/mcp：支持 stdio 与 **streamable HTTP**（`url`+`headers`+`oauth`；不支持 legacy SSE——与我们 /mcp 完全匹配）；headers 支持 `${ENV}` 插值与 `!command`；工具注册为 `mcp__<server>__<tool>`，`exposure` 四档（codemode 默认/deferred/direct/hidden）；超时 60s、408/429/5xx 自动重试、>20KB 截断落盘；SDK 用 `createMcpExtension()` + `session.bindExtensions()`（官方示例 examples/sdk/14-codemode-mcp.ts）。

**唯一要写的代码不是"接 MCP"，而是 allowlist 门控扩展。**
