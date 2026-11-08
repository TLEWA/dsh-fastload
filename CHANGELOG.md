# Changelog / 更新日志

## 0.2.1 — 2026-11-09

### English

- Republish the 0.2.0 content under a new version. npm created a staged
  `0.0.0-stage` placeholder for the first publish and never released 0.2.0
  (npm/cli#9889); there are no runtime changes in this release.

### 中文

- 用新版本号重新发布 0.2.0 的内容。npm 在首次发布时创建了
  `0.0.0-stage` 占位版本，导致 0.2.0 没有真正上线（npm/cli#9889）；本次
  发布没有运行时改动。

## 0.2.0 — 2026-11-09

### English

- Add a web-client half: after the first paint, if the reduced transcript is
  shorter than the viewport, press the built-in "Load older" button once so the
  tail context matches stock 500/50/2. The click reuses
  `ChatNavigation.loadEarlier()` and its viewport anchor compensation.
- Skip the fill when the transcript already scrolls; never auto-paginate more
  than one page per mounted transcript.
- Filter out nested reasoning/tool-step `data-chat-flow` nodes and wait for a
  short input-idle window before clicking.

### 中文

- 新增 Web 客户端部分：首帧后如果缩小后的 transcript 比视口短，就自动点一次
  内置“加载更早”，使尾部上下文与 stock 500/50/2 一致。点击复用
  `ChatNavigation.loadEarlier()` 及其视口锚点补偿。
- transcript 已经可滚动时不补齐；每个挂载的 transcript 最多自动翻一页。
- 过滤 reasoning/tool-step 内嵌的 `data-chat-flow` 节点，并在输入空闲窗口后
  才点击。

## 0.1.0 — 2026-11-09

### English

- Initial host plugin: rewrite the initial session history page to 100 messages / 40 minimum messages / 2 turns.
- Optional byte budget that trims only whole older turns and always keeps the newest two turns.
- Pure planning helpers and Node test coverage for page eligibility, turn-boundary trimming and hard-cap fallback.

### 中文

- 首个宿主端插件：把会话首次历史页改为最多 100 条消息、至少 40 条、至少 2 个 turn。
- 可选字节预算，只裁掉完整的旧 turn，始终保留最新两个 turn。
- 纯函数分页规划与 Node 测试，覆盖首屏判定、turn 边界裁剪和硬上限回退。
