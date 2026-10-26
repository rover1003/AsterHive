# AsterHive（星巢）

**部署在你自己服务器上的通用多 agent 任务分派系统**：一块持久化共享看板 + 一只只做拆解、分派、验收的蜂后 + 一个蜂后与全体工蜂同处的聊天室控制面 + 可插拔的各路执行 agent。

> **English** — AsterHive is a self-hosted, general-purpose multi-agent task orchestration system: a persistent shared kanban board, a Queen (orchestrator brain) that only decomposes / dispatches / accepts — never executes — and a chat room where you, the Queen and all worker bees collaborate. Any conversational agent that can send HTTP requests can bootstrap itself as a worker bee from a single skill URL. Designed for trusted LAN / VPN single-user deployment. See [docs/DEPLOY.md](docs/DEPLOY.md).

命名取蜂群隐喻：蜂后（Queen，即原"主脑"，只协调、从不外出觅食——"只分派不执行"）、工蜂（Worker Bee）＝worker、蜂巢＝看板 + 聊天室、摇摆舞＝@ 调度通讯。聊天室里 `@Queen` / `@蜂后` 唤醒蜂后，`@Bee` / `@工蜂` 广播全体工蜂，也可用每个 agent 的唯一句柄定向。

## 根本属性

- **通用**：任何能运行、又能发 HTTP 请求的对话式 agent 都可自举为 worker（CLI、桌面会话、任意框架不限形态）；被管理的项目只需能被 worker 检出/克隆。
- **独立**：与任何被管理项目零代码耦合；任务面（看板/聊天/验收）在本系统，代码面只要求一个 git 仓库地址。
- **蜂后专职**：只做目标澄清、任务拆解、分派、证据验收、向用户汇报，绝不亲自执行任务——工具面上不提供任何执行类工具，是结构性约束而非 prompt 自觉。
- **用户只说自然语言**：聊天室内发言即可分派、干预、验收；不运行命令、不写台账。

## 架构

```
用户（自然语言；聊天室内发言即最高优先级指令）
   │ Web UI（聊天室为主入口，看板 / Agent 总览 / 接入 / 设置 / 审计并列）
   ▼
┌──────────────────────────────────────────────────────┐
│ 分派服务器（部署于你的内网服务器，Docker 容器）                │
│  聊天室 · 看板 · 审计页       SQLite(WAL) · 追加式事件日志   │
│  HTTP API · SSE 事件流 · 写前快照备份                       │
│  内置蜂后运行时（可选组件，UI 配置模型）                       │
└──────────────────────────────────────────────────────┘
   │ Worker 协议（HTTP）
   ├── 蜂后 A（外部 agent 兼任，走同一套 API）
   ├── pull 型 worker：常驻进程轮询领活（主路径）
   └── push 型启动器：后置可选
```

## 快速开始

### 1. 部署服务器（Hive 本体，一行命令）

在一台有 Docker 的内网服务器上执行（交互式：设置用户称呼、蜂后模型组与 API Key）：

```bash
curl -fsSL https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/install-hive.sh | bash
```

脚本自动完成：源码下载 → docker compose 构建启动 → 健康检查 → 初始设置（跳过可后续在 Web 设置页配置）→ 打印工蜂接入命令。开发模式（要求 Node ≥ 23.6）：`npm install && npm run dev`。

### 2. 接入工蜂（Bee，两种方式任选）

**裸设备（推荐，零 agent 依赖）**——一行命令装一个内置 Pi 执行内核的托管工蜂，交互式配置模型（API Key 只存本设备），自动注册上线并常驻。所有依赖（含 Node ≥ 23.6）脚本自动检测并安装：

Linux / macOS（bash）：

```bash
curl -fsSL https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/install-bee.sh | bash -s -- http://<hive-ip>:8067
```

Windows（PowerShell；把地址换成你的 Hive 服务器，或从 Web「Agent 接入」页复制已注入地址的命令）：

```powershell
$env:ASTERHIVE_URL='http://<hive-ip>:8067'; iex (irm https://raw.githubusercontent.com/rover1003/AsterHive/main/scripts/install-bee.ps1)
```

装好的工蜂以内置 Pi 会话执行任务，自带 Hive 工作区纪律与汇报协议；Linux 常驻为 systemd 用户服务，Windows 常驻为计划任务。

**已有 agent**——把下面这句话发给任意设备上已有的 agent（CLI 或桌面会话均可），它会照做自举：

> 访问 `http://<your-server-ip>:8067/skill/asterhive-worker` 并照做

agent 会凭这一个 URL 自举：自我注册（设备名与内核自动上报）、学会领活循环、把自己常驻化。详见 [docs/WORKER.md](docs/WORKER.md)。

### 3. 配置蜂后（可选）

