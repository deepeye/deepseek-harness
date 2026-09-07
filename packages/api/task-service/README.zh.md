---
description: "dsh 的远程任务 HTTP 面：提交一个 agent 任务、通过 SSE 观察进度并取回结果，供本地 web 与 desktop 客户端驱动 harness 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-task-service

[English](README.md) | 中文

## 概述

`dsh-task-service` 把运行中的 harness 变成任务服务：本地 web 或 desktop 客户端 POST 一个任务提示词，通过 server-sent events 观察 agent 执行，并以查询、SSE 流或 webhook 回调三种方式取回最终结果。**Task** 是一次提交（一个 turn）；**Session** 是由可选 `sessionId` 命名的长生命周期对话。不带 `sessionId` 提交即开启新对话；用同一 `sessionId` 再次提交则继续对话——即使 Host 重启后也如此：持久会话日志从持久层冷恢复。每个对话拥有独立的 `<workspaceRoot>/<sessionId>` 工作目录；对一个 turn 仍在运行的对话再次提交返回 `409 session/agent-busy`。所有路由由单个 bearer token 保护；本服务面向可信的单用户主机，不是多租户部署。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包作为 `dsh-base` 之上的 [`@deepseek-ai/dsh-service-app`](../../bundle/service-app/README.zh.md) bundle 组合；设置 `DSH_SERVICE_TOKEN` 后运行 `dsh --profile service`。客户端直接对接 HTTP 面。

### 提交任务并取回结果

```sh
curl -X POST http://127.0.0.1:PORT/tasks \
  -H "Authorization: Bearer $DSH_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"task": "Summarize the repo README"}'
# 202 {"taskId": "task-…", "sessionId": "session-…", "status": "queued"}
```

服务解析会话（采用存活的空闲 agent、从持久层冷恢复已持久化会话、或创建全新普通会话），入队提示词并立即返回 `202`。turn 进行中时 `GET /tasks/{taskId}` 返回 `{"status": "running"}`；结束后返回最终文本和持久的 `turn/end` 原因（`completed`、`error`、`max-tokens`、`aborted`、`blocked`）。未知 id 返回 `404`；取消是 `POST /tasks/{taskId}/cancel`，它中止当前 turn 并由正常收尾路径记录 `aborted` 结果（已结束的任务返回 `409`）。

### 继续对话

用同一 `sessionId` 再次提交，即向既有对话追加一个 turn。若该 agent 仍注册存活则直接采用；Host 重启后则从持久日志冷恢复：

```sh
curl -X POST http://127.0.0.1:PORT/tasks \
  -H "Authorization: Bearer $DSH_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"sessionId": "session-…", "task": "Now translate it."}'
```

turn 仍在运行的对话返回 `409 session/agent-busy`；待上一任务结束后重试。已持久化会话其记录的工作目录与服务铸成的不再匹配时返回 `409 session/cwd-conflict`（该持久化 `sessionId` 是在另一 `workspaceRoot` 下创建的）。

### 通过 SSE 观察进度

`GET /tasks/{taskId}/events` 返回 `text/event-stream`。每个 SSE 帧原样承载一个会话事件的 JSON，从任务的第一个事件开始（流先回填日志再进入实时模式，序列号负责去重衔接）。`turn/end` 是最后一帧，服务端在其后关闭流。客户端断开只是放弃订阅。

### 完成回调 webhook

提交时带上 `"webhookUrl": "https://…"`（或配置服务级默认值），任务结束时服务向该 URL POST 一段 JSON：

```json
{"taskId": "task-…", "sessionId": "session-…", "status": "finished", "result": {"text": "…", "reason": {"kind": "completed"}}}
```

每次投递有超时（默认 10 秒），失败后有界重试（默认 2 次）；投递失败只记录警告日志，绝不改变任务结果。

### 鉴权

每个路由都要求 `Authorization: Bearer <token>`；token 是必填的 `token` 配置字段（空值会让 profile 加载失败）。比较采用常量时间。token 无效的请求返回 `401`。

| 字段 | 默认 | 含义 |
|---|---|---|
| `token` | 必填 | 每个请求必须出示的 bearer token |
| `workspaceRoot` | `process.cwd()` | 每个对话的 `<sessionId>` 工作目录在其下创建的根 |
| `webhookUrl` | — | 任务未提供覆盖时的默认完成回调地址 |
| `webhookTimeoutMs` | `10000` | webhook 单次投递超时 |
| `webhookRetries` | `2` | 首次失败后的重投次数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-task-service)是所有字段及其 JSDoc 的详尽来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

