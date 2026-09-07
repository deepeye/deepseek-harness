# dsh 任务服务 客户端接口文档

版本:v1.1(2026-09-07)
适用对象:本地 web / desktop 客户端开发
服务形态:`dsh --profile service` 启动的长驻 HTTP 服务

---

## 1. 概述

客户端通过本服务向 deepseek-harness 提交 agent 任务,实时观察执行进度,并取回最终结果。**一次任务(Task)是一轮提交**——由一条任务提示词驱动、对应一个 `taskId`;**一段会话(Session)是可跨轮延续的对话**——由提交时可选的 `sessionId` 命名。同一 `sessionId` 的后续提交续接既有对话(服务端幂等地创建或恢复),每个会话还拥有独立的工作目录 `<workspaceRoot>/<sessionId>`。执行完毕后结果可通过 **查询**、**SSE 流**、**完成回调 webhook** 三种方式获取。

### 1.1 Base URL

```
http://127.0.0.1:{PORT}
```

- 默认端口由服务端环境变量 `DSH_SERVICE_PORT` 决定(`0` 表示随机端口,启动日志可见;建议部署时固定端口)
- 默认只监听 `127.0.0.1`;如需跨机访问可传 `--host 0.0.0.0`,或设置 `DSH_SERVICE_HOST=0.0.0.0`
- 参数优先级:`--host` / `--port` 参数 > `DSH_SERVICE_HOST` / `DSH_SERVICE_PORT` 环境变量 > 默认值(`127.0.0.1` / `0`)

### 1.2 鉴权

所有接口都要求 Bearer Token:

```
Authorization: Bearer {DSH_SERVICE_TOKEN}
```

- token 由服务部署方提供(服务端环境变量 `DSH_SERVICE_TOKEN`)
- 缺失或错误一律返回 `401`,响应体为 `unauthorized`
- 当前为单用户信任模型,请勿将端口暴露给不可信网络;如需对外开放请在自有网关后做二次鉴权

### 1.3 通用约定

| 项 | 约定 |
|---|---|
| 请求体 | `application/json`,上限 1 MiB |
| 响应体 | `application/json; charset=utf-8`(SSE 除外) |
| taskId | 形如 `task-<uuid>` 的字符串,每次提交生成,后续所有接口凭它寻址 |
| sessionId | 形如 `session-<uuid>`,或客户端在提交时自带的 `sessionId`(仅 `[A-Za-z0-9_-]`、≤128 字符);标识一段可续接的对话 |
| 错误响应 | `{"error": "<说明>"}`,个别错误附带额外字段(如 `session/cwd-conflict` 带 `sessionId`) |
| 幂等性 | 每次提交都创建新任务(新 `taskId`、新一轮);携带同一 `sessionId` 则续接既有会话而非新建,但仍产生独立的 task |

### 1.4 服务启动(部署方)

在仓库根目录执行:

```sh
DSH_SERVICE_TOKEN=smoke-token DSH_SERVICE_PORT=18923 pnpm dsh --profile service
# 或显式指定监听
DSH_SERVICE_TOKEN=smoke-token pnpm dsh --profile service --host 0.0.0.0 --port 18923
```

(`pnpm dsh service` 等价于 `node --import tsx/esm apps/cli/src/bin.ts --profile service`)

**启动参数**

| 参数 | 说明 |
|---|---|
| `--host 127.0.0.1 \| 0.0.0.0` | 绑定主机,缺省时回退到 `DSH_SERVICE_HOST`,默认 `127.0.0.1` |
| `--port <port>` | 监听端口,缺省时回退到 `DSH_SERVICE_PORT`,默认 `0`(OS 随机端口) |
| `--help` | 显示帮助 |

**启动环境变量**

