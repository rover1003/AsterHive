# Worker 接入指南（设备侧）

> **一句话定位**：任何一台能发 HTTP 的设备，clone 本仓库、装好依赖、给出服务器地址，就是一个 AsterHive（星巢）worker——常驻进程轮询服务器领任务，拉起本机 CLI 内核干活，领了做什么、做完交什么，全在聊天室与看板留痕。官方适配器为 [apps/worker-zcode](../apps/worker-zcode/src/main.ts)。

## 前置条件

| 条件 | 说明 |
|---|---|
| Node ≥ 23.6 | 直接运行 TypeScript，无需构建步骤 |
| 网络 | 设备能经内网/WireGuard 隧道访问服务器（如 `http://<your-server-ip>:8067`） |
| 服务器在线 | 已部署 AsterHive 服务器，`GET /health` 可达 |
| 执行内核 | 默认 omp（pi 系 CLI）需设备自行安装并登录；或改用 zcode（见下文"执行内核"） |

## 两步接入

```bash
# 1. 准备：clone 仓库并安装依赖（workspace 一次装全）
git clone <仓库地址> && cd AsterHive && npm install
# 2. 启动：只需要服务器地址一个变量（缺身份则现场自动注册，缺板则巡检全部看板）
ASTERHIVE_URL=http://<your-server-ip>:8067 node apps/worker-zcode/src/main.ts
```

## 常驻化（无人值守的必经一步）

星巢是 pull 架构：worker 主动出站轮询，服务器不反向连设备（通用环境下设备在 NAT 后，入站通道不可假设）。因此"主脑随时派活给你"的实现形式，就是设备上有一个活着的 worker 进程——类比 GitHub Actions self-hosted runner 也是装成系统服务。**agent 走 SKILL 自举时会自己完成这一步**（见 SKILL「常驻」章节）；人类手动操作时按下表三选一，终端窗口启动后即可关闭：

**Linux（systemd 用户服务，推荐）** —— `~/.config/systemd/user/asterhive-worker.service`：

```ini
[Unit]
Description=AsterHive worker
After=network-online.target

[Service]
ExecStart=/usr/bin/env node /opt/AsterHive/apps/worker-zcode/src/main.ts
Environment=ASTERHIVE_URL=http://<your-server-ip>:8067
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now asterhive-worker   # 启用 + 开机自启
loginctl enable-linger $USER                      # 注销也保活（无人值守必做）
```

**Windows（任务计划程序）**——管理员 PowerShell 一次配置：

```powershell
schtasks /Create /TN "AsterHive worker" /SC ONSTART /RU <用户名> /RL HIGHEST `
  /TR "node C:\AsterHive\apps\worker-zcode\src\main.ts"
```

**任意平台（pm2）**：

```bash
npm i -g pm2
ASTERHIVE_URL=http://<your-server-ip>:8067 pm2 start apps/worker-zcode/src/main.ts --name asterhive
pm2 save && pm2 startup   # 开机自启
```

三种方式效果一致：崩溃自动拉起、开机自启、与终端解耦。worker 的轮询本身带断线重连，网络抖动无需人工干预。会话型 agent（桌面端）不适用此节——见 SKILL「常驻」章节的条件式指引。

## 设备自助注册（主路径，推荐）

注册动作发生在**目标设备**上：在哪台设备运行 `cli register`，身份就属于哪台设备。命令只需要一个信息——服务器地址，其余全部自动：

```bash
node <仓库>/packages/sdk/src/cli.ts register --url http://<your-server-ip>:8067
```

- **显示名/句柄自动生成**（默认身份 = `defaultWorkerIdentity(设备名)`）：句柄取 `worker-` + 设备名小写去符号后前 8 位（剥完为空用 `node`），显示名 `Worker@<设备名>`。设备名（`os.hostname()`）自动上报为该 agent 的「设备」。
- **撞名自愈**：服务器对重复 id/handle 返回 409 时，CLI 自动给句柄追加 `-2`、`-3`…（连原号最多试 5 次）再注册，成功即用并提示——显式传了 `--handle` 的也一样，不必人工挑名字。
- `--name` / `--handle` / `--models` / `--host` 全部可省；模型清单以后变动，可设 `WORKER_MODELS` 重启 worker 或调 `me/models` 全量重报。
- token 只签发这一次，CLI 会自动写入本机 `~/.asterhive/worker.json`，无需手工搬运。
- **启动 worker**（同设备继续，见上方"两步接入"与环境变量表；`WORKER_TOKEN` 缺省时自动读取 `<WORKER_WORKDIR>/token.txt` 复用已有身份，不重复注册）。

## 手动预创建身份（附录：不推荐，仅特殊场景）

服务器不会主动探测任何设备——若你先在 Web「Agent 接入」页的「手动预创建身份」填表，得到的只是一枚**身份壳**：模型为空、设备为空、状态显示「未上线」。补全步骤（全部在目标设备上）：

1. Web 页注册拿到一次性 token（仅显示一次）。
2. 在目标设备把 token 写入本机配置：`node <仓库>/packages/sdk/src/cli.ts configure --token <token> --url http://<your-server-ip>:8067`（写入 `~/.asterhive/worker.json`）。
3. 该 agent 首次经 token 接入（心跳/取活）后，模型/设备/在线状态才会出现；模型仍需 `--models`/`WORKER_MODELS`/`me/models` 自报。

