# 一期路线图（MVP）

> 依据 [立项计划](立项计划.md) §12 一期范围分解。泳道：Backlog → Ready → InProgress → Review → Done；任务卡带验收标准（acceptance）；Review → Done 只能由主脑/用户核实证据后移动——本仓库自身的开发也照此模型走（自食其狗粮）。

| id | 任务 | depends_on | acceptance（验收标准） | 泳道 |
|---|---|---|---|---|
| T1 | 仓库初始化与服务器骨架：git/README/脚手架，Hono 服务 + /health + SSE 占位 + SQLite 事件表 | — | `npm run dev` 可启动；/health 返回 ok 且含事件计数；/events 可建立 SSE 连接并收到 hello/heartbeat | Done |
| T2 | 事件存储与备份：append-only 事件写入 API、写前快照 ×3、恢复入口 | T1 | 任何结构化写入前自动快照并保留最近 3 份；快照可恢复；事件只追加不物理删除 | Done |
| T3 | 看板 API：boards / tasks CRUD，五字段 + priority/category/acceptance/evidence/workspace/files/protectedPaths，depends_on 依赖解锁，泳道迁移与 WIP 限制校验，Review→Done 按角色拒绝 | T2 | 按 §5.1/§7 契约建卡全字段落库；上游 Done 自动解锁下游并记 autoUnblockedAt；worker 角色调 move-to-done 被 403 | Done |
| T4 | 领取与 worker 动词：/next 原子认领，claim / checkpoint / release / submit，文件清单互斥，TTL 断线判定（默认 240 分钟可调） | T3 | 并发 next 不重复发牌；两份活跃认领文件清单重叠被拒；超时无心跳的占用可被他人接管 | Done |
| T5 | 消息与 @ 路由：messages 表，@句柄 机械解析投递，任务号自动挂 taskRef，SSE 实时推送 | T3 | @ 消息仅投递目标 agent；消息中 Txx 被识别并挂 taskRef；SSE 客户端实时收到新消息事件 | Done |
| T6 | Agent 注册表与鉴权：register / token 签发与吊销 / heartbeat / 启停，操作全量入审计 | T3 | 吊销 token 后对应 API 全部 401；所有写操作可在 /audit 查到 | Done |
| T7 | Web UI 基础：Vite + 原生 TS 脚手架、整体布局、SSE 接入层 | T1 | 界面打开后无需刷新即可看到 SSE 推送的变化 | Done |
| T8 | Web UI 聊天室视图（默认视图）：消息流、@ 调度、taskRef 跳转、用户干预入口、checkpoint 折叠 | T5, T7 | 用户在界面发言可 @ 派活与干预；分派/上交/泳道播报在流中完整呈现 | Done（checkpoint 折叠随二期） |
| T9 | Web UI 看板视图：泳道、依赖图、占用、证据，卡片详情内嵌任务消息子流 | T7, T3 | 卡片按泳道渲染、依赖关系可见、点击卡片可见消息子流与证据 | Done |
| T10 | Web UI Agent 总览（fleet）+ Agent 接入页 + 主脑设置页 + 审计页 | T6, T7 | 一屏纵览 agent 状态色标/当前占用/最新 checkpoint；注册、命名、token、启停、主脑模型配置全部在界面完成 | Done |
| T11 | 首批 worker 接入：设备侧主动注册、pull 型（ZCode headless 先行）；push 启动器（Nomad/SSH）后置可选 + 模式 A 主脑端到端串联 | T4, T5, T6, T8, T9, T10 | 聊天室完成一次真实小任务全流程：用户提目标 → 主脑建卡 @worker 派活 → worker 执行 @主脑 上交 → 主脑验收 Done；用户全程只发自然语言 | Done（2026-10-25 实跑闭环：派活→上交→退回→重做→验收通过；执行内核 omp，zcode CLI 受独立 API 计费阻塞） |
| T12 | 部署内网服务器：Docker 容器（docker compose，命名数据卷 + restart 策略）+ 局域网可达验证 | T11 | 局域网其他设备经 token 访问全部端点正常 | Done（2026-10-25 部署成功：容器 healthy，工作机经 LAN 验证注册/互斥/overview；代码经 git archive 管道送达） |
| ~~T13~~ 已关闭 | 公网接入：无需新建通道——外部设备经既有 WireGuard 隧道入网（DDNS + 动态公网 IP 已就绪），星巢视角全设备皆内网；三期飞书回调等真公网入站届时再加反代 + TLS | — | — | Closed |

## 二期任务（无人值守主脑 + 拉取型 worker）

