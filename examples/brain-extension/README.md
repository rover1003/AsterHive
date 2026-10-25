# 主脑自定义工具扩展示例：example-note

给星巢内置主脑（Pi 运行时）写自定义工具的最小可用模板。安装后主脑获得一个新工具
`asterhive_example_note`：把一条笔记追加写入数据卷的 `brain-notes.jsonl`，跨会话留痕。

> 定制形态全景与持久性保证见 `docs/BRAIN-EXTENSIONS.md`；本 README 只讲这一个模板。

## 这是什么

- 一个 Pi 扩展：TypeScript 单文件 `index.ts`，导出默认工厂函数
  `(pi: ExtensionAPI) => void`，内部用 `pi.registerTool()` 注册一个工具。
- 运行位置：**AsterHive 服务器进程内**（主脑会话创建时由 Pi 的 jiti 加载器直接加载，
  免编译）。所以它能 `import node:fs` 直接碰数据卷，但也因此必须自觉守住安全边界（见下）。
- 数据卷位置通过环境变量 `ASTERHIVE_DATA` 获取（容器部署固定 `/data`，见 `compose.yaml`；
  服务器进程的同一环境变量见 `apps/server/src/main.ts`）。取不到时工具显式报错，不猜路径。

**签名依据**（以 `@earendil-works/pi-coding-agent` 1.4.0 安装包类型定义为准）：

| 事实 | 出处 |
|---|---|
| 工厂签名 `(pi: ExtensionAPI) => void \| Promise<void>` | `dist/core/extensions/types.d.ts` 的 `ExtensionFactory` |
| 加载器取 default 导出且必须是函数 | `dist/core/extensions/loader.js` `loadExtensionModule()`（`jiti.import(path, { default: true })`） |
| 目录即扩展路径（`index.ts`/`index.js`/带 `pi` 字段的 package.json） | 同上文件 `resolveExtensionEntries()` |
| 工具注册 `pi.registerTool(tool: ToolDefinition)`，参数 schema 用 TypeBox | `types.d.ts` `ExtensionAPI.registerTool`、`ToolDefinition.parameters` |
| `execute(toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>`，结果 `{ content, details, isError? }` | `types.d.ts` `ToolDefinition.execute` + `@earendil-works/pi-agent-core` `dist/types.d.ts` `AgentToolResult` |
| 扩展内可 `import` 的模块：`typebox`、`@earendil-works/pi-coding-agent`（jiti 别名）+ `node:` 内置模块 | `loader.js` `getAliases()` |

## 怎么装

```bash
# 1. 把整个目录拷进数据卷的插件挂载点（目录名随意，这里叫 example-note）
#    容器内数据卷是 /data；Windows 直跑则是 <ASTERHIVE_DATA>/pi-runtime/extensions/
cp -r examples/brain-extension  <数据卷>/pi-runtime/extensions/example-note

# 2. 完成。不用重启服务器进程：主脑下个会话自动加载。
#    主脑当前会话若在跑，本轮不受影响（有意设计，见 BRAIN-EXTENSIONS.md"生效时机"）。
```

验证装好了：给主脑发一条消息让它"记一条笔记：xxx"，观察它调用 `asterhive_example_note`；
或直接看数据卷 `brain-notes.jsonl` 是否出现记录。卸载 = 删掉 `example-note/` 目录，同样下个会话生效。

## 怎么改写成你自己的工具

只动三处（对照 `index.ts`）：

1. **工具名**（`tool.name`）：建议保留 `asterhive_` 前缀避免与 Pi 内置/社区工具撞名；
   名字是模型调用的唯一入口，语义要直白。
2. **参数 schema**（`params`）：TypeBox 的 `Type.Object({ ... })`，每个参数写清
   `description`——这就是模型的工具契约，模型照它填参；校验也照它做（Pi 会先按 schema
   校验再进 `execute`）。
3. **实现**（`execute`）：同步/异步皆可，返回 `{ content: [{ type: 'text', text }], details: {} }`；
   失败不抛异常，返回 `isError: true` 的结果把原因告诉模型。

改完无需任何构建步骤，保存即可——jiti 直接加载 TS 源码。

## 安全注意（务必读）

- **自定义工具 = 显式授权**：放进 `extensions/` 的每个扩展都会随主脑会话加载，其注册的
  工具对模型全程可见可调。你放进去什么，主脑就"能"什么。
- **不要注册 shell / 文件系统通通道类工具**（如 `run_command`、`read_any_file`、
  `write_any_file`）。主脑的结构性约束是**只分派不执行**——拆卡、派活、验收都通过
  `asterhive_*` 协议工具走服务器领域层；给它开通用执行面等于把这条约束拆了。
- 正确姿势是**窄接口**：像本示例一样，一个工具只碰一个固定文件/一个固定端点，参数有
  上限校验，错误显式回报。本示例只允许写 `brain-notes.jsonl` 这一个文件，就是这个
  原则的示范。
- 扩展代码以服务器进程权限运行：它写的每个文件、发的每个请求都发生在你的服务器上。
  来源不明的扩展不要放进 `extensions/`。
- 已知边界：主脑的系统提示词（`apps/server/src/brain.ts` 的 `BRAIN_SYSTEM_PROMPT`）
  写明"可用的工具只有 15 个 asterhive_* 协议工具"。装了扩展后工具声明会实打实多出来
  （模型能调用），但提示词文本不会自动改——写完自己的工具后，提示词与工具面的一致性
  由你负责（后续 T17 界面化管理会收口这一点）。