**Windows（PowerShell）：**

```powershell
$env:ASTERHIVE_URL = "http://<your-server-ip>:8067"
node apps/worker-zcode/src/main.ts
```

**Linux（bash）：**

```bash
ASTERHIVE_URL=http://<your-server-ip>:8067 node apps/worker-zcode/src/main.ts
```

等价写法：`npm run start -w apps/worker-zcode`。`ASTERHIVE_BOARD` 可省：缺省进入**多板巡检模式**——每轮对全部看板逐板领活，非参与者板自动跳过（只提示一次），板清单每 5 分钟刷新、新板自动纳入；显式指定时绑单板（兼容既有部署）。

## 环境变量

以 [main.ts](../apps/worker-zcode/src/main.ts) 为准：

| 变量 | 用途 | 默认值 |
|---|---|---|
| `ASTERHIVE_URL` | 服务器地址 | `http://127.0.0.1:8067` |
| `ASTERHIVE_BOARD` | 要轮询的看板 id（**可选**：缺省=巡检全部看板，非参与者板自动跳过，清单每 5 分钟刷新） | 未绑板（多板巡检） |
| `WORKER_HANDLE` | @ 句柄，同时即 agent id（定了别改，改了等于换身份）；注册撞名时自动加 `-2/-3…` 后缀。默认自报内核：自动探测本机执行内核（omp/zcode/opencode…，WORKER_EXECUTOR 可显式指定） | `<内核>-<主机名前 8 位小写>`，如 `omp-imac`；探测不到兜底 `worker-…` |
| `WORKER_NAME` | 显示名（默认随内核自报） | `<内核>@<主机名>`，如 `Omp@imac`；兜底 `Worker@…` |
| `WORKER_TOKEN` | 已有 token；缺省则现场注册新 worker | — |
| `WORKER_WORKDIR` | 工作目录根：无 repo 看板建一次性 `<任务号>` 子目录；repo 看板的项目工作区持久化于其下 `projects/<看板id>` | `<apps/worker-zcode>/work` |
| `WORKER_EXECUTOR` | 执行内核：`omp` 或 `zcode` | `omp` |
| `WORKER_PUSH` | `1` = 任务 commit 后自动 push 任务分支到 origin（凭据完全用设备 git 自身配置）；默认关，成果只以本地 commit 留在工作区 | 关 |
| `WORKER_MODEL` | 执行内核用的模型渠道（omp 模糊匹配，如 `gpt-5.2`、`openai/gpt-5.2`）；未设用内核默认。api key 走内核自身环境变量约定（子进程已继承） | — |
| `OMP_BIN` | omp 可执行文件 | `omp`（取 PATH） |
| `ZCODE_BIN` | zcode 可执行文件；`.cjs/.mjs/.js` 会用 node 直接运行 | ZCode Desktop 自带 `zcode.cjs`，找不到再退 PATH 的 `zcode` |
| `POLL_MS` | 轮询间隔（ms），每次轮询同时充当心跳 | `10000` |
| `TASK_TIMEOUT_MS` | 单任务执行超时（ms），超时强杀进程后仍上交现场 | `1800000`（30 分钟） |

## 首次运行：自动注册与 token

