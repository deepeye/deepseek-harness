# Agent Note：远程任务服务（service profile）

状态：已实现

[English](2026-09-01-remote-task-service.md) | 中文

## 问题

从另一台机器驱动 harness 时，只能在两条都不贴合的现有缝里选：SDK 族讲 stdio 上的换行分隔 JSON-RPC，假设客户端在同一台机器上以子进程方式拉起运行时；web BFF 则假设浏览器客户端和 launch-token 信任围栏。本地 web 或 desktop 客户端想提交一个 agent 任务并取回结果，没有任何面向网络的缝可用，"harness 作为远程 agent 服务"也没有受支持的 profile。

## 决定

新增 profile（`dsh --profile service`），由 `dsh-base` 加新 bundle `service-app` 组合而成；bundle 挂载现有的 webserver 与新包 `task-service`（`packages/api/task-service`）。HTTP 面以任务为形状而非会话为形状：一个任务就是一个由单条提示词驱动的 Agent 会话，复用 headless runner 的进程内驱动模式（`agents.create` → `followup` → 从日志检测收尾）。

四个决定承载设计：

- **taskId 就是带品牌的 SessionId。** 线上 id 与持久日志保持同一身份；会话日志是唯一权威，结果按需从日志重新推导，而不是累积进一台并行的状态机。
- **SSE 帧原样承载会话事件**（从 `firstSeq` 回填、按序列号去重、`turn/end` 终止）。投影保持纯函数：流就是日志的视图，因此不需要新事件类型、不改 `SessionEventMap`——这也是不需要 recorded-session snapshot 的原因。
- **完成语义是每任务 webhook 加可查询结果**，不是只有推送流：不保持长连接的调用方也能拿到结果；有界重试绝不改变任务结果本身。
- **无人值守的安全靠组合而非代码：** bundle patch 把 base 的 approval 行替换为 fail-closed 的 `never` 策略，并固定一个 `service` 权限预设（workspace-write + 拒绝审批）。由于 patch 整体替换目标行的 config，permission 行重述了 base 的每个预设；permission-presets 的组合默认检查会强制这种配对关系——姿态不匹配时正好得到我们想要的响亮失败。

Bearer 鉴权是一个必填的 `token` 配置字段，加载时校验（空值响亮失败）、常量时间比较；信任边界在文档中明确为单用户，因此不预置任何多租户机制。

## 备选方案

**给 SDK stdio server 包一层网络桥。** 否决：那会在客户端与 agent 之间再叠一层协议转换，而进程内驱动根本不需要协议。SDK 仍是进程本地驱动者的正确缝。

**复用 web BFF 的 session-controller 端点。** 否决：它们是会话/对话形状，并与浏览器信任围栏（process token、Host/Origin 检查）纠缠；把它们改造成无人值守的任务语义，会让 web 表面而非任务表面继续生长。

**带持久状态的任务队列。** 延期：注册表在内存中，重启会丢失已完成结果（会话日志仍在磁盘上）。当前消费方不需要跨重启的任务；该限制已记录在两份 README 中。

## 影响

新增 `packages/api/task-service` 与 `packages/bundle/service-app`；`PROFILE_TEMPLATES` 增加 `service`；apps/cli 声明该 bundle 依赖以便启动器解析。`SessionEventMap`、agent-loop 与 snapshot 树均未改动。REAL-composition 覆盖经真实 Loader 组合加 mock LLM provider 启动，断言鉴权拒绝、提交/结果闭环、SSE 帧顺序、webhook 投递与取消。
