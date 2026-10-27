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

## 激活已有托管工蜂

在安装过工蜂的目标设备打开终端，从「Agent 管理」复制对应系统的激活命令执行。脚本复用已有身份，不修改模型配置或任务工作区；激活后工蜂可能立即领取已指派的任务。

脚本会检查身份与服务状态；对可识别的旧版工蜂，仅修补凭据缺失或失效时自动重新注册的代码并保留备份。无法确认版本或身份时停止，不创建新身份。已运行的工蜂不会被脚本重启。若没有可用的系统服务，后台方式不保证重启后自动恢复。上线以新心跳与进程状态为准，日志中可能包含敏感信息，请勿直接公开。

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

服务器不会主动探测任何设备——若你先在 Web「Agent 管理」页的「手动预创建身份」填表，得到的只是一枚**身份壳**：模型为空、设备为空、状态显示「未上线」。补全步骤（全部在目标设备上）：

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
| `EXECUTOR_MODE` | `oneshot` = 每任务启动/退出一次（默认）；`rpc` = 显式启用 OMP 常驻 JSONL 会话（会改变会话持久性/费用行为，只适用于 omp） | `oneshot` |
| `WORKER_RPC_SESSION_DIR` | RPC 会话私有存储根（与项目仓库分离，含会话记录；不要提交/共享） | `~/.asterhive/rpc-sessions` |
| `WORKER_CTX_SHAKE` | RPC 上下文轻整理提示阈值（当前只告警，不自动调用 OMP slash） | `60` |
| `WORKER_CTX_COMPACT` | settled 会话执行原生 compact 的占用阈值（%） | `80` |
| `WORKER_CTX_STOP` | 达到后停止领取新任务，不修改模型窗口配置（%） | `90` |
| `WORKER_CTX_RESUME` | compact 后必须低于此值才恢复取活（%） | `60` |
| `WORKER_WORKDIR` | 工作目录根：无 repo 看板建一次性 `<任务号>` 子目录；repo 看板的项目工作区持久化于其下 `projects/<看板id>` | `<apps/worker-zcode>/work` |
| `WORKER_EXECUTOR` | 执行内核：`omp` 或 `zcode` | `omp` |
| `WORKER_PUSH` | `1` = 任务 commit 后自动 push 任务分支到 origin（凭据完全用设备 git 自身配置）；默认关，成果只以本地 commit 留在工作区 | 关 |
| `WORKER_MODEL` | 执行内核用的模型渠道（omp 模糊匹配，如 `gpt-5.2`、`openai/gpt-5.2`）；未设用内核默认。api key 走内核自身环境变量约定（子进程已继承） | — |
| `OMP_BIN` | omp 可执行文件 | `omp`（取 PATH） |
| `ZCODE_BIN` | zcode 可执行文件；`.cjs/.mjs/.js` 会用 node 直接运行 | ZCode Desktop 自带 `zcode.cjs`，找不到再退 PATH 的 `zcode` |
| `POLL_MS` | 轮询间隔（ms），每次轮询同时充当心跳 | `10000` |
| `WORKER_PI_THINKING` | 托管 Pi 工蜂思考等级：`off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`；只影响内置托管 Pi 执行器，不改变 OMP RPC/CLI | `medium`（旧配置缺省兼容） |

### OMP RPC 模式（高级可选）

```bash
EXECUTOR_MODE=rpc ASTERHIVE_URL=http://<your-server>:8067 node apps/worker-zcode/src/main.ts
```

- 默认是 `oneshot`。RPC 只对 omp 生效，改变会话持久性和费用行为，必须由设备所有者显式设置 `EXECUTOR_MODE=rpc`。
- RPC session 私有目录按内核/项目/model 分开，worker 进程退出时关闭所有 OMP RPC 子进程。默认不跨 worker 重启恢复 transcript；同一 worker 进程内 repo 项目会话跨任务复用，scratch 仍 oneshot。项目源码事实由 Git 工作区承担。
- 模型切换会先停止该项目旧模型 session，再按新 model key 启动独立 session。任务结束保留 session 供同项目下一任务复用；worker 收到 SIGINT/SIGTERM 时等待所有 RPC 子进程退出。
- task 超时 / prompt_result error/aborted 后 session 会销毁；prompt 已派发但结果未知时绝不 oneshot 重跑（避免重复副作用），只提交固定错误摘要，raw stderr 仅留设备进程内存日志。
- 上下文门禁针对已存在的持久 repo 会话，在该板任何 claim/next API 之前执行：SHAKE 只提示（OMP `/shake` 会进入 prompt，未验证为无模型操作）；COMPACT 仅在 settled 时调用原生 RPC compact，失败或 compact 后未低于 RESUME 则暂停该板取活；STOP 直接跳过该板。无 repo 的 scratch 任务不跨任务复用 RPC session。
- RPC 启动/ready/get_state 探活失败发生在 prompt 派发前，可安全回落 oneshot；派发后的失败仅报告摘要、关闭不可信 session，不重复执行。
- 首版不启用跨重启 transcript 恢复、不启用多并发会话、不自动执行 `/shake`（本机探针显示它会进入 prompt，尚未验证为无模型调用）。

