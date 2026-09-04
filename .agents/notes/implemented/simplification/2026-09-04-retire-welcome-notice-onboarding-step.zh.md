# Agent Note: 移除 welcome-notice 引导步骤

Status: implemented

[English](2026-09-04-retire-welcome-notice-onboarding-step.md) | 中文

## 问题

Web 客户端首次运行时弹出版本化「内测声明」（Internal Testing Notice）模态框，以持久化 `ui-onboarding.welcomeNoticeVersion` 字段记录确认状态。该声明向 Harness 开发者公告 0.1 测试阶段，是预发布产物。另一个首次运行弹窗——官方 DeepSeek 凭据步骤——不依赖它。

## 决定

从 `dsh-client-ui-settings-models` 移除 `welcome-notice` 引导步骤：`WelcomeNotice` 组件与 `WelcomeNotice.module.css`、`welcome-store`、`onboarding-copy` 常量、`en` 与 `zh` 各四个 `welcome*` locale 键、`settings.onboarding` 注册，以及两个专项测试（`welcome-notice.client.spec.tsx`、`welcome-store.client.spec.ts`）。`apply.client.spec.ts` 现断言仅一个引导步骤（`deepseek-official`）。

共享的 `OnboardingModal` 外壳保留；DeepSeek 凭据步骤仍在其中渲染。`settings.onboarding` 账本与 `dsh-client-ui-settings-general` 中的外壳投影不变。

从 `dsh-client-ui-settings-general` 宿主 apply 移除持久化 `ui-onboarding` settings namespace 及其 `welcomeNoticeVersion` 字段。该 apply 退化为代码库中 Client-only 包所用的 no-op 宿主桩，并删除随之孤立的 `@deepseek-ai/schemastery` 依赖。客户端 slot catalog 已重新生成。

两个包的 README（中英）已更新，双语对已重新记录。

## 考虑过的替代方案

**保留机制，仅抑制弹窗。** 拒绝，因为这会让组件、store、常量、locale 键与宿主 namespace 成为无消费方的死代码，违反仓库约定。未来的声明可从 git 历史重新引入该机制。

**保留持久化 `ui-onboarding` 宿主 namespace 作为未来的引导事实容器。** 拒绝，原因同上：该 namespace 只有一个消费方，而空的宿主 apply 在本代码库中不是合法的 installer。

**一并移除 DeepSeek 凭据引导步骤。** 拒绝，因为该步骤是另一条首次运行流程（API-key 设置），并非内测声明，且与 `OnboardingModal` 外壳共用。

## 后果

打开 Web 客户端不再显示内测声明；`settings.onboarding` 账本承载一个步骤。此前已确认的回环浏览器携带陈旧的 `ui-onboarding` 分区；namespace 既未注册也无读取方，故其失效，预发布 on-disk 格式策略覆盖此情形。

未来的产品级声明可在有消费方时重新引入版本化步骤及其持久化 namespace。typecheck、lint 与 `doc-sync` 通过，`ui-settings-models` 与 `ui-settings-general` 专项套件通过（253 项测试）。
