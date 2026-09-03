---
description: "dsh 的远程服务 profile bundle：在 dsh-base 之上提供 bearer 鉴权的任务 HTTP 面，供本地 web 与 desktop 客户端使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-service-app

[English](README.md) | 中文

## 概述

`dsh-service-app` 是 `dsh --profile service` 背后的 profile bundle：它在 `dsh-base` 之上叠加远程任务 HTTP 面，让本地 web 或 desktop 客户端能够提交 agent 任务、通过 SSE 观察进度并取回结果。它设定了无人值守的安全姿态——服务不会向任何人请求确认，需要审批的操作一律拒绝——同时沙箱默认仍把文件影响限制在工作区内。该 bundle 插入三行（startup 参数提供者、webserver 与[任务服务](../../api/task-service/README.zh.md)），并重述 approval 与 permission 两行；它唯一的插件就是那个 startup 参数提供者。

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

携带 token 运行 profile；监听主机/端口来自本次调用的参数，参数缺省时回退到对应的环境变量：

```sh
DSH_SERVICE_TOKEN=change-me dsh --profile service
DSH_SERVICE_TOKEN=change-me dsh --profile service --host 0.0.0.0 --port 18923
```

| 参数 | 环境变量 | 默认 | 含义 |
|---|---|---|---|
| — | `DSH_SERVICE_TOKEN` | 必填 | 每个任务服务路由的 bearer token；为空则加载失败（仅环境变量——token 不设参数，否则会被 `ps` 看到） |
| `--port <port>` | `DSH_SERVICE_PORT` | `0` | 监听端口；`0` 表示由操作系统分配 |
| `--host <host>` | `DSH_SERVICE_HOST` | `127.0.0.1` | 绑定主机；`0.0.0.0` 接受远程连接 |
| — | `DSH_SERVICE_WEBHOOK_URL` | — | 服务级默认完成回调地址 |

参数在本次调用中覆盖环境变量；空的环境变量值视为未设置。非法的 `--host`（仅支持 `127.0.0.1` 与 `0.0.0.0`）、`--port`、`DSH_SERVICE_HOST` 或 `DSH_SERVICE_PORT` 值会在启动时报错，而不是被静默改写。全接口绑定时会打印警告：bearer token 经明文 HTTP 传输、可被窃听，公网部署请在 TLS 反向代理之后暴露。

HTTP 面、请求/响应契约以及 SSE 帧由 [`dsh-task-service`](../../api/task-service/README.zh.md) 负责。以 token 作为 bearer 向 `http://127.0.0.1:PORT/tasks` 提交。

### 无人值守权限姿态

profile 把 base 的 `approval` 行替换为 fail-closed 的 `never` 策略，并把默认权限预设固定为 `service` 条目（workspace-write 沙箱、拒绝审批）。无人值守的服务没有人可问，因此预置之外的操作会被拒绝，而不是让任务挂在无人应答的提示上。需要更大权限的部署在自己的 patch 层重述 `defaultPreset`，或在 settings 中切换。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>Implementation internals — click to expand</summary>

本包是 `dsh-base` 之上带一个运行时插件的 patch 列表载体：`cordis.patch.yml` 替换 `approval` 行（`policy: never`）与 `permission` 行（重述 base 的全部预设，外加 `service` 预设与 `defaultPreset: service`），然后插入 `service-startup` 提供者、`webserver` 行（读取提供者解析出的主机/端口）与 `task-service` 行（环境变量驱动的 token 与默认回调）。patch 会整体替换目标行的 config，因此 permission 行必须重述 base 的每个预设。startup 插件完整拥有监听值的解析——参数、环境变量回退、默认值——因此非法的环境变量值会在解析期报错。`src/index.ts` 不导出任何内容；不变式伴随插件注册空安装器，因为提供者发布的解析值不可变、没有可检查的关系。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | `dsh-base` 之上的 service patch |
| [`src/startup.ts`](src/startup.ts) | `service-startup` 提供者：`--host`、`--port`、`--help`、环境变量回退、公网绑定警告 |
| [`src/index.ts`](src/index.ts) | 空模块标记（仅 patch 的 bundle） |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴随插件：无运行时不变式；各行由各自所属包负责 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Bundle package map](../README.zh.md) — 建立在同一核心上的各个表面。
- [dsh-base](../base/README.zh.md) — service profile 运行所依赖的共享核心。
- [dsh-task-service](../../api/task-service/README.zh.md) — 本 bundle 组合的 HTTP 面。
- [dsh-headless](../headless/README.zh.md) — 面向脚本与 CI 的一次性方案。

-----

<a id="model-experience"></a>
## 模型体验

无：bundle 不添加任何模型可见的行；persona、提示词与工具来自它所 patch 的 base 层。

#### KV Cache effect

bundle 不向请求前缀添加任何内容；任务服务把普通用户消息提交进全新会话。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明 service profile 何时适用、部署必须提供什么。

- **必须经 `dsh` 启动器运行** — profile 是 `dsh --profile` 组合；其他启动路径不是受支持的应用入口。
- **token 只来自环境变量** — bearer token 经 `DSH_SERVICE_TOKEN` 提供；bundle 没有凭据文件集成或轮换方案。
- **单用户信任模型** — 该面假设唯一可信调用方；更大范围请在自有网关之后暴露。
- **无 TLS** — webserver 提供 plain HTTP；端口离开主机时请在反向代理上终结 TLS。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