一个 Service 类在 [webserver](../../host/webserver/README.zh.md) 上注册单个 `prefix` 路由 `/tasks`，外加一个全局 `session/event` 订阅；两者都是服务 fiber 的 effect，dispose 即移除路由与订阅。

### 任务生命周期

`POST /tasks` 读取有界（1 MiB）JSON 请求体，解析对话的 `sessionId`（客户端提供或新铸的 `session-<uuid>`），并铸造按提交计的 `task-<uuid>`。解析步骤采用该会话存活的空闲 agent、从 `sessionPersistence` 冷恢复已持久化会话（先校验记录的工作目录与服务铸成的 `<workspaceRoot>/<sessionId>` 一致）、或通过 [`ctx.agents`](../../core/agent/README.zh.md) 以共享的 [`agentDefaultModel`](../../core/agent-default-model/README.zh.md) 选择创建全新普通 Agent（与 [headless](../../bundle/headless/README.zh.md) 相同的驱动模式）；一个 `sessionTask` 索引把运行中 turn 的 `sessionId` 映射到其记录，供忙守卫与收尾订阅使用。agent 静息时记录 `firstSeq`，再用 `agent.followup` 入队提示词。收尾订阅把每个任务的 `turn/end` 折叠为最终文本（`firstSeq` 之后所有 `assistant/message` 文本块拼接）并释放 `sessionTask` 条目，使会话可接受下一 turn；结果始终从会话日志重新推导、绝不增量累积，日志因此是唯一权威。同一对话的并发提交折叠为一个创建-恢复 promise。

### SSE 投影

`GET /tasks/{taskId}/events` 为自己的会话订阅 `session/event`，从 `firstSeq` 回填日志，然后排空订阅队列；`event.seq <= lastSent` 负责去重订阅/快照的衔接。泵在记录状态已结束或客户端断开时结束（`req` close 会注销订阅并唤醒泵）。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `taskService` Service：路由、任务注册表、SSE 泵、webhook 投递 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴随插件：每个已注册任务都持有 agent 注册表中的存活 agent |
| [`tests/task-service.spec.ts`](tests/task-service.spec.ts) | 经 vendored Loader 加 mock provider 的 REAL-composition 覆盖 |

### 不变式归属

伴随插件检查服务拥有的注册表关系：每观察到一个 `turn/end`，任务记录必须仍持有 agent 注册表中的存活条目——过期记录会向已销毁 agent 索取结果，并为死去的驱动受理取消请求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-service-app](../../bundle/service-app/README.zh.md) — 组合本服务的 profile bundle。
- [Webserver](../../host/webserver/README.zh.md) — 本服务注册其上的 HTTP 路由缝。
- [dsh-headless](../../bundle/headless/README.zh.md) — 采用相同 agent 驱动模式的一次性方案。
- [SDK family](../../sdk/README.zh.md) — 进程内驱动的 stdio JSON-RPC 替代。

-----

<a id="model-experience"></a>
## 模型体验

无：服务把每个任务作为普通用户消息提交，提示词与工具由组合的 base 行负责。

#### KV Cache effect

每个任务是其会话上的一条用户消息。继续的对话复用同一会话日志，因此 provider 的 prompt cache 可跨对话的多个 turn 生效：首 turn 是冷前缀，后续 turn 重新呈现之前的 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明任务服务何时适用、部署必须接受什么。

- **单用户 bearer token** — 一个共享 token 保护整个面；没有用户、租户或按调用方的授权，只能部署在可信主机或自有网关之后。
- **任务结果不跨重启持久** — 内存任务注册表在重启后消失，已完成结果不再可查询，重启前的 `taskId` 也无法解析。但对话可继续：用同一 `sessionId` 提交新任务即可，会话日志从持久层冷恢复。
- **只能取消 turn，不能取消队列** — 已提交但未开始的任务仍会执行其 turn；没有删除或任务列表操作。
- **无并发上限** — 每次提交创建一个 Agent；部署方必须自行约束提交速率。
- **鉴权与进程隔离不在范围内** — bearer token 是唯一的访问控制；按对话划分的工作目录只是 `workspaceRoot` 下的不同路径，但共享主机进程与文件系统命名空间；需要 OS 级沙箱的部署须自行包裹 host。
- **SSE 帧是完整会话事件** — 客户端会收到包括工具调用及其参数在内的所有事件类型；请把该流视为运维级输出，而非公开 API 载荷。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