| 变量 | 必填 | 说明 |
|---|---|---|
| `DSH_SERVICE_TOKEN` | 是 | bearer token,空值启动即失败。仅环境变量,不设 `--token` 参数(避免被 `ps` 看到) |
| `DSH_SERVICE_PORT` | 否 | 默认 `0`(OS 随机端口);建议固定如 `18923` |
| `DSH_SERVICE_HOST` | 否 | 默认 `127.0.0.1`;`0.0.0.0` 接受远程连接 |
| `DSH_SERVICE_WEBHOOK_URL` | 否 | 全局默认完成回调地址 |
| `DSH_PERMISSION_MODE` | 否 | 沙箱模式,默认 `workspace-write`;`danger-full-access` 放开文件权限 |
| `DEEPSEEK_API_KEY` | 任务需要 | 根目录 `.env` 已配置,启动时自动加载 |

**后台长驻(推荐)**

```sh
DSH_SERVICE_TOKEN=smoke-token DSH_SERVICE_PORT=18923 \
  nohup pnpm dsh --profile service > /tmp/dsh-service.log 2>&1 &
```

公网部署时请置于 TLS 反向代理之后;`--host 0.0.0.0` 启动时会警告明文 HTTP 下 token 可被窃听。

**启动验证**

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18923/tasks
# 期望 401(无 token 被拒)
```

---

## 2. 接口列表

| # | 方法与路径 | 用途 |
|---|---|---|
| 1 | `POST /tasks` | 提交任务 |
| 2 | `GET /tasks/{taskId}` | 查询状态与结果 |
| 3 | `GET /tasks/{taskId}/events` | SSE 实时事件流 |
| 4 | `POST /tasks/{taskId}/cancel` | 取消任务 |

> 注意:没有任务列表、删除、历史接口(GET `/tasks` 返回 404)。服务重启后内存中的任务记录清空,重启前 task 的结果无法再按 `taskId` 查询;但会话日志是持久的——重启后用同一 `sessionId` 再次提交可冷恢复并续接对话(前提是部署的 `workspaceRoot` 与此前一致,否则返回 `409 session/cwd-conflict`)。

---

## 3. 接口详情

### 3.1 提交任务

```
POST /tasks
```

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task` | string | 是 | 任务提示词,非空。agent 会以此为目标执行 |
| `sessionId` | string | 否 | 对话标识,用于续接多轮;仅 `[A-Za-z0-9_-]`、≤128 字符。省略时服务端生成 `session-<uuid>`。续接同一 `sessionId` 即延续既有对话 |
| `webhookUrl` | string | 否 | 本任务的完成回调地址,必须是 `http(s)://` 绝对 URL;未提供时使用服务端默认值 |

**示例**

首轮提交(自带 `sessionId` 以便后续续接):

```sh
curl -X POST http://127.0.0.1:18923/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"task": "阅读仓库 README 并总结要点", "sessionId": "conv-001", "webhookUrl": "https://client.example.com/hook"}'
```

续接同一对话(第二轮):

```sh
curl -X POST http://127.0.0.1:18923/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"task": "基于上面的总结,挑出三条最重要的", "sessionId": "conv-001"}'
```

**响应 `202`**

```json
{"taskId": "task-3f9c2a7e8b1d4c2f", "sessionId": "conv-001", "status": "queued"}
```

每次提交返回独立的 `taskId`(对应这一轮),`sessionId` 标识所属对话。客户端应保存两者:用 `taskId` 查询/SSE/取消这一轮,用 `sessionId` 续接下一轮。省略 `sessionId` 时服务端生成 `session-<uuid>` 并在响应中返回。

**错误**

| 状态码 | 场景 |
|---|---|
| `400` | 请求体不是合法 JSON、`task` 为空、`sessionId` 含非法字符或超长、`webhookUrl` 不是 http(s) URL、体积超限 |
| `409` | 该 `sessionId` 的上一轮仍在运行(`session/agent-busy`);或持久会话记录的工作目录与当前部署不一致(`session/cwd-conflict`,响应体附带 `sessionId`) |
| `500` | 会话冷读失败——日志损坏或不可用(`session/unavailable`) |

