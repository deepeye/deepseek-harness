# Agent Note：远端已认证编辑 Models 设置（--allow-remote-settings）

Status: implemented

[English](2026-09-05-web-allow-remote-settings.md) | 中文

## 问题

Models 设置页编辑的是 Host 侧拥有的设置文档，因此浏览器侧经 `settings.describe` 通过 Host settings 提供方访问它。settings 基插件（`dsh-client-ui-settings`）在激活时把该提供方的客户端侧持久化固定一次：

```ts
const persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'
```

`isLoopback` 是浏览器对 `location.hostname` 的自评估（localhost、`127.0.0.1`、`::1` 或 `8`/`127` 私网接口）——页面生命周期内固定，且与服务器侧认证状态无关。非 loopback 浏览器——`--host 0.0.0.0` 部署中的公网 IP，或用 `--trusted-host` 声明的 authority——因此得到 `persistence = 'memory'`，`SettingsDescribeMirror` 启动即终态 `unavailable`，`ModelsSettingsStore.load` 报告 *settings are unavailable on a non-loopback connection without --allow-remote-settings*，而非提供方目录。页面仍可加载、对话、运行工具：被门的只是设置数据访问路径，因为它是 UI 唯一直接的 Host 文档变更。

`--no-auth` 与 `--trusted-host` 打开服务器侧 `/api` Host/Origin 信任栅栏；两者都不触及此客户端侧门，且该门并非认证边界——`settings.describe` RPC 已由服务器侧认证把守（BrowserAuth cookie + 信任栅栏）。以 `--host 0.0.0.0 --trusted-host <authority>` 前置公网部署并经打印的 `?token=` URL 认证的操作者仍无法编辑 Models 页，且无标志可移除该门。

## 决策

为 `dsh --profile web` 增加仅限本次调用的 `--allow-remote-settings` 标志，**当 `--auth` 同时开启时**，经既有 `webserver/index-inject` 结构化注入表把一行 `globalThis.__DSH_REMOTE_SETTINGS__ = true` 烤入启动 HTML。settings 基插件在激活时与 `isLoopback` 一并读取该 global：

```ts
const remoteSettingsReadable = (globalThis as ClientRemoteSettingsGlobal).__DSH_REMOTE_SETTINGS__ === true
const persistence = (ctx.remote.$host.isLoopback || remoteSettingsReadable) ? 'host' : 'memory'
```

`ClientRemoteSettingsGlobal` 是 settings 插件本地的读取侧类型化接口——与 `__DSH_TRANSPORT__` / `__DSH_BOOT__` 同一先例（类型化的读取接口 + 裸写入字符串），不是跨平面共享模块。启动入口在任一插件激活前等待 `__DSH_BOOT_READY__`，因此该 global 在 `ui-settings.apply(ctx)` 读取之前即已设置；持久化在启动时固定，无需 mirror 重构、无 wire 协议变更，也无 opening-frame / Typert / `SESSION_FORMAT_VERSION` 牵连。

该标志 fail-loud：`--allow-remote-settings --no-auth` 启动时以 exit 1 拒绝，提示 `error: --allow-remote-settings requires authentication; remove --no-auth to use it, or serve on loopback without the flag`。这是与仅警告的 `--host 0.0.0.0 --no-auth` 路径的刻意分歧：设置编辑是数据变更能力，而非被动暴露，未认证的 `/api` 访问不足以信任。web-app 的 `Config` 增加 `auth` 与 `allowRemoteSettings`（均布尔，默认 `true` / `false`）；bundle-patch 的 `web-runtime` 行两者皆从 `ctx.webStartup` 读取，而 `web-app.apply` 注册一个 `webserver/index-inject` 监听器，仅当 `config.allowRemoteSettings && config.auth` 时才推入该 global 行——该 AND 守住一种将来在 cordis.yml overlay 中直接写 `allowRemoteSettings: true`、却在另一层把 `auth` 关掉的情形。

该退出选项只翻转设置数据访问决策。另两处 `$host.isLoopback` 读取仍仅限 loopback：`ui-settings-general` 的“打开原生设置文档”与 `ui-deliverables` 的“打开产物文件”——两者都是对远端浏览器无意义的桌面可达性动作，非数据访问。

## 验证

