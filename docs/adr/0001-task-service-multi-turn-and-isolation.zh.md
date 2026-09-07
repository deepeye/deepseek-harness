# Multi-turn conversations and per-conversation isolation on the task-service HTTP surface

[English](0001-task-service-multi-turn-and-isolation.md) | 中文

task-service（`POST /tasks`）在设计上为单轮——README 承诺 "Every task is one Agent session driven by a single prompt"——且所有对话共享一个 `cwd`、一个 bearer token 与一个 Host 进程。我们决定通过拆分 task = session = turn 的合一来加入多轮对话与工作目录隔离：Task 仍为一次提交（一个 turn）；Session 是由 `POST /tasks` 上可选 `sessionId` 命名的长生命周期对话；续接采用幂等 create-or-resume（`dsh-task-service` 内的瘦内联路径，而非复用非公共导出的 `ApiSessionAgentController.createOrAdopt`），使对话经持久会话日志在 Host 重启后幸存。每个对话获得服务铸成的 `<workspaceRoot>/<sessionId>` 工作目录（新的已校验 `Config` 字段）；对一个 turn 仍在运行的对话再次提交返回 `409 session/agent-busy`。调用方/租户鉴权与按对话的进程沙箱不在范围内。

## Considered Options

- **身份模型：** 否决 "把 Task 提升为带 `POST /tasks/{id}/messages` 路由的长生命周期对话"——它扭曲 "服务不引入新会话状态" 的不变式并迫使按 turn 的子身份；保持 Task = 一个 turn 使每个 task 的 result / SSE / webhook / cancel 语义不变。
- **续接：** 否决 "仅存活 agent"——它让每个对话在 Host 重启后成孤，尽管日志是持久的；否决严格的 "仅冷恢复、首消息 404"——幂等 adopt 在同等组合成本下给出更友好的契约（首消息创建、后续恢复）。
- **工作目录：** 否决 "客户端提供 `cwd`/`workspaceId`"——把文件系统路径权威交给客户端，并允许两个对话指向同一目录；否决 "按对话的 git worktree"——对无人值守服务而言过重且与 git 耦合。
- **同一对话并发：** 否决 "排队第二个 turn"——它破坏每 task 的 `firstSeq`/结果推导，并引入该面今日不存在的队列概念。

## Consequences

- **组合变更：** `service-app` profile 现不组合 session-controller；弥合该缺口要求 `dsh-task-service` 注入 `ctx.sessionQuery`（冷读）并内联手写 create-or-resume 路径。瘦路径居于 task-service 而非 `service-app`，因 resume 需求比 controller 的更瘦（无 preset、projection、Typert 或 subagent 归属围栏）。
- **隔离范围明确：** 仅 context + 工作目录。调用方/租户授权与按对话的 OS 进程沙箱刻意不在范围内——加入任一即将 "可信单用户主机" 变为多租户服务，那是不同的产品面。
- **已验证：** `workspace-write` 权限沙箱跟随每次调用的会话 `cwd`（`packages/fs/fs-sandbox/src/index.ts`），故 `<workspaceRoot>/<sessionId>` 子目录自动受沙箱界定——无需沙箱改动。
- **与既有代码的矛盾：** `taskId === sessionId`（`packages/api/task-service/src/index.ts`）与 task-service README 的概要曾承诺三者合一。本决策拆分之，且 README 的概要与已知限制在同一 PR 中重写。