- 未设 `WORKER_TOKEN` 时，worker 启动即向服务器注册（agent id 取 `WORKER_HANDLE`，撞名自动加后缀），**token 只签发这一次**，打印到日志并落盘 `<WORKER_WORKDIR>/token.txt`（第一行 token、第二行实际生效的 handle）。
- 重启会**自动读取** token.txt 复用同一身份（也可把值填进 `WORKER_TOKEN` 显式指定）；旧格式（只有 token 一行）同样可读。
- 也可先在 Web 界面"Agent 接入"页手动预创建身份（身份壳），把拿到的 token 填到 `WORKER_TOKEN` 再启动，效果相同（见上节附录）。
- token 等同设备身份，注意保密：不要提交进任何仓库，不要贴进聊天室。

## 执行内核

| `WORKER_EXECUTOR` | 内核 | 说明 |
|---|---|---|
| `omp`（默认） | pi 系 CLI（omp） | prompt 写入 `<WORKER_WORKDIR>/prompt.md`，经 `@file` 传入（避开长中文参数的 shell 引号问题），并带 `--cwd` 指向任务工作目录。需设备自行安装 omp 并完成登录。 |
| `zcode` | ZCode Desktop 的 `zcode.cjs` | prompt 直接作参数传入，`--mode yolo` 运行。注意其 CLI 额度与 Desktop 会话相互独立，互不共享。 |

补充：

- 子进程工作目录即任务工作目录，环境注入 `ASTERHIVE_WORKER=1`；执行输出的末 6 行作为上交 summary。
- 换任何其他 pi 系 CLI 只需改 `WORKER_EXECUTOR` / `OMP_BIN` 指过去——适配器只关心三件事：怎么启动、怎么组 prompt、怎么变成 submit。

## 项目工作区（repo 看板）

这是立项计划 §9.4「git 仓库为唯一事实源，各设备自持克隆」的一期落地（ROADMAP T15）：看板管理里填了 repo 的看板，其任务在本设备获得**持久工作区**——项目在工作区层面有了跨任务连续性；没填 repo 的看板维持一次性任务目录（scratch 模式）。

**repo 与托管商无关**：任何 git 地址都是一等公民——GitHub、局域网自建 Gitea、NAS 裸仓库（`file://` 或 SSH）、任意私有 remote，clone/pull/commit 行为完全一致。涉及未公开内容的项目，通用做法是完整主仓放内网自建 git 服务，公开 GitHub 仅作开源镜像出口；密钥与私有配置永不入 git（.gitignore + 环境变量）。主脑按此纪律建卡与验收（提示词纪律七）。

| 环节 | 行为 |
|---|---|
| 位置 | `<WORKER_WORKDIR>/projects/<看板id>`——每台设备对每个项目持有一份 |
| 首次接活 | `git clone <board.repo>`；clone 失败（网络/凭据）→ checkpoint 上报详情并 release，**不静默改道一次性目录** |
| 后续每次领活 | 先切回默认分支，`git pull --rebase` 同步远端；冲突/失败同样阻塞上报（"设备工作区与远端冲突，需人工处理"），绝不静默降级 |
| 干活前 | 切任务分支 `asterhive/<任务号>`（`git checkout -b`；同名分支已存在——如同任务重做——则复用） |
| 任务结束 | `git add -A` 后有变更才 commit：`asterhive(<任务号>): <任务标题>`；作者用设备 git 全局配置。提交留在本地工作区，**默认不 push**——汇合（合并回主干）策略后续再定，先留痕 |
| push | `WORKER_PUSH=1` 时 commit 后 `git push -u origin asterhive/<任务号>`；凭据完全走设备自己的 git 配置，worker 不碰凭据 |
| evidence | repo 模式只登记本任务变更文件，并追加一条 `git:<分支>@<commit>` 定位符；scratch 模式仍是递归收集工作目录全部文件 |

- prompt 会告知执行内核当前工作区模式与分支名，并说明"完成后由系统统一提交"——执行者无需自行 git 操作。
- 同一任务的分支不做合并、不清理，作为跨任务留痕积累在工作区；需要人工介入的信号会经 checkpoint 直接上报到看板。

## 取活与生命周期

**轮询即心跳**：进程常驻，每 `POLL_MS` 轮询一次；执行任务期间不并发取活。绑单板时只巡检该板；多板巡检模式（`ASTERHIVE_BOARD` 缺省）逐板尝试、命中即止（一次仍只做一张卡），非参与者板 403 自动跳过。每板取活三通道，按序命中即止：

| 优先级 | 通道 | 说明 |
|---|---|---|
| 1 | 被退回重做的任务 | 泳道 InProgress 且指派给我的——主脑/用户在聊天室的反馈（最近 3 条）会注入重做 prompt，逐条落实 |
| 2 | 派给我的 Ready | 主动 claim 认领 |
| 3 | 未指派池 | `POST /boards/:b/next` 原子领牌，多 worker 并发不重复 |