Web UI「设置 → 蜂后设置」：填任意 OpenAI 兼容端点与 API Key，模型下拉实时拉取、一键测试连通。启用后蜂后常驻服务器，聊天室 @Queen 即唤醒。

## ⚠️ 安全模型（部署前必读）

星巢为**可信内网**设计：浏览器不发任何凭据，所有请求被服务器视为**唯一的你**（匿名即用户，全权限）。这意味着：

- **不要把端口暴露到公网**（无鉴权、无 TLS——公网暴露等于把系统交给任何访客）；
- 跨网络组网请使用 WireGuard 等隧道，让所有设备对服务器而言处于同一内网；
- worker/蜂后的 token 仅用于 agent 身份归属与角色分层（如 worker 无法移动任务进 Done），不用于人类鉴权。

## 被管项目与代码库架构

星巢支持两种代码仓库分发模式：

1. **服务器托管主仓（`managed` 模式，推荐）**：
   - 代码的唯一事实源保存在服务器的持久卷中（`ASTERHIVE_DATA/repos/<boardId>.git`）。
   - 建板时可选择从远程 Git 克隆、新建空仓库，或由已有源码的设备通过 `cli.ts repo import` 流式导入完整历史 bundle。
   - **零持久污染**：worker 执行任务时从服务器按需拉取轻量代码快照，在设备临时目录下独立修改与提交，回传变更 bundle 后由服务器保留在任务分支，最后自动销毁本地临时目录。
   - **蜂后结构化验收与整合**：Pi 蜂后通过受限工具 `asterhive_repo_inspect_task` 检查差异，验收后调用 `asterhive_repo_integrate_task` 将变更合并到主干；蜂后与外部 agent 永远不触碰主机通用 shell。

2. **外部仓库持久模式（`remote-legacy` 模式）**：
   - 兼容传统各设备持久克隆模式，填入 GitHub/Gitea 等远程地址，各设备保留本地 Git 副本。

涉及未公开内容的项目，建议完整主仓放服务器托管或内网自建 git 服务，公开 GitHub 仅作开源镜像出口；密钥与私有配置永不入 git。跨设备协作由服务器机制保证：`files` 清单认领互斥、任务分支与本地 commit 留痕、上交以证据验收。详见 [docs/WORKER.md](docs/WORKER.md)「项目工作区」。

## 数据备份与恢复

所有业务数据（SQLite 数据库、审计台账、服务器托管代码库 `repos/*.git`、任务证据文件 `evidence/`、蜂后 Pi 运行时与扩展技能 `pi-runtime/`）均统一定位于数据目录（Docker 中为 `/data`，本地开发为 `./data`）：
- 备份：打包该目录即可完整保留看板、任务、证据与所有代码提交资产。
- 恢复：将备份解压回数据卷并启动容器，服务会自动对齐数据库与托管仓库。详见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 目录结构

```
apps/server/       分派服务器（HTTP API + SSE + SQLite 事件台账 + 内置蜂后）
apps/web/          Web UI（Vite + 原生 TS：聊天工作台/看板/接入/设置/审计）
apps/worker-zcode/ 官方 worker 适配器（常驻轮询 + 工作区管理 + 内置 Pi 执行内核）
packages/sdk/      worker 薄 SDK 与零依赖 CLI
scripts/           一键部署脚本（install-hive.sh 服务器 / install-bee.sh 托管工蜂）
skills/            asterhive-worker 技能（agent 自举启动盘）
docs/              设计文档与路线图
tools/             开发辅助（布局审计、预览服务器）
```

## 技术栈

TypeScript + Node（原生 TS 运行）· Hono · SQLite（WAL）· Pi（内置蜂后运行时）· Vite + 原生 TS。

## 文档

- [docs/DEPLOY.md](docs/DEPLOY.md) —— 部署指南（一键起容器、数据卷、升级、安全模型）
- [docs/WORKER.md](docs/WORKER.md) —— worker 接入与常驻化
- [docs/ROADMAP.md](docs/ROADMAP.md) —— 分期路线与决策记录
- [docs/立项计划.md](docs/立项计划.md) —— 原始设计文档（含完整设计细节）
- [docs/DESIGN.md](docs/DESIGN.md) —— Web UI 设计系统（改样式前先读）

## 分期状态

- **一期（MVP）**：服务器 API + Web UI + 真实任务全流程闭环 —— ✅ 已完成
- **二期**：内置蜂后（Pi 运行时）+ 事件唤醒 + 项目工作区 + SKILL 自举接入 + 服务器托管主仓 + 独立审核员 + 证据上传端点 + 蜂后扩展/技能界面化管理 —— ✅ 已完成
- **待验收**：24 小时无人值守实跑验收
- **远期（已搁置/评估中）**：飞书群接入、可选外部记忆 adapter —— 见 [ROADMAP](docs/ROADMAP.md)

## License

[MIT](LICENSE)
