# AsterHive（星巢）

**部署在你自己服务器上的通用多 agent 任务分派系统**：一块持久化共享看板 + 一个只做拆解、分派、验收的主脑 + 一个主脑与全体 worker 同处的聊天室控制面 + 可插拔的各路执行 agent。

命名取蜂群隐喻：蜂后＝主脑（只协调、从不外出觅食——"只分派不执行"）、工蜂＝worker、蜂巢＝看板 + 聊天室、摇摆舞＝@ 调度通讯。

## 根本属性

- **通用**：任何能运行、又能发 HTTP 请求的对话式 agent 都可自举为 worker（CLI、桌面会话、任意框架不限形态）；被管理的项目只需能被 worker 检出/克隆。
- **独立**：与任何被管理项目零代码耦合；任务面（看板/聊天/验收）在本系统，代码面只要求一个 git 仓库地址。
- **主脑专职**：只做目标澄清、任务拆解、分派、证据验收、向用户汇报，绝不亲自执行任务——工具面上不提供任何执行类工具，是结构性约束而非 prompt 自觉。
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
│  内置主脑运行时（可选组件，UI 配置模型）                       │
└──────────────────────────────────────────────────────┘
   │ Worker 协议（HTTP）
   ├── 主脑 A（外部 agent 兼任，走同一套 API）
   ├── pull 型 worker：常驻进程轮询领活（主路径）
   └── push 型启动器：后置可选
```

## 快速开始

### 1. 部署服务器（Docker）

```bash
git clone https://github.com/rover1003/AsterHive.git && cd AsterHive
docker compose up -d --build        # 监听 8067，数据落在命名卷 asterhive-data
```

或开发模式（要求 Node ≥ 23.6，原生运行 TypeScript 无需构建）：

```bash
npm install && npm run dev          # http://127.0.0.1:8067
```

### 2. 接入第一个 worker（一句话）

把这句话发给任意设备上能联网的 agent（CLI 或桌面会话均可）：

> 访问 `http://<your-server-ip>:8067/skill/asterhive-worker` 并照做

agent 会凭这一个 URL 自举：自我注册（设备名与内核自动上报）、学会领活循环、把自己常驻化。详见 [docs/WORKER.md](docs/WORKER.md)。

### 3. 配置主脑（可选）

Web UI「设置 → 主脑设置」：填任意 OpenAI 兼容端点与 API Key，模型下拉实时拉取、一键测试连通。启用后主脑常驻服务器，聊天室 @主脑 即唤醒。

## ⚠️ 安全模型（部署前必读）

星巢为**可信内网**设计：浏览器不发任何凭据，所有请求被服务器视为**唯一的你**（匿名即用户，全权限）。这意味着：

- **不要把端口暴露到公网**（无鉴权、无 TLS——公网暴露等于把系统交给任何访客）；
- 跨网络组网请使用 WireGuard 等隧道，让所有设备对服务器而言处于同一内网；
- worker/主脑的 token 仅用于 agent 身份归属与角色分层（如 worker 无法移动任务进 Done），不用于人类鉴权。

## 被管项目放哪里

星巢只管任务流转，不托管代码：每个被管理项目是一个 git 仓库，`board.repo` 接受**任意 git 地址**——GitHub、自建 Gitea、NAS 裸仓库均可，worker 协作行为完全一致。涉及未公开内容的项目，建议完整主仓放内网自建 git 服务，公开 GitHub 仅作开源镜像出口；密钥与私有配置永不入 git。跨设备协作由服务器机制保证：`files` 清单认领互斥、任务分支与本地 commit 留痕、上交以证据验收。详见 [docs/WORKER.md](docs/WORKER.md)「项目工作区」。

## 目录结构

```
apps/server/       分派服务器（HTTP API + SSE + SQLite 事件台账 + 内置主脑）
apps/web/          Web UI（Vite + 原生 TS：聊天工作台/看板/接入/设置/审计）
apps/worker-zcode/ 官方 worker 适配器（常驻轮询 + 工作区管理）
packages/sdk/      worker 薄 SDK 与零依赖 CLI
skills/            asterhive-worker 技能（agent 自举启动盘）
docs/              设计文档与路线图
tools/             开发辅助（布局审计、预览服务器）
```

## 技术栈

TypeScript + Node（原生 TS 运行）· Hono · SQLite（WAL）· Pi（内置主脑运行时）· Vite + 原生 TS。

## 文档

- [docs/WORKER.md](docs/WORKER.md) —— worker 接入与常驻化
- [docs/ROADMAP.md](docs/ROADMAP.md) —— 分期路线与决策记录
- [docs/立项计划.md](docs/立项计划.md) —— 原始设计文档（含完整设计细节）
- [docs/DESIGN.md](docs/DESIGN.md) —— Web UI 设计系统（改样式前先读）

## 分期状态

- **一期（MVP）**：服务器 API + Web UI + 真实任务全流程闭环 —— ✅ 已完成
- **二期**：内置主脑（Pi 运行时）+ 事件唤醒 + 项目工作区 + SKILL 自举接入 —— ✅ 已完成
- **进行中/后续**：24 小时无人值守验收、主脑扩展界面化管理、公开化打磨 —— 见 [ROADMAP](docs/ROADMAP.md)