## 首次运行：自动注册与 token

- 未设 `WORKER_TOKEN` 时，worker 启动即向服务器注册（agent id 取 `WORKER_HANDLE`，撞名自动加后缀），**token 只签发这一次**，打印到日志并落盘 `<WORKER_WORKDIR>/token.txt`（第一行 token、第二行实际生效的 handle）。
- 重启会**自动读取** token.txt 复用同一身份（也可把值填进 `WORKER_TOKEN` 显式指定）；旧格式（只有 token 一行）同样可读。
- 也可先在 Web 界面「Agent 管理」页手动预创建身份（身份壳），把拿到的 token 填到 `WORKER_TOKEN` 再启动，效果相同（见上节附录）。
- token 等同设备身份，注意保密：不要提交进任何仓库，不要贴进聊天室。

### 托管 Pi 工蜂的独立思考等级

Windows、Linux 和 macOS 的 `install-bee` 一键安装/升级脚本提供思考等级选择；升级时回车保留已有档位，旧配置没有档位时默认为 `medium`。配置保存在本机 `~/.asterhive/worker.json` 的 `model.thinkingLevel`，环境变量 `WORKER_PI_THINKING` 可覆盖。支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。安装时可选择本机探测：脚本会明确提示可能产生上游费用，只有确认后才向已配置的模型端点请求；模型 Key 不发送到 Hive。探测只能识别上游明确提供的元数据或错误信息，无法识别时应手动配置。
思考标签映射写在同一个本机 `model.thinkingLevelMap` 对象中，键为 Pi 档位，值为模型实际接受的标签；值 `null` 表示禁用该档位。安装器仅询问当前档位的标签：回车保留既有设置/标准标签，`standard` 删除该档位的自定义映射，`-` 将其设为 `null`。其他档位可直接编辑本机 JSON。此设置只作用于托管 Pi，不改变 omp CLI/RPC。

## 执行内核

| `WORKER_EXECUTOR` | 内核 | 说明 |
|---|---|---|
| `omp`（默认） | pi 系 CLI（omp） | prompt 写入 `<WORKER_WORKDIR>/prompt.md`，经 `@file` 传入（避开长中文参数的 shell 引号问题），并带 `--cwd` 指向任务工作目录。需设备自行安装 omp 并完成登录。 |
| `zcode` | ZCode Desktop 的 `zcode.cjs` | prompt 直接作参数传入，`--mode yolo` 运行。注意其 CLI 额度与 Desktop 会话相互独立，互不共享。 |

补充：

- 子进程工作目录即任务工作目录，环境注入 `ASTERHIVE_WORKER=1`；执行输出的末 6 行作为上交 summary。
- 换任何其他 pi 系 CLI 只需改 `WORKER_EXECUTOR` / `OMP_BIN` 指过去——适配器只关心三件事：怎么启动、怎么组 prompt、怎么变成 submit。

## 项目工作区模式（三种执行环境）

星巢支持三种工作区执行模式，适配不同项目需求：

1. **`managed` 模式（服务器托管，推荐）**：
   - 看板设置 `repoMode: 'managed'`，代码的唯一事实源集中保存在服务器持久卷中。
   - **执行隔离**：Worker 领取任务后自动调用 `GET /tasks/:id/repo-snapshot` 拉取本任务的代码快照 bundle，并在临时工作目录（`<WORKER_WORKDIR>/ephemeral/<看板id>-<任务号>/src`）解包执行。
   - **提交留痕与回传**：执行结束后有改动时，自动将任务分支打包为 `result.bundle`，通过 `POST /tasks/:id/repo-result` 流式回传服务器（服务器原子存入 `refs/asterhive/tasks/<任务号>`），由主脑通过 `asterhive_repo_inspect_task` / `asterhive_repo_integrate_task` 进行验收与合并。
   - **自动销毁**：任务提交完成后，worker 自动清空并删除临时目录，不留磁盘负担，杜绝不同设备路径冲突。