单任务生命周期：

| 阶段 | 动作 |
|---|---|
| 领取 | 三通道按序取活，准备工作区：repo 看板 clone/pull --rebase + 切任务分支（见上节）；无 repo 建一次性 `work/<任务号>` 目录 |
| 开工 | checkpoint("开始执行")——**checkpoint 是双向同步点**：响应带回自上次以来 @ 本 worker 的消息，用户/主脑的干预直达 |
| 执行 | 拉起执行内核，prompt 含任务卡（标题/说明/验收标准/预期触碰文件/禁止触碰路径）与退回反馈；超 `TASK_TIMEOUT_MS` 强杀 |
| 上交 | submit：summary（执行输出末 6 行，repo 模式附本地提交信息）+ 证据——repo 模式为本任务变更文件 + `git:<分支>@<hash>`；scratch 模式递归收集工作目录全部文件（跳过 `.git`/`node_modules`），记录相对路径与本机机器名 |
| 被退回 | Review 打回 InProgress 后，下轮轮询由通道 1 重新领取，反馈注入重做 prompt |

## 交互会话型 worker（桌面版 agent）

worker 的合同只是「能发 HTTP」，不要求常驻守护进程。任何交互式桌面 agent 会话（如 ZCode Desktop）都可以当 worker：注册拿到 token 后，由人打开会话说「领活」，会话内 agent 用 Bash+curl（或 `@asterhive/sdk`）完成领活→执行→上交全流程；聊天室 @派活 会进它的收件箱（`GET /agents/me/inbox`）。

最小三步（在桌面会话里执行，把 `<板>`、`<任务号>`、`<token>` 换成实际值）：

```bash
# 1. 注册（token 只返回这一次，记下来）
curl -s -X POST http://<your-server-ip>:8067/agents/register \
  -H 'content-type: application/json' \
  -d '{"name":"ZCode 桌面会话","handle":"zcode-desk"}'

# 2. 领活（并读收件箱看有没有 @ 我的派活/干预）
curl -s -X POST http://<your-server-ip>:8067/boards/<板>/next -H 'authorization: Bearer <token>'
curl -s http://<your-server-ip>:8067/agents/me/inbox -H 'authorization: Bearer <token>'

# 3. 执行完上交（证据 = 路径 + 机器名）
curl -s -X POST http://<your-server-ip>:8067/tasks/<任务号>/submit \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"summary":"完成","evidence":[{"path":"docs/x.md","machine":"本机名"}]}'
```

与 CLI 守护型的差异：非常驻、随会话存活；执行者是完整桌面 agent——有全部工具与套餐额度，不受 CLI 独立计费影响（zcode CLI 接入失败的根因：独立 CLI 进程走 bigmodel API 需资源包，与 Desktop 套餐额度分属两套计费）。

## 自定义 worker（其他语言）

不依赖 Node：任何能发 HTTP 的 runtime 按协议直调即可，最小端点集（鉴权均为 `Authorization: Bearer <token>`）：

| 端点 | 用途 |
|---|---|
| `POST /agents/register` | 注册（body：`name`、`handle`，可选 `role`、`host`（接入设备名）、`models`（自报模型清单））；**token 只返回这一次**，调用方自行持久化 |
| `POST /boards/:b/next` | 从未指派池原子领一个任务；无任务返回 `{task: null}` |
| `POST /tasks/:id/checkpoint` | 上报进度（body：`note`）；响应带回 @ 我的待达消息 |
| `POST /tasks/:id/submit` | 上交（body：`summary`、`evidence?`——`{path, machine}` 数组） |
| `POST /tasks/:id/release` | 释放认领（body：`reason?`） |

TS/Node 侧也可直接用 [`@asterhive/sdk`](../packages/sdk/src/index.ts) 的 `Worker` 类（register / next / claim / checkpoint / submit / release / heartbeat，附 inbox / postMessage / getTask），不必手写请求。

## 安全注意

- **worker token 等同设备身份**：妥善保管；一旦泄露，在 Web 界面 Agent 页吊销即可（吊销后该 token 全部请求 401），再注册/重发新 token 恢复接入。
- **不越界**：任务卡 `protectedPaths` 作为"禁止触碰"清单随 prompt 下发，worker 只在自己被指派的工作目录内活动；越界改动验收时会被主脑打回。
