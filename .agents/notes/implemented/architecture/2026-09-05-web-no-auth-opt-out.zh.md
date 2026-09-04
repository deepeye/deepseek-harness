# Agent Note: Web 登录门可选关闭（--no-auth）

Status: implemented

[English](2026-09-05-web-no-auth-opt-out.md) | 中文

## 问题

Web profile 在进程启动令牌交换与签名浏览器会话 cookie 之后为每个 `/api` 请求与 index 设门（见[浏览器令牌认证](2026-08-24-browser-token-authentication.zh.md)）。该门对 loopback 或直接暴露的部署是正确的，但有两种形态需要关闭它：一是厌倦复制带令牌 URL 的本地开发会话，二是由自带认证的 TLS 终止反向代理前置的生产部署。没有退出选项时，第二种形态要么把进程令牌泄露给代理，要么运行代理无法满足的原样门。

## 决策

为 `dsh --profile web` 增加仅限本次调用的 `--no-auth` 标志，为该调用关闭 `BrowserAuth` 门。机制是 connection 插件的 `Config.auth` 布尔字段（默认 `true`）；web-app 启动提供方从 CLI 标志发布 `auth`，bundle-patch 的 connection 行直接读取 `ctx.webStartup.auth`——镜像 webserver 行读取 `webStartup.host` / `port` 的方式——因此 `web-app` 自身的 `Config` 不变，`webRuntime` 也不携带 `auth` 字段。

`auth` 为 `false` 时：

- `BrowserAuth` 不创建 `client-connection/browser-session` 签名密钥；凭据记录保持不动。
- `authenticatedUrl` 返回不带 `?token=...` 的纯根 URL。
- `authorizeIndex` 不经盘问即提供 index；不铸造 cookie。
- `isAuthenticated` 返回 `true`，因此 `HostConnectionService.requestRejection` 跳过 401 路径。Host/Origin 信任栅栏（`isTrustedApiRequest`）仍执行，仍对不可信 Host 返回 403——该退出选项只移除令牌/cookie 认证，绝不动 DNS rebinding / 跨站防御。

非 loopback 绑定（`--host 0.0.0.0`）配 `--no-auth` 被允许，但打印一条不同的 stderr 警告：agent 以无认证状态暴露给每个可达客户端。该警告取代该组合下认证开启时的令牌嗅探警告，因为此时没有可嗅探的令牌或 cookie。service profile 的 bearer-token 门不在范围内，保持不动。

## 验证

`startup.spec.ts` 固定 `--no-auth` 解析、`auth` 服务值、非 loopback 警告文本，以及认证开启时的令牌嗅探警告在 `--no-auth` 下不触发。`browser-auth.host.spec.ts` 固定关闭态：不写密钥、`authenticatedUrl` 干净、`authorizeIndex` 不经盘问即服务、`isAuthenticated` 无条件为 true。`node-half.host.spec.ts` 端到端固定 carrier 行为：403 信任栅栏仍拒绝不可信 Host，loopback Host 无 cookie 即到达桥（无 401），`requestRejection` 对可信 Host 返回 `undefined`。默认 `auth=true` 路径与之前逐字节一致，因此 recorded-session 快照不受影响。

## 曾考虑的替代方案

### 为什么不硬移除？

砍掉 `BrowserAuth` 会让无认证成为默认，包括 `--host 0.0.0.0` 时网络上任何人都能获得完整 agent 控制权。退出选项保留安全默认与带令牌 URL 路径；只有显式标志才扩大访问。

### 为什么不把 `auth` 像 `trustedHosts` 那样经 `webRuntime` 路由？

`trustedHosts` 经 `webRuntime` 是因为它是绑定派生的（LAN IP 字面量在服务器绑定后才采样）。`auth` 仅限本次调用，与绑定无关，因此经 `webRuntime` 路由会凭空发明一个没有绑定理由的字段。connection 行直接读 `webStartup.auth` 镜像 webserver 行直接读 `webStartup.host` / `port`，并使 `web-app` 的 `Config` 与 `apply` 不受影响。

### 为什么不连信任栅栏一起关？

Host/Origin 栅栏是 DNS rebinding 与跨站 CSRF 防御，不是认证层；其自有文件已说明。关掉它会让用户浏览器里任意页面在 loopback authority 上驱动 `/api`。该标志只移除令牌/cookie 认证。

### 为什么不在非 loopback 绑定时拒绝 `--no-auth`？

终止 TLS 并自带认证的反向代理部署合理地需要 `--host 0.0.0.0 --no-auth`。拒绝会阻断该形态。响亮的警告匹配既有 `--host 0.0.0.0` 先例（警告而非拒绝），同时点明更大的影响范围。

## 后果

代价：一条经 `BrowserAuth` 的新逐调用代码路径，bundle patch 中多一个 `webStartup` 表达式，以及一个有文档与警告的形态——非 loopback `dsh web` 以无认证运行，只在自带认证的代理之后才安全。

收益：loopback 开发会话以无令牌可复制的干净 URL 打开，TLS 前置部署可把认证委托给代理而不泄露进程令牌。安全默认与信任栅栏均完好；门关闭时不创建凭据记录。
