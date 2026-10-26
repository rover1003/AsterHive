# 部署指南（Docker Compose）

面向陌生部署者的最短路径：一台内网 Linux/Windows 服务器 + Docker，五分钟起一个完整的星巢。

## 1. 前置要求

- Docker ≥ 24 与 docker compose v2（`docker compose version` 可执行）
- 服务器与使用设备处于同一内网（或经 WireGuard 等隧道处于同一虚拟内网）
- 被管理项目是一个 git 仓库（worker 设备需装有 git）

## 2. 一键启动

```bash
git clone https://github.com/rover1003/AsterHive.git && cd AsterHive
docker compose up -d --build
```

- 监听 `8067` 端口；数据落在命名卷 `asterhive-data`（容器内 `/data`）。
- 打开 `http://<server-ip>:8067` 即 Web UI；`/health` 返回 ok 即就绪。

## 3. 数据卷布局

所有业务数据统一定位在 `/data`（`ASTERHIVE_DATA`）：

```
/data
├── asterhive.db        SQLite（WAL）：看板/任务/消息/事件台账
├── db-snapshots/       写前快照 ×3（自动轮换，可恢复）
├── repos/              managed 模式的服务器托管 bare 仓库（代码资产）
├── evidence/           任务证据文件（大文件落盘，小文件在库内）
└── pi-runtime/         内置蜂后 Pi 运行时（版本、社区扩展、技能挂载点）
```

**备份**：打包整个 `/data`（或至少 `asterhive.db` + `repos/` + `evidence/`）即可完整保留全部状态。
**恢复**：解压回数据卷并启动容器，服务自动对齐数据库与托管仓库。

## 4. 升级

```bash
cd AsterHive && git pull
docker compose up -d --build
```

旧数据卷原样保留；数据库 schema 热迁移（启动时自动补列）。Pi 运行时升级走 Web UI「设置 → Pi 运行时」（装新版→原子切换→可回滚），与镜像升级解耦。

## 5. 安全模型（务必阅读）

星巢为**可信内网单用户**设计：

- **匿名请求即用户**：浏览器不发任何凭据，所有无 token 请求被服务器视为唯一的你（全权限）。这是有意语义，不是缺陷。
- **不要把端口暴露到公网**：无鉴权、无 TLS，公网暴露等于把系统交给任何访客。跨网络组网用 WireGuard 等隧道。
- agent token 仅用于 agent 身份归属与角色分层（如 worker 无法把卡移进 Done、worker 不能重启别的 worker），不用于人类鉴权。
- 蜂后的模型 API Key 加密存库，界面永不回显；worker 的模型 Key 由设备自持，服务器不经手。

## 6. 接入工蜂

把这句话发给任意设备上能联网的 agent：

> 访问 `http://<server-ip>:8067/skill/asterhive-worker` 并照做

agent 凭这一个 URL 自举：注册（自动上报设备名/内核/硬件规格）、学会领活循环、常驻化。详见 [WORKER.md](WORKER.md)。

## 7. 多端派活（可选）

任何能发 HTTP 的端（手机快捷指令、机器人）可向 `POST /api/webhooks/chat-to-card` 发一句话，自动进看板聊天室并唤醒蜂后拆解：

```bash
curl -X POST http://<server-ip>:8067/api/webhooks/chat-to-card \
  -H 'content-type: application/json' \
  -d '{"content":"排查登录超时问题","source":"iOS-Shortcut"}'
```
