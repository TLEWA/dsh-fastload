# 更新日志

记录本项目的所有重要变更。版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

[简体中文](CHANGELOG.md) · [English](CHANGELOG.en.md)

## [Unreleased]

- 接入 Codex PR 公共审阅规则与本仓重点，保留现有 CI、人工批准和发布行为。

### 文档

- 更新日志改为与其他插件一致的布局：`CHANGELOG.md` 为中文主文档，英文版迁移到 `CHANGELOG.en.md`；同步 `ci.config.json` 与 `package.json` 的发布清单。
- 修正 `DSH_FASTLOAD_ENABLED` 文档：设为 `0` 只关闭 Host 端首屏改写与裁剪，Web 端一次后台补齐仍会运行；行为未变，仅让文字与实现一致。

## 0.2.1 — 2026-11-09

### 发布

- 用新版本号重新发布 0.2.0 的内容。npm 在首次发布时创建了
  `0.0.0-stage` 占位版本，导致 0.2.0 没有真正上线（npm/cli#9889）；本次
  发布没有运行时改动。

## 0.2.0 — 2026-11-09

### 新增

- 新增 Web 客户端部分：首帧后如果缩小后的 transcript 比视口短，就自动点一次
  内置“加载更早”，使尾部上下文与 stock 500/50/2 一致。点击复用
  `ChatNavigation.loadEarlier()` 及其视口锚点补偿。
- transcript 已经可滚动时不补齐；每个挂载的 transcript 最多自动翻一页。
- 过滤 reasoning/tool-step 内嵌的 `data-chat-flow` 节点，并在输入空闲窗口后
  才点击。

## 0.1.0 — 2026-11-09

### 新增

- 首个宿主端插件：把会话首次历史页改为最多 100 条消息、至少 40 条、至少 2 个 turn。
- 可选字节预算，只裁掉完整的旧 turn，始终保留最新两个 turn。
- 纯函数分页规划与 Node 测试，覆盖首屏判定、turn 边界裁剪和硬上限回退。
