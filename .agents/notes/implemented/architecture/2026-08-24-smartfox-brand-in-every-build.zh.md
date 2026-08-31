# Agent Note: SmartFox brand in every build profile

Status: implemented

[English](2026-08-24-smartfox-brand-in-every-build.md) | 中文

## Problem

通过 slot 组合部署品牌（[2026-07-22 slot type chain](2026-07-22-slot-type-chain-implementation.zh.md)，master `319d9a7984`）把侧边栏品牌变成了构建 profile 的关注点：只有 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时，`ui-brand-official` 才填充 `sidebar.brand.mark`、`sidebar.brand.name` 与 `conversation.hero.brand.mark`，通用外壳则回退到仓库标识标签——"DSH Local Build" 加 `DSH_CLIENT_COMMIT_HASH` 徽标。pdmi 的品牌重塑（`a62033e7b3`）确立 SmartFox Harness 为用户可见的产品品牌；合并 master 的 slot 架构之后，所有非 official 构建——也就是全部本地开发——渲染的是仓库标识标签。仓库的统一语言（`CONTEXT.md`）把页面标题、字标与引导文案都归于 SmartFox Harness，只在某个构建 profile 下才出现的品牌与词汇表矛盾，也让本地开发构建看起来像另一个产品。

## Decision

SmartFox 品牌在所有构建中渲染。`ui-brand-official` 无条件填充三个品牌 slot；`DSH_CLIENT_BUILD_PROFILE` 门控从客户端代码中移除。`ui-sidebar` 外壳回退与官方占位者保持一致：`sidebar.brand.mark` 回退到狐狸标记，`sidebar.brand.name` 回退到不含标记的 smartfox 字标，替换掉 "DSH Local Build" 标签，并删除 commit-hash 徽标及其 CSS。构建环境标题默认值遵循同一规则：`DocumentTitle`、vite 的 index 投影和 `apps/web/index.html` 都默认 `SmartFox Harness`。`DSH_CLIENT_BUILD_PROFILE` 与 `DSH_CLIENT_COMMIT_HASH` 保留在 `scripts/client-build-environment.ts` 中，作为 official 产物的构建记录溯源信息；没有任何客户端代码再为呈现读取它们。

## Consequences

- 本地/开发构建与 official 构建渲染完全相同的品牌；只有构建记录能区分它们。
- commit-hash 徽标从 UI 中消失。构建溯源存在于 `.dsh-build/client-build-environment.json`，而不是用户可见的界面。
- `OfficialBrandName` 现在与外壳回退渲染相同的图形（不含标记的字标）。这种重复被接受：占位者仍是文档记载的官方提供者，回退则让通用外壳在没有品牌包加载时保持自洽。
- 想要不同品牌的部署通过 slot 替换占位者；回退和构建 profile 都不再注入仓库标识。

## Testing

- `ui-sidebar` 的规格固定回退对（狐狸标记 svg 加携带 `smartfox` 文本的字标 svg）以及重新生成的 DOM 快照；commit-hash stub 随徽标一起离开规格。
- `ui-brand-official` 的 profile 门控规格随门控删除；注册生命周期规格在无环境 stub 的情况下运行。
- `ui-renderer` 的 document-title 规格在无构建标题路径上期望 `SmartFox Harness`。
- built-boot 冒烟测试通过 viewBox 与其 `smartfox` 文本固定字标，取代旧的"official 字标存在、回退文本不存在"断言对。

## Alternatives considered

- **重塑外壳回退文本，保留 profile 门控** - 否决：通用 `ui-sidebar` 包将以文本形式携带特定品牌，而本地构建仍要依赖构建 profile 才能看到真正的品牌图形；标签与门控的二象性依然存在。
- **保留 "DSH Local Build" 作为本地构建标签（master 的模型）** - 对本仓库否决：词汇表把 SmartFox Harness 定为所有 UI 表面上的用户可见品牌，仓库标识不是品牌；依赖 profile 的双品牌模型重新引入了品牌重塑刚刚消除的混淆。
- **让本地构建运行在 official profile 下** - 否决：依赖开发服务器启动方式的品牌会在每次全新 checkout 时重新出现问题；品牌不应依赖环境配置。