2. **`remote-legacy` repo 模式（传统持久工作区）**：
   - 看板设置 `repoMode: 'remote-legacy'` 且填写了 `board.repo`。每台设备维护持久克隆目录 `<WORKER_WORKDIR>/projects/<看板id>`，先切回默认分支后 `git pull --rebase`，切任务分支并在本地提交。

3. **`scratch` 模式（一次性临时目录）**：
   - 看板未绑定代码库时的兜底模式，在 `<WORKER_WORKDIR>/<任务号>` 新建目录，任务结束后保留现场。

| 环节 | managed 模式 | remote-legacy repo 模式 | scratch 模式 |
|---|---|---|---|
| 事实源 | AsterHive 服务器 bare 仓库 | 外部 Git 远端 | 无 |
| Worker 目录 | `<workdir>/ephemeral/<bId>-<tId>/src`（临时） | `<workdir>/projects/<bId>`（持久） | `<workdir>/<tId>`（一次性） |
| 快照来源 | 服务器 `repo-snapshot` bundle | `git pull --rebase` | 空目录 |
| 结果回传 | 自动上传 `repo-result` bundle 到服务器 task ref | 本地 commit（WORKER_PUSH=1 时 push） | 本地文件现场 |
| 主脑验收合并 | `asterhive_repo_inspect_task` + `integrate` | 查看提交证据 | 查看文件证据 |
| 本地生命周期 | 任务提交后自动清理临时目录 | 持久保留工作区 | 保留目录 |

### 无代码任务与安全上交

- 研究、调研等无需修改项目源码的任务，建卡时显式设置 `workspace: { "noCode": true }`。这只是声明该任务无需代码提交，不代表任务已通过验收。
- Worker 成功执行后以 `noCode: true` 提交（官方 worker 根据任务卡标记自动处理；SDK/HTTP 客户端可显式传入）。任务进入人工 Review，不进入自动 diff Reviewer，也不会自动移入 Done。未在任务卡声明的 no-code 标记会被服务器拒绝。
- 对 `repo` / `managed` 代码任务，执行退出码必须为 0 且必须产生真实 commit；执行异常、commit 或 bundle 回传失败、或无代码变更但任务未显式标记 noCode 时，不会 submit。Worker 会记录 checkpoint、释放任务供后续处理，并保留工作区现场；修复后可重领重做。
- 托管审核若提示 `task ref ... not found`，先确认 Worker 对 `POST /tasks/:id/repo-result` 收到 HTTP 200；缺失 ref 的审核保持 failed/Review，不会自动通过。补齐有效结果 bundle 后，由有权限的用户/蜂后重试审核。

## 取活与生命周期

**轮询与心跳遥测**：进程常驻，每 `POLL_MS` 轮询一次；执行任务期间不并发取活。绑单板时只巡检该板；多板巡检模式（`ASTERHIVE_BOARD` 缺省）逐板尝试、命中即止（一次仍只做一张卡），非参与者板 403 自动跳过。

取活通道与定向派发：
+ **蜂后定向分派（主导模式）**：新任务进入 Ready 泳道后，蜂后调用 `asterhive_match_task` 获取节点动态硬件性能与模型通道评分（Nomad 风格两阶段评估），使用 `asterhive_dispatch` 直接指定 `task.assignee = worker.handle`。
+ **工蜂取活通道**：工蜂优先检查属于自己的任务（被退回重做任务与指派给自己的 Ready 任务），通过 `worker.claim(taskId)` 原子认领开工；不再全局盲抢未指派任务。
+ **旧工蜂兼容性**：未被定向指派任务的旧工蜂向 `POST /boards/:b/next` 请求取活时，安全返回 `{ task: null }`，既杜绝跨设备冲突抢活，也不会打断定向 claim。

### 实时硬件性能遥测（Telemetry Heartbeat）

工蜂端（如 `@asterhive/sdk`）定时向 `POST /agents/:id/heartbeat` 上报当前设备负载帧：
```json
{
  "specs": {
    "os": "win32",
    "arch": "x64",
    "cpus": 16,
    "memoryTotalGb": 32,
    "executor": "omp"
  },
  "telemetry": {
    "cpuPercent": 18.5,
    "memoryUsedGb": 12.4,
    "memoryTotalGb": 32.0,
    "memoryFreeGb": 19.6,
    "memoryPercent": 38.8,
    "loadAvg": [1.2, 0.9, 0.5],
    "uptimeSec": 84200,
    "taskInProgress": null
  }
}
```

**安全鉴权与身份防伪**：
+ `POST /agents/:id/heartbeat` 强制校验调用凭据（`Authorization: Bearer <token>`），未提供凭据报 401；
+ 严格限制 `actor.id === id`（仅允许工蜂自身或管理员上报），跨工蜂冒名发送心跳与遥测直接报 403 拒绝。

