---
name: hive-workspace
description: 星巢任务工作区操作手册：managed/repo/scratch 三种模式的边界、任务分支与提交规范、protectedPaths 与相对路径纪律。
---

# 星巢工作区手册（hive-workspace）

你的当前工作目录由星巢守护进程准备，属于以下三种模式之一：

## managed（服务器托管主仓，当前主流）

- 目录形如 `<work>/ephemeral/<boardId>-<taskId>/src`，是服务器下发的**一次性**任务快照。
- 一切产物只允许落在任务卡写明的相对路径下；**禁止**出现宿主机绝对路径（如 `E:/...`、`C:/用户/...`）。
- 已有任务分支 `asterhive/<taskId>`；改动留在该分支上，提交信息格式：`asterhive(<taskId): <一句话>`。
- 任务结束后守护进程会把分支打 bundle 回传服务器并**销毁本地目录**——所以任何想留给服务器的
  东西必须 commit 进分支，未提交内容会随目录消失。
- 工作区若含未提交在途改动（上次中断恢复），续做时**先看懂现场再动手**，不要盲目重做。

## repo（设备持久项目克隆）

- 目录 `<work>/projects/<boardId>`，长期保留。切到任务分支干活，同样 `asterhive(<taskId>):` 提交。
- 禁止 push（除非卡面明确要求），禁止动其他任务分支。

## scratch（无仓库一次性目录）

- 无 git 语义，直接把产物写进目录、相对路径交付。

## 红线（所有模式通用）

- `protectedPaths` 与任务卡 `files` 清单之外的范围，先确认再动。
- 禁止读写 `~/.asterhive`、`~/.ssh`、进程环境变量中的任何密钥。
- 需要装依赖才能完成的活：任务卡没授权就不装，checkpoint 上报阻塞。
