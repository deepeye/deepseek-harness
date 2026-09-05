# Agent Note: 移除 Web 预览版产品徽标

Status: implemented

[English](2026-09-05-remove-web-preview-product-badge.md) | 中文

## 问题

Web 空状态主视觉区曾在标题下方渲染本地化的 `Preview` / `预览版` 徽标，以标明产品处于预发布阶段（[2026-08-05](../../archived/feature/2026-08-05-web-preview-product-badge.md)）。该决策将移除定义为一项产品发布事件：仅当归属产品方明确决定预览阶段结束时徽标才会离开，绝不通过运行时开关。该产品决定现已作出，因此徽标不再代表产品的生命周期身份，必须连同其 locale key 一并移除。

## 决策

预览版产品徽标作为一个整体从 `@deepseek-ai/dsh-client-ui-conversation` 中移除：`EmptyHero.tsx` 中的 `<span className={css.previewBadge}>`、`HeroShell.module.css` 中的 `.previewBadge` 规则及其专用的 `auto` 网格列，以及 `zh` 与 `en` 两套 `conversation` locale 字典中的 `hero.preview` key。主视觉标题（`hero.headline`）与品牌标记插槽保持不变，因此空状态主视觉区只渲染狐狸图标、标题与工作区芯片。

仓库更广义的预发布基础立场——单调的 `SCHEMA_VERSION`、处于 `0` 的 `SESSION_FORMAT_VERSION`，以及“自由重命名并更新所有引用”的假设——保持不变，仍归属首个 tagged release，见 `CLAUDE.md`。本次仅产品身份徽标离开，采用 2026-08-05 决策中“归属产品方明确决定预览阶段结束”这一独立出口，而非等待 git tag。

2026-08-05 决策随本次改动一并归档（冻结），它仍是徽标为何存在以及移除为何是一项产品发布事件的记录。

## 曾考虑的替代方案

**增加运行时或配置开关以隐藏徽标。** 不予采纳：2026-08-05 决策明确拒绝了配置字段（同一产品的两套部署不得展示不同的生命周期身份），且其出口是徽标与 locale key 一并移除，而非隐藏开关。空字符串或遗留的死 key 正是该决策所禁止的开关。

**推迟到首个 tagged release 再移除。** 不予采纳：2026-08-05 决策允许“归属产品方明确决定预览阶段结束”时移除，独立于 git tag。产品决定已作出；保留徽标会错误地将产品呈现为预发布状态。

**现在一并移除整个预发布基础立场。** 不予采纳，超出范围：基础立场是一项独立的、全仓库范围的工作，归属首个 tagged release，应另行改动与决策记录。本次仅移除产品身份徽标。

## 后果

每个新会话在空状态主视觉区呈现相同的预览期后身份；无障碍标题不再包含徽标文字。重新引入预览版徽标需要新的 feature Agent Note；归档的 2026-08-05 决策仍是原始理据的历史记录。`skeleton.client.spec.tsx` 断言标题文字与品牌标记插槽，且从未引用徽标，因此没有任何针对徽标的断言发生变化；`hero.preview` 离开两套字典后，`zh` 与 `en` 的 `conversation` locale 字典仍保持 key 完整。类型检查、lint、聚焦的 `ui-conversation` 测试套件（353 项测试），以及 Agent Note 格式、翻译配对、链接与归档门禁均通过。