---

### 3.2 查询状态与结果

```
GET /tasks/{taskId}
```

**响应 `200`(进行中)**

```json
{"taskId": "task-3f9c2a7e8b1d4c2f", "sessionId": "conv-001", "status": "running"}
```

**响应 `200`(已结束)**

```json
{
  "taskId": "task-3f9c2a7e8b1d4c2f",
  "sessionId": "conv-001",
  "status": "finished",
  "result": {
    "text": "README 的要点如下:……",
    "reason": {"kind": "completed"}
  }
}
```

**`result.reason.kind` 取值**

| 值 | 含义 | 客户端建议处理 |
|---|---|---|
| `completed` | 正常完成 | 展示 `text` |
| `error` | 执行出错(reason 内含 `error.code` / `error.message`) | 展示错误信息,允许重试(重新提交新任务) |
| `max-tokens` | 达到输出上限被截断 | 展示已有文本并提示截断 |
| `aborted` | 被取消(客户端调了 cancel) | 展示"已取消" |
| `blocked` | 被前置检查拒绝(如权限策略) | 展示拒绝原因 |

**错误**

| 状态码 | 场景 |
|---|---|
| `404` | taskId 不存在(含服务重启后记录丢失) |
| `405` | 方法不对 |

**轮询建议**:已接入 SSE 的客户端无需轮询;仅用轮询的客户端建议 1–2s 间隔,直到 `status === "finished"`。

---

### 3.3 SSE 实时事件流

```
GET /tasks/{taskId}/events
```

**响应 `200`**

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
```

每个 SSE 帧承载一个会话事件的完整 JSON:

```
data: {"type":"user/message","seq":3,"time":1756800000000,"data":{…}}

