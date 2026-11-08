# Changelog / 更新日志

## 0.1.0 — 2026-11-09

### English

- Initial host plugin: rewrite the initial session history page to 100 messages / 40 minimum messages / 2 turns.
- Optional byte budget that trims only whole older turns and always keeps the newest two turns.
- Pure planning helpers and Node test coverage for page eligibility, turn-boundary trimming and hard-cap fallback.

### 中文

- 首个宿主端插件：把会话首次历史页改为最多 100 条消息、至少 40 条、至少 2 个 turn。
- 可选字节预算，只裁掉完整的旧 turn，始终保留最新两个 turn。
- 纯函数分页规划与 Node 测试，覆盖首屏判定、turn 边界裁剪和硬上限回退。