`startup.spec.ts` 固定 `--allow-remote-settings` 解析、`allowRemoteSettings` 服务值（单独传入为 `true`，默认为 `false`），以及 `--allow-remote-settings --no-auth` 在 consumer 激活前以 exit 1 拒绝并带 `requires authentication` 消息——镜像 `--host 192.168.1.5` 拒绝用例。`plugin.client.spec.ts` 在 `apply` seam 固定持久化决策：无 global 的非 loopback 浏览器保持 `describe` 未调用（memory，终态 unavailable），而 `globalThis.__DSH_REMOTE_SETTINGS__ = true` 的非 loopback 浏览器读取一次 host 设置（急切 `describe`）。`store.client.spec.ts` 固定改进后的 *…on a non-loopback connection without --allow-remote-settings* 回退字面量。默认路径（退出选项关闭，或 loopback）不推入 global 行，且持久化解析与之前逐位一致，因此启动 HTML 逐字节不变，recorded web 快照不受影响。

## 曾考虑的替代方案

### 为什么不在 `--trusted-host` 上把门？

`--trusted-host` 回答的是另一个问题：“该 Host/Origin authority 是否被 `/api` 信任栅栏接受？”它是可达性与 DNS-rebinding 防御，不是设置变更授权。部署用 `--trusted-host` 声明公网 authority，正是为了让远端浏览器能到达 `/api`；把它与“可编辑设置文档”混淆，会在操作者首次为公网域名伸手时静默放宽数据变更，无独立退出选项、无 fail-loud。设置门需要自己的、唯一目的是设置编辑授权的肯定标志。

### 为什么不扩展 `ConnectionHostInfo` / opening frame？

`RemoteHostFacts`（`{ home, isLoopback }`）是纯客户端侧接口，`isLoopback` 是浏览器自评估——服务器无法推导（它不知道浏览器的 `location.hostname`）。opening frame 上服务器推送的事实只有 `home`；推送“远端设置可读”事实要么需新的 wire/Typert 字段（扩大表面积及 `SESSION_FORMAT_VERSION` 相邻契约），要么塞进既有字段。启动 HTML 的 global 经已烤入 `__DSH_BOOT__` / `__DSH_TRANSPORT__` 的同一通道到达浏览器，无需 wire 事件，且启动时即固定——这恰是持久化决策已依赖的不变量。

### 为什么不把 `remoteSettingsReadable` 放到 `ConnectionHandle` 上？

每次连接轮询的活跃 RPC 会让设置可读性成为每连接属性。但持久化在 `ui-settings.apply` 激活时固定一次、永不重新推导；每连接 RPC 要么读一次（与启动 global 无益），要么引诱重新推导，破坏“持久化启动时固定”不变量，并冒 mirror 未为之构建的运行中 memory→host 翻转风险。启动 global 恰在 `isLoopback` 读取处、同一激活段读取，且不再读取。

### 为什么仍把桌面打开动作仅限 loopback？

`ui-settings-general` 的“打开原生设置文档”与 `ui-deliverables` 的“打开产物文件”调用操作者本地桌面——`open` 式可达性动作，对远端浏览器无意义，且无到达远端机器的服务器侧路径。在 `--allow-remote-settings` 下翻转它们会宣传远端无法成功的动作；设置数据访问路径是三处 `isLoopback` 读取中唯一有远端有意义、服务器侧支撑行为的，故只有它被标志触及。

### 为什么 fail-loud exit 1 而非像 `--host 0.0.0.0 --no-auth` 那样警告？

`--host 0.0.0.0 --no-auth` 警告，是因为终止 TLS 并自带认证的反向代理部署合理地需要未认证本地 `/api` 暴露——警告路径是受支持形态。`--allow-remote-settings` 没有此类受支持的未认证形态：该标志存在是为了让远端浏览器变更设置文档，而 `--no-auth` 让 `/api` 对网络上任何人可达且无身份。警告会让操作者把两者配对并误以为设置编辑仍被把守，实则已敞开。exit 1 使不兼容不可错过，并匹配既有 `--host` / `--port` 拒绝的 `program.error` 先例。

## 后果

代价：一个 CLI 标志及其帮助示例、`web-app` 上两个 `Config` 字段（`auth`、`allowRemoteSettings`）及 patch 行表达式、一个 `webserver/index-inject` 监听器（随 fiber 注册销毁）、一个读取侧类型化 global 与唯一持久化决策中的第二项、fail-loud 检查，以及双语 README + config-catalog + Agent Note 更新。`auth` 现在也是 `web-app` 的 `Config` 字段（此前仅 `connection` 行读 `ctx.webStartup.auth`），这正是该 AND 守卫该在的家。

收益：以 `dsh web --host 0.0.0.0 --trusted-host <authority> --allow-remote-settings` 前置公网部署并打开打印的 `?token=` URL 的操作者，可从远端已认证浏览器编辑 Models 设置页——正是 Aliyun 部署所撞的缺口——而 loopback 默认、信任栅栏与桌面打开动作均不变。fail-loud 的 `--no-auth` 配对与 AND 把守的监听器，把设置变更留在肯定的、已认证的退出选项之后。