**字段空值与新鲜度语义**：
+ `cpuPercent`: 首样本无间隔或系统调用失败时为 `null`，严禁伪报 0%；
+ `loadAvg`: 在 Windows 等不支持平台为 `null`；
+ `timestamp`: 服务端记录时以**接收时间**为准，防止设备端时钟偏移；
+ 数据有效期为 60 秒（`TELEMETRY_FRESHNESS_MS`），超过 60 秒未更新自动降为非新鲜，调度器不采信过期负载。

**旧工蜂兼容保证**：
+ 未升级遥测的旧工蜂：仍可正常上报静态 `specs` 或仅更新在线时间戳；
+ 调度器在评估旧工蜂时，标记“未上报实时动态遥测”，不伪装零负载，而是基于已知静态规格给予中性基准分，确保旧设备仍可平滑获得任务指派。

单任务生命周期：

| 阶段 | 动作 |
|---|---|
| 领取 | 检查指派给自己的任务（退回重做或 Ready），调用 `claim` 认领并准备工作区：repo 看板 clone/pull --rebase + 切任务分支；无 repo 建一次性 `work/<任务号>` 目录 |
| 开工 | checkpoint("开始执行")——**checkpoint 是双向同步点**：响应带回自上次以来 @ 本 worker 的消息，用户/主脑的干预直达 |
| 执行与保活 | 运行执行内核。守护进程每分钟发送带有 `isKeepalive: true` 的保活心跳维持存活；模型通过 `hive_checkpoint` 主动汇报明确里程碑，真实推进 `lastActivityAt` 与 `lastProgressAt`（保活与真实进展分离） |
| 异常/超时 | 超时或异常时保留工作区与现场，上报 `kind: 'error'` 或 `'timeout'` 的 checkpoint 明确记录可恢复现场，任务保持 InProgress 并由看板雷达预警，避免盲目重派与丢失现场 |
| 上交 | submit：summary（执行输出末 6 行，repo 模式附本地提交信息）+ 证据——repo 模式为本任务变更文件 + `git:<分支>@<hash>`；scratch 模式递归收集工作目录全部文件（跳过 `.git`/`node_modules`），记录相对路径与本机机器名 |
| 被退回 | 用户或主脑可通过受控指令（`/tasks/:id/review/return`）将 Review 状态任务原子退回指定工蜂，转为 `InProgress`（`reviewStatus: 'rework'`），由工蜂在下轮轮询重新领取断点续做 |
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

与 CLI 守护型的差异：非常驻、随会话存活；执行者是完整桌面 agent——有全部工具与套餐额度，不受 CLI 独立计费影响。

## 自定义 worker（其他语言）

不依赖 Node：任何能发 HTTP 的 runtime 按协议直调即可，最小端点集（鉴权均为 `Authorization: Bearer <token>`）：

| 端点 | 用途 |
|---|---|
| `POST /agents/register` | 注册（body：`name`、`handle`，可选 `role`、`host`（接入设备名）、`models`（自报模型清单））；**token 只返回这一次**，调用方自行持久化 |
| `POST /agents/:id/heartbeat` | 心跳与硬件遥测上报（带 Bearer 令牌，body：`specs?`、`telemetry?`） |
| `POST /boards/:b/next` | 从定向指派池原子领属于自己的任务；无指派任务安全返回 `{task: null}` |
| `POST /tasks/:id/claim` | 明确认领定向指派给自己的任务（支持并发原子抢锁与文件冲突检测） |
| `POST /tasks/:id/checkpoint` | 上报进度或保活（body：`note`，可选 `kind`、`isKeepalive`）；响应带回 @ 我的待达消息 |
| `POST /tasks/:id/review/return` | 将 Review 状态任务退回指定工蜂重做（仅 user/orchestrator，body：`reason`、可选 `assignee`） |
| `POST /tasks/:id/submit` | 上交（body：`summary`、`evidence?`——`{path, machine}` 数组） |

TS/Node 侧也可直接用 [`@asterhive/sdk`](../packages/sdk/src/index.ts) 的 `Worker` 类（register / next / claim / checkpoint / submit / release / heartbeat，附 inbox / postMessage / getTask），不必手写请求。
## 安全注意

- **worker token 等同设备身份**：妥善保管；一旦泄露，在 Web 界面 Agent 页吊销即可（吊销后该 token 全部请求 401），再注册/重发新 token 恢复接入。
- **不越界**：任务卡 `protectedPaths` 作为"禁止触碰"清单随 prompt 下发，worker 只在自己被指派的工作目录内活动；越界改动验收时会被主脑打回。
