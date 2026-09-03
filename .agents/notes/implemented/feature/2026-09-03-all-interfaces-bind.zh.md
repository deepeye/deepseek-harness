# Agent Note：web 与 service profile 的全接口绑定

Status: implemented

[English](2026-09-03-all-interfaces-bind.md) | 中文

## 问题

两个 HTTP 面此前都只绑定 loopback。service profile 暴露了 `DSH_SERVICE_HOST` 但没有命令行参数，且非法的环境变量值会在 bundle patch 表达式里被静默改写为 loopback。web profile 则直接拒绝 `--host 0.0.0.0`——`web-app/src/startup.ts` 里有一条蓄意的 `program.error`，理由是全接口绑定"会把远程代码执行暴露到网络"——因此即便部署方有自己的 TLS 反向代理，公网部署也没有受支持的路径。

## 决策

两个 profile 现在都接受 `--host 0.0.0.0`，依据是既有防线已经承载了公网暴露的威胁模型：

- **web GUI 并非无鉴权。** process-token URL → 签名 cookie 的交换（`dsh-client-connection` 的 browser-auth）对每个 Host API 方法与 WebSocket stream 都设了门槛，因此旧拒绝拦的是*已鉴权*表面的网络可达性，而不是一个开放的表面。
- **浏览器信任栅栏保持显式。** 全接口绑定时只自动信任本机自身的非内部 IPv4 字面量（`resolveLanTrust`）；公网域名或地址必须用 `--trusted-host` 显式声明，保留 DNS rebinding 防护。全接口绑定从不意味着"信任任意 Host 头"。
- **启动警告取代硬拒绝。** 两个 profile 都通过 `dsh-cmdline` 的 internals stderr 通道打印警告：凭据（web：process token 与会话 cookie；service：bearer token）经明文 HTTP 传输、可被窃听，公网部署应置于 TLS 反向代理之后。webserver 没有 TLS 方案；警告如实陈述这一边界，而不是假装这个参数是安全的。

service profile 补上了缺失的参数面：`service-startup` 提供者（镜像 web profile 的 `web-startup`）解析 `--host` 与 `--port`，按 参数 → 环境变量（`DSH_SERVICE_HOST`/`DSH_SERVICE_PORT`，空值视为未设置）→ 默认值（`127.0.0.1`/`0`）的优先级解析，并把结果作为 `serviceStartup` 服务提供给 webserver 行读取。与只发布本次调用所给参数的 web 提供者不同，service 提供者完整拥有解析过程——因此非法的环境变量值现在会在解析期报错并点名变量，而不是被静默改写。`DSH_SERVICE_TOKEN` 刻意不设参数：命令行参数对 `ps` 可见，token 参数会把凭据泄漏给同机的所有用户。

两个提供者现在都在解析期按 webserver schema 的两个字面量（`127.0.0.1`、`0.0.0.0`）校验 `--host`；其他值在任何行激活之前就报使用错误，而不是在 config 加载深处才由 schemastery 失败。

## 考虑过的替代方案

**保留 web 的拒绝，只给 service 加参数。** 否决：拒绝所陈述的风险（远程代码执行）已由鉴权栅栏承载，拥有反向代理的部署方没有理由继续被拦；警告保留了风险陈述，而不是躲在一次拒绝之后。

**全接口 web 绑定前要求二次显式确认（环境变量或强制 `--trusted-host`）。** 否决：task-service 一侧从未要求这种仪式，不对称；且任何公网权威要过栅栏实际上已经必须 `--trusted-host`。

**全接口绑定时自动信任任意 Host 头。** 否决：会拆掉 DNS rebinding 防护；显式 `--trusted-host` 才是有意的声明。

## 后果

`service-app` 不再是仅 patch 的 bundle：`src/startup.ts` 是它第一个运行时插件，patch 在 webserver 行之前插入 `service-startup` 提供者行（webserver 行改为注入 `serviceStartup`），包新增 `commander` 与 `dsh-cmdline` 依赖以及 `./startup` 导出。不变式伴随插件的空安装器理由按新形态重述（不可变的解析值，无可检查的关系）。web startup 测试把拒绝用例替换为接受加警告、非法 host 拒绝用例；service startup 测试覆盖参数、环境回退、优先级、空值视未设置、help 与全部拒绝路径。两个 bundle 的 README 记录参数表、优先级、fail-loud 校验与公网暴露警告。不改动 `SessionEventMap`、agent-loop 或 snapshot 树：启动参数与警告是用户可见的控制台输出，不是模型可见输入，因此不要求新的录制会话 snapshot。
