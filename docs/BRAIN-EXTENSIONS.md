# 主脑运行时定制指南（BRAIN-EXTENSIONS）

面向运维/用户：如何让内置主脑（T14）"拥有"你在使用过程中装的插件、技能与自定义工具。
核心承诺一句话——**全部定制物都放在数据卷，容器重建、Pi 运行时升级/回滚都不会丢；
装完不打断当前轮，主脑下个会话自动生效。**

> 查证口径：本文所有 SDK 行为均以仓库实际安装的 `@earendil-works/pi-coding-agent`
> 1.4.0 的类型定义与实现为准（`node_modules/@earendil-works/pi-coding-agent/dist/...`），
> 不凭记忆、不以调研报告（`docs/research/pi-plugins.md`）为准。相关实现落点：
> `apps/server/src/pi-runtime.ts`（挂载点）与 `apps/server/src/brain.ts`（会话创建传参）。

## 一、三种定制形态

| 形态 | 是什么 | 放哪里 | 对主脑意味着什么 |
|---|---|---|---|
| 社区插件（extension） | 导出默认工厂函数 `(pi: ExtensionAPI) => void` 的 TS/JS 模块，可注册工具/命令、监听生命周期事件、接 MCP 服务器等 | `<数据卷>/pi-runtime/extensions/` 下**每个子目录一个插件**（目录含 `index.ts`/`index.js` 或带 `pi` 字段的 `package.json`） | 随会话加载进主脑进程；`noTools:'builtin'` 只关内置工具，插件注册的工具照常生效 |
| 自定义工具扩展 | 上面的一种特例：只做 `pi.registerTool()` 的最小插件 | 同上 | 给主脑加一个窄接口的自定义工具（模板见 `examples/brain-extension/`） |
| 技能（skill） | **纯提示词/上下文资源，不是可执行代码**：含 frontmatter 的 `SKILL.md` | `<数据卷>/pi-runtime/skills/`（Pi 递归扫描，目录含 `SKILL.md` 即技能根，可多层嵌套） | 挂载进会话资源加载器；对主脑的实际呈现见下文"技能的如实说明" |

**技能挂载的查证结论**：Pi SDK 嵌入模式原生支持——`DefaultResourceLoaderOptions.additionalSkillPaths?: string[]`
（`dist/core/resource-loader.d.ts`），目录路径由 `loadSkills` 处理：是目录就递归扫描找
`SKILL.md`，是单个 `.md` 文件也能直接当技能（`dist/core/skills.d.ts`）。AsterHive 已把
`<数据卷>/pi-runtime/skills/` 整目录作为唯一一条 `additionalSkillPaths` 传入（`brain.ts`），
服务器启动时自动建好该目录（`PiRuntimeManager.ensureMountDirs()`），空目录 = 零技能、无害。

**技能的如实说明**（重要，不夸大）：

1. 主脑系统提示词是自定义的（`brain.ts` 的 `BRAIN_SYSTEM_PROMPT`），且主脑**没有 read/bash
   读文件工具**（`noTools:'builtin'` 关闭全部内置工具）。Pi 默认系统提示词里的 `<skills>`
   技能清单段，只在会话声明了 read/bash 这类读文件工具时才渲染（`dist/core/system-prompt.js`
   的 `skillFileReadTool` 解析逻辑）——所以**技能清单不会出现在主脑的系统提示词里**，
   模型不会"看到"技能列表。这是有意的：主脑没有执行面，不该被提示去读文件。
2. 挂载仍然真实生效：技能进得了资源加载器（`loader.getSkills()`，自定义扩展可读），
   且 `session.prompt()` 默认会把**轮首**的 `/skill:<名>` 展开成技能全文注入该轮
   （`dist/core/agent-session.js` 的 `_expandSkillCommand`，由 Pi 进程读文件，与工具面无关）。
   这为将来 UI 触发的定向调用（T17）与直接程序化调用预留了通路。
3. 结论：今天主脑侧技能 = "已挂载、可被扩展消费、可被轮首调用"；若你要给主脑注入一段
   常驻指令，当前的坦途是**自定义工具扩展或系统提示词**，而不是指望模型自己找技能。

## 二、持久性保证

数据卷（容器部署 `ASTERHIVE_DATA=/data`）是唯一事实源，镜像与仓库都不含任何定制物：

- `extensions/`、`skills/` 在**数据卷**——容器重建、换镜像、Pi 运行时升级到任意版本或
  一键回滚（`versions/` 台账切换指针，不触碰这两个目录），定制物原样保留；