| id | 任务 | 说明 | 状态 |
|---|---|---|---|
| T14 | 内置主脑（Pi 运行时） | Pi SDK 嵌入（earendil-works/pi，MIT）；**运行时装数据卷 /data/pi-runtime 由服务器自管理**（不进镜像，保持容器不可变）；主脑设置页"Pi 运行时"卡片：当前版本 ↔ 上游最新，一键更新（装新版→原子切换→重启主脑子进程）、旧版保留一键回滚、版本变更入台账；事件唤醒（新消息/进 Review/阻塞上报）。**接入方案已定**（docs/research/pi-plugins.md）：① 主脑协议工具 = Pi 原生 MCP client 直连 /mcp（exposure:direct，SDK 侧 createMcpExtension）零胶水；② 自写 30–50 行 tool_call allowlist 门控扩展，"只分派不执行"做成硬约束；③ 记忆做服务器侧 remember/recall MCP 工具（事件台账为唯一事实源），不装 engram；④ 不装 cron/todo/goal/subagents 类（与服务器状态双源或违反主脑约束）；⑤ 崩溃恢复先原生 SessionManager JSONL，pi-durable 留作升级项 | Backlog→**InProgress**（2026-10-25 用户指令提前开做；含社区插件挂载点 /data/pi-runtime/extensions） |
| T15 | pull 型 worker 心跳 TTL 完整化 + 证据上传端点 | 小文件入库、大文件登记校验和；干预消息注入运行中会话。**首项"项目工作区持久化"已完成**（2026-10-25，a0ca6e5）：board.repo 驱动每设备每项目工作区（clone→pull --rebase→任务分支 asterhive/<任务号>→本地 commit 留痕，hash 进证据；push 需 WORKER_PUSH=1 显式开启；失败阻塞上报不静默改道） | InProgress（余 TTL/证据增强/干预注入） |
| T16 | 24 小时无人值守验收 | 用户离开 24h，多任务多依赖目标被自动拆解、分派、执行、验收（人工抽查证据） | Backlog |
| T17 | 主脑插件/技能界面化管理（公开化前置） | 设置页"主脑扩展"卡片：列表/启停/删除 + 上传 zip 或填 npm 包名安装（服务器代跑 pi install 装入数据卷）；Pi skills 挂载目录；运行中变更下会话生效不打断当前轮 | Backlog |
| T18 | 项目公开化准备 | LICENSE 定稿（建议 MIT）；面向陌生部署者的文档：compose 一键部署、**"匿名请求即用户"的内网信任模型必须显式说明**、示例看板与 worker 接入样例；README 双语评估 | Backlog |

## 决策记录（原 §13 开放决策，随用户拍板收敛）

- **部署形态**：已定（2026-10-24）——内网服务器 Docker 容器，docker compose 管理。
- **Worker 接入模式**：已定方向（2026-10-24）——一切外部设备（局域网乃至公网）统一以 worker 身份主动接入，pull 型优先；push 启动器（Nomad/SSH）后置可选。
- **工作区管理**：已定（2026-10-24）——被管项目以 git 仓库为唯一事实源，各设备自持克隆；互斥靠 files 清单、汇合靠分支/提交证据（立项计划 §9.4）。
- **公网接入**：已解决（2026-10-24）——外部设备经既有 WireGuard 隧道入网（DDNS + 动态公网 IP 已就绪），无需端口转发/新隧道方案；三期飞书等真公网入站届时再加反代 + TLS。T13 关闭。
- **MVP 主脑模式**：模式 A（用户会话兼任）——既定，模式 B（内置 Pi）属二期。
- **Pi 运行时升级机制**：已定（2026-10-25）——运行时存数据卷由服务器自管理，UI 保留"更新 Pi 上游版本"按钮（一键更新+回滚+入台账），不依赖容器重建。
- **聊天室粒度**：建议每 board 一房 + 全局摘要频道，随 T5 实现时定稿。
- **Agent 接入模型**：已定（2026-10-25，41eea85）——设备自助注册为一等路径（注册时自动自报主机名 host 与模型清单，"在哪台设备跑就属于哪台设备"）；Web UI 手动注册降级为"预创建身份"高级项（诚实警示：pull 架构服务器不探测设备，只建身份壳）；未接入的身份标「未上线」。
- **接入极简化**：已定（2026-10-25，实施中）——注册参数全默认（name/handle 自动生成、409 冲突自动改名重试）；worker 不再强制绑板（ASTERHIVE_BOARD 缺省=巡检全部看板，非参与者板自动跳过）；接入设备只需一个服务器地址。
- **SKILL 自举协议**：已定（2026-10-25，实施中）——SKILL.md 定位为"agent 启动盘"：获取文档的 origin 即服务器地址，注册/循环/纪律全自包含，宿主特有能力写成条件句式（不限 CLI/桌面端形态）；用户唯一动作 = 把 SKILL 地址递给 agent；agent 定期重报模型清单，自动名是占位符由用户在列表中改名。
- **主脑人格 v2**：已定（2026-10-25，57fc380）——系统提示词强化：建卡前四问澄清真实意图（模糊则带选项追问一次问全）、拆解必须边界化（禁模糊 title/写明不做范围/acceptance 逐条可检验/粒度一次可完成）、回收证据对照验收（退回写明差距、主观判断请用户拍板）、禁执行升格为身份推论（顺手能做也必须建卡分派）。
- **Git 托管中立与敏感分层**：已定（2026-10-25）——board.repo 不绑定任何托管商（GitHub/自建 Gitea/局域网裸仓库皆为普通 git remote，worker 协作模型一致）；通用做法：完整主仓放内网自建 git 服务，公开 GitHub 仅作开源镜像出口，密钥与私有配置永不入 git；此原则写进主脑提示词（纪律七：验收发现凭据一律打回并提醒轮换）。