data: {"type":"assistant/chunk","seq":5,"time":1756800000123,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","index":1,"text":"README"}}}

data: {"type":"turn/end","seq":12,"time":1756800004567,"data":{"turn":1,"reason":{"kind":"completed"}}}
```

**行为细节**

- 连接建立后服务端**先回填**该任务已发生的事件,再进入实时推送;`seq` 单调递增,客户端可用它去重
- `turn/end` 是**最后一帧**,服务端随后主动关闭连接——客户端读到该帧即可结束读取
- `assistant/chunk` 事件可增量渲染输出:text-delta 拼接正文、reasoning-delta 拼接思考过程(客户端自行过滤)
- 客户端中途断开无副作用,可重新连接继续接收(从任务第一个事件重新回填)

**常见事件类型(非穷举)**

| type | 含义 |
|---|---|
| `user/message` | 任务提示词入会话 |
| `assistant/chunk` | 模型流式输出 token(正文/思考/工具调用增量) |
| `assistant/message` | 一步的完整助手消息(含 usage) |
| `tool/call` 等工具事件 | 工具调用与结果(注意:含工具参数,属运维级输出) |
| `turn/start` / `step/start` / `step/end` | 轮次与步骤边界 |
| `turn/end` | 终止帧,携带最终 reason |

**错误**

| 状态码 | 场景 |
|---|---|
| `404` | taskId 不存在 |

**浏览器示例**

```ts
async function watchTask(taskId: string, token: string, onEvent: (e: any) => void): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:18923/tasks/${taskId}/events`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (const frame of buffer.split('\n\n').slice(0, -1)) {
      const line = frame.split('\n').find(l => l.startsWith('data: '))
      if (line !== undefined) onEvent(JSON.parse(line.slice(6)))
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
  }
}
```

---

### 3.4 取消任务

```
POST /tasks/{taskId}/cancel
```

**响应 `202`**

```json
{"taskId": "task-3f9c2a7e8b1d4c2f", "sessionId": "conv-001", "status": "cancelling"}
```

取消是异步的:服务端中止当前 turn,随后任务以 `reason.kind === "aborted"` 正常收尾(查询接口与 webhook 均会体现)。SSE 流上会照常出现 `turn/end` 终止帧。

**错误**

| 状态码 | 场景 |
|---|---|
| `409` | 任务已经结束,无需取消 |
| `404` | taskId 不存在 |

---

### 3.5 完成回调 webhook(服务端 → 客户端)

如果提交时携带了 `webhookUrl`(或服务端配置了默认回调),任务结束时服务端会向该地址发起:

```
POST {webhookUrl}
Content-Type: application/json

{"taskId": "task-…", "sessionId": "conv-001", "status": "finished", "result": {"text": "…", "reason": {"kind": "completed"}}}
```

- 客户端回调服务返回任意 `2xx` 即视为投递成功
- 单次投递超时 10 秒,失败后自动重试 2 次(共最多 3 次尝试);全部失败只记服务端日志,**不会影响任务结果**——客户端仍可通过 3.2 查询到结果
- 回调请求没有鉴权头;客户端应在 webhookUrl 中使用带随机串的路径做简单校验

---

## 4. 典型接入流程

**方式 A:SSE(推荐,可看实时进度)**

```
POST /tasks ──► 拿到 taskId ──► GET /tasks/{id}/events(开流)
                                      │
                                      ▼ 读到 turn/end 帧,关闭连接
                              GET /tasks/{id}(可选,取最终结果)
```

**方式 B:轮询(最简)**

```
POST /tasks ──► 拿到 taskId ──► 每隔 1–2s GET /tasks/{id} 直到 status === "finished"
```

**方式 C:webhook(客户端无长连接场景)**

```
POST /tasks(带 webhookUrl)──► 客户端等待回调 ──► 收到 POST 即得结果(失败可兜底查询)
```

**方式 D:多轮对话(续接同一 sessionId)**

```
POST /tasks(带 sessionId="conv-001")──► 拿到 taskId1 ──► … 读到 turn/end,该轮结束
POST /tasks(再带 sessionId="conv-001")──► 拿到 taskId2 ──► 续接同一对话,基于上轮上下文
```

同一 `sessionId` 的提交复用同一段会话日志:首轮在 Host 内是冷前缀,续轮在存活 agent 上直接追加。对同一会话并发提交第二轮会返回 `409 session/agent-busy`,需等上一轮 `turn/end` 后再提交。

四种方式可组合使用。

---

## 5. 已知限制(客户端需感知)

1. **无任务列表/删除接口**——客户端需自行保存 taskId。
2. **服务重启丢 task 记录、会话可冷恢复**——重启前 task 的结果按 `taskId` 查询返回 404;但会话日志持久落盘,重启后用同一 `sessionId` 再次提交可续接对话(部署的 `workspaceRoot` 须与此前一致,否则 `409 session/cwd-conflict`)。建议客户端对 404 做"该轮不存在,可重新提交"的兜底提示。
3. **无并发上限**——客户端应自行控制同时在途的任务数。
4. **SSE 帧含完整会话事件**(含工具调用参数)——面向终端用户展示前请做筛选,不要原样透出。
5. **无 TLS**——服务为 plain HTTP,请在反向代理上终结 TLS。
6. **单用户鉴权**——token 泄露即等同完全控制,请妥善保管。
7. **隔离范围为工作目录**——每个会话有独立 `<workspaceRoot>/<sessionId>` 工作目录,但调用方/租户鉴权与按对话的 OS 进程沙箱不在范围内;多租户须在自有网关后做二次鉴权与隔离。

---

## 6. 状态码速查

| 状态码 | 含义 |
|---|---|
| `200` | 查询成功 |
| `202` | 提交/取消已受理(异步生效) |
| `400` | 请求体非法 |
| `401` | token 缺失或错误 |
| `404` | 路径不存在,或 taskId 不存在 |
| `405` | 该路径不支持此 HTTP 方法 |
| `409` | 提交时:该会话上一轮仍在运行(`session/agent-busy`)或工作目录冲突(`session/cwd-conflict`);取消时:任务已结束 |