- 主脑会话创建时每次都从这两个目录现读（`brain.ts` 的 `communityExtensionPaths()` 与
  `additionalSkillPaths`），不存在"装进某个 Pi 版本里"的耦合——回滚 Pi 不会连带丢插件；
- 服务器进程启动即确保两个目录存在（`ensureMountDirs()`），随时可放东西。

## 三、生效时机：下个主脑会话，有意不打断当前轮

主脑常驻一个 Pi 会话；扩展/技能/运行时版本都是在**会话创建时**装配的。因此：

- 放入/删除定制物后，**正在跑的这一轮不受影响**——不会半轮换工具面、不会中途重载代码；
- 下一轮唤醒时若会话仍在复用（指纹未变），定制物也**不会**热生效——等会话因
  模型/端点/运行时变更而重建，或服务器重启后才装载；
- 想立即生效：改一下主脑设置里的模型或更新运行时（触发会话重建），或重启服务器进程。
  这是刻意的安全设计：定制物装载是一个原子、可审计的时点，不存在"半路多出执行面"的窗口。

`GET /settings/runtime` 会返回 `extensionsDir` 与 `skillsDir` 两个绝对路径，UI 据此展示挂载点。

## 四、数据卷目录一览

```
<数据卷>/pi-runtime/              Pi 运行时与定制物根（服务器自管理，不进镜像）
  versions/<ver>/node_modules/…   已安装的 Pi 版本（更新/回滚保留历史）
  current/version.json            当前版本指针（原子切换；也可为符号链接）
  installs.json                   安装台账 [{"version","installedAt"}]
  extensions/                     社区插件挂载点：每个子目录 = 一个 Pi 扩展路径
  skills/                         技能挂载点：整目录递归扫描 SKILL.md
<数据卷>/brain-session/           主脑会话数据（与定制物无关，但也全在数据卷）
  workspace/                      主脑 cwd（主脑不碰文件系统，仅为 SDK 发现路径）
  sessions/                       SessionManager JSONL 会话树（崩溃后 continueRecent 续接）
  agent/                          专用 agentDir（auth.json 等，与用户 ~/.pi 完全隔离）
```

## 五、自定义工具开发三步

完整模板与签名依据：**`examples/brain-extension/`**（`index.ts` 约 70 行 + README）。

1. **拷模板**：`cp -r examples/brain-extension <数据卷>/pi-runtime/extensions/example-note`；
2. **改三处**（对照模板）：工具名（`asterhive_` 前缀 + 直白语义）→ 参数 schema
   （TypeBox，每个参数写清 description）→ 实现（`execute` 返回
   `{ content: [{type:'text',text}], details }`，失败回 `isError: true` 不抛异常）；
3. **验证**：让主脑调用一次（看工具是否被声明/调用），或直接看副作用文件。
   免编译：jiti 直接加载 TS 源码，保存即成。

签名核对口径（类型定义为准）：工厂 `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`
（`dist/core/extensions/types.d.ts`）；加载器取 default 导出且必须是函数（`loader.js`
`loadExtensionModule`）；目录入口规则 `resolveExtensionEntries`（`index.ts`/`index.js`/
package.json pi 字段）。

## 六、安全原则

1. **自定义工具 = 显式授权**。放进 `extensions/` 的每个扩展都以服务器进程权限运行，
   其注册的工具对模型全程可见。来源不明的扩展不要放。
2. **窄接口，拒绝通通道**。不要给主脑注册 shell、任意路径文件读写这类通用执行面工具——
   主脑的结构性约束是**只分派不执行**（拆卡/派活/验收全走 15 个 `asterhive_*` 协议工具，
   领域层对主脑禁用 claim/next 等执行动词）。给它 shell 等于拆掉这条硬约束。
   模板示例只允许写单一文件，就是这个原则的示范。
3. **提示词与工具面的一致性由扩展作者负责**。主脑系统提示词写明"只有 15 个协议工具"，
   装了带工具的扩展后工具声明会实打实多出（模型能调用），提示词文本不会自动改。
4. 技能是纯 Markdown，天然无执行面——给主脑"教方法"优先用技能/提示词，"给能力"才用
   扩展，且每给一个能力都要过第 2 条。

## 七、与 T17（界面化管理）的关系

现在的形态是**手动放目录**：`GET /settings/runtime` 给出两个挂载点路径，运维直接操作
文件系统。T17（路线图"主脑插件/技能界面化管理"，公开化前置）将在设置页提供
"主脑扩展"卡片：列表/启停/删除、上传 zip 或填 npm 包名由服务器代装（装入数据卷）、
技能目录管理。届时挂载点与生效时机语义不变（仍在数据卷、仍下会话生效），只是把
"放目录"换成界面操作——本文的目录契约就是 T17 的实现契约。
