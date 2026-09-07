# Agent Note: Task-service multi-turn conversations and per-conversation working-directory isolation

Status: implemented

[English](2026-09-07-task-service-multi-turn-and-isolation.md) | 中文

## Problem

task-service 的 HTTP 面（`POST /tasks`）把 task、session、turn 三者合一：每次提交都铸 `session-<uuid>` 同时作为 task id 与 session id，创建一个全新 Agent 并入队一条提示词——因此客户端无法跨 turn 维持对话，也无法在 Host 重启后幸存，尽管会话日志是持久的。每个 task 还设置 `meta: { cwd: process.cwd() }`，所有对话共享同一工作目录。原始的 [remote task-service note](../../implemented/feature/2026-09-01-remote-task-service.zh.md) 对两者都作了承诺："taskId IS the branded SessionId" 与 "one task is one Agent session driven by a single prompt."

## Decision

拆分这一合一。**Task** 仍是一次提交（一个 turn，id `task-<uuid>`）；**Session** 是由 `POST /tasks` 上可选 `sessionId` 命名的长生命周期对话（缺省时铸 `session-<uuid>`）。续接采用幂等的 create-or-resume：用同一 `sessionId` 的第二个 task 采用存活的空闲 agent、冷恢复已持久化会话、或创建全新普通会话——因此对话经持久日志在 Host 重启后幸存。每个对话拥有服务铸成的 `<workspaceRoot>/<sessionId>` 工作目录（`workspaceRoot` 是新的已校验 `Config` 字段，默认 `process.cwd()`）；对一个 turn 仍在运行的对话再次提交返回 `409 session/agent-busy`。

四个子决策承载设计：

- **瘦内联 create-or-resume，不复用 controller。** resume 路径在 `dsh-task-service` 内手写约四十行，仅用公共 API（`ctx.agents.get` / `create` / `resume`、`ctx.sessionQuery.observeSession`）。不复用 `ApiSessionAgentController.createOrAdopt`：该类不是 `@deepseek-ai/dsh-api-session-controller` 的公共导出，复用需扩张公共 API 或走源码面导入——两者都比瘦内联路径 blast 更大。task-service 的 resume 需求确实比 controller 的更瘦（无 preset、无 projection、无 Typert、无 subagent 归属围栏），故并行逻辑并非纯重复。

- **`sessionTask` 索引追踪运行中 turn。** 一个 `Map<sessionId, TaskRecord>` 追踪在飞 turn，服务于拆分后否则会断的两个消费方：收尾探测 handler（现经 `sessionTask` 按 `session.id` 索引，而非按 taskId）与 409 忙忙守卫。`turn/end` 时记录收尾并删除 `sessionTask` 条目，释放会话以接受下一 task；存活空闲 agent 留在 `ctx.agents` 供采用与结果查询。已结束记录留在 `this.tasks` 供 `/tasks/{taskId}` 查询。

- **cwd 冲突是 409，而非静默重绑。** 冷恢复校验 `observation.header.cwd === sessionCwd(sessionId)`；记录的工作目录不再匹配服务铸成者的持久化会话（`workspaceRoot` 变更，或外来 `sessionId` 碰撞）返回带 `sessionId` 的 `409 session/cwd-conflict`。session-controller 所带的 subagent 归属围栏在此不必要：task-service 拥有自己的 session 命名空间并以普通 origin 创建会话，故携带 subagent origin 的冷读会话即外来 id 碰撞，由同一 cwd 校验捕获。

- **冷读与冷恢复路径均直接读 `sessionPersistence`，而非 SQLite 查询索引。** `SessionObservationReader.read` 对冷会话回退到 `ctx.get('sessionPersistence')`，`AgentLoop.resume` 仅经 `sessionPersistence` 开启会话。故生产组合（`session-query-sqlite` 取 `path: ':memory:'`、`openAt: never`）支持冷恢复——空 SQLite 索引对两路径均无关。此点经追踪 resume 加载路径与双上下文冷恢复测试验证。

每 task 的 `firstSeq` turn 边界、结果文本推导、`streamEvents` 回填、`cancel` 与 webhook 投递均按 `taskId` / `record.agent.session` 索引且不变——每 task 的 turn 由其自身 `firstSeq` 界定，故多轮无需改动结果推导。

## Alternatives considered

**复用 `ApiSessionAgentController.createOrAdopt`。** 否决：该类是 `@deepseek-ai/dsh-api-session-controller` 的内部类（无公共导出）；导入它将扩张公共 API 或迫使源码面导入，两者都比瘦内联路径更大。task-service 的 resume 需求缺 controller 的 preset、projection、Typert 与 subagent 归属关注，故并行逻辑今日不构成值得共享缝的重复。

**把 Task 提升为带 `POST /tasks/{id}/messages` 的长生命周期对话。** 否决：它扭曲 "服务不引入新会话状态" 的不变式并迫使按 turn 的子身份；保持 Task = 一个 turn 使每个 task 的 result / SSE / webhook / cancel 语义不变。

**仅冷恢复（首消息 404）。** 否决：幂等的 adopt-or-create 在同等组合成本下给出更友好的契约（首消息创建、后续恢复）。

**客户端提供 `cwd` / `workspaceId`。** 否决：把文件系统路径权威交给客户端，并允许两个对话指向同一目录。

**对运行中会话排队第二个 turn。** 否决：它破坏每 task 的 `firstSeq` / 结果推导，并引入该面今日不存在的队列概念。

## Consequences

- **组合：** `dsh-task-service` 新增 `sessionQuery` 为必注入项（`static inject` 加 `'sessionQuery'`）；`workspaceRoot` 为新 `Config` 字段。`service-app` profile 无需改动——它组合 `dsh-base`，后者挂载 `sessionQuery` 与 `session-persistence-jsonl`，且 `workspaceRoot` 默认 `process.cwd()`。
- **部分取代：** [原始 task-service note](../../implemented/feature/2026-09-01-remote-task-service.zh.md) 的 "taskId IS the branded SessionId" 与 "one task is one Agent session driven by a single prompt" 决策不再成立；本 note 拆分之。原始 note 的 profile、SSE、webhook 与无人值守安全决策仍然有效。
- **未来抽取触发点：** create-or-resume 模式出现第三个消费方时（今日：`ApiSessionAgentController` 与此内联路径）应抽取 `dsh-session-resume` 包，拥有瘦 adopt / 冷读 / resume 缝。两个消费方尚不足以证成包边界。
- **覆盖：** REAL-composition 测试新增多轮（存活 agent 采用保留历史）、跨两 Host 上下文冷恢复（持久化的第二个 turn 的 LLM 请求携带第一个 turn 的标记）、cwd 隔离（不同的 `<workspaceRoot>/<sessionId>` 目录）、409 忙碌、409 cwd 冲突。`docs/adr/0001-task-service-multi-turn-and-isolation.md` 中的沙箱隔离后果已验证：`workspace-write` 跟随每次调用的会话 cwd，故 `<workspaceRoot>/<sessionId>` 子目录自动受沙箱界定——无需沙箱改动。
