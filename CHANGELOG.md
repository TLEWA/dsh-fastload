# 更新日志

记录本项目的所有重要变更。版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

[简体中文](CHANGELOG.md) · [English](CHANGELOG.en.md)

## [Unreleased]

### 新增

- **会话预测性预加载（P6，Web 端）。** 鼠标悬停或键盘聚焦侧栏会话行 150 ms 后，
  客户端用 `session/follow({ activate: false })` 预建首屏页并落页缓存；真实点击
  直接命中缓存。被动读取不会激活 Agent、不写会话；队列最多 4 个、串行执行，
  同一会话 10 分钟内只预热一次；延迟窗口内移开指针会取消，已开始的预热跑完即止
  （只读、不激活）。bench 同一会话冷启动实测
  点击到首行 337 ms → 110 ms，Host 日志确认预热请求 `activate=false`、
  点击请求 `activate=true` 且命中页缓存。可用
  `localStorage['dsh-fastload.prewarm'] = '0'` 或 `window.__DSH_FASTLOAD_PREWARM__ = false` 关闭。

## [0.3.1] - 2026-11-12

### 新增

- **会话头索引（P4）。** 宿主包装 `sessionPersistence.readGenerationHeader`，按文件
  `size + mtime` 复用已解析的 zstd 首行，并把一次启动内的重复 `list` 合成一次；索引落盘到
  `<cacheDir>/scan-headers.json`（1.5 秒防抖、原子替换、两万条按 mtime 裁剪）。
  `session/list` 构建从 238.7 ms 降到 82.0 ms（有索引首调），TTL 命中 1.1–1.8 ms。
- **首屏快照缓存（P5）。** 初始页按“协议版本 + sessionId + persistence revision + 页窗口/裁剪配置”
  落盘为 zstd（无 zstd 回退 gzip）。命中先发缓存页，真实 `follow` 在后台构建并只补发
  `seq > cursor` 的事件；cursor 或 `assistantStream.revision` 不一致就丢弃缓存，绝不下发
  第二个 snapshot。缓存页读取 16.9–17.7 ms，同一进程冷建页 583.5 ms。
- **首帧 replay stream 剥离（P8 的一部分）。** `assistant/message.data.stream` 替换为 `[]`，
  页面 2,821,398 → 1,562,989 字节（−44.6%），可见文本逐字相同。
- 新增独立开关 `DSH_FASTLOAD_SCAN_CACHE`、`DSH_FASTLOAD_PAGE_CACHE`、
  `DSH_FASTLOAD_PAGE_CACHE_BYTES`、`DSH_FASTLOAD_PAGE_CACHE_FILES`、
  `DSH_FASTLOAD_CACHE_DIR`、`DSH_FASTLOAD_STRIP_STREAM`；任何异常静默回退到原始路径。
- 新增 `docs/research/dsh-first-open-p1-p8-assessment.md`：P1–P8 逐项核实、实测数据、
  未实施项的原因与上游改造方案。

### 修复

- **空白首屏（rewind 会话）。** 首屏页整段落在 `dsh-rewind-plugin` 的裁剪区间内时，
  节点被全部置为 hidden，页面只剩“加载更早”胶囊。现在：Host 端识别初始页里的
  `/rewind` 命令对，若可见消息为 0 就向前扩一页再派发（`DSH_FASTLOAD_REWIND_AWARE`，
  默认开启，只扩一次、要求页内连续）；Web 端同理优先用内置“加载更早”补页而不是
  重建视图（重建对隐藏内容无效）。bench 实测首行 1 556/1 001/916 ms（含 1 次补页）
  → 813/747/783 ms（0 次补页）。
- **rewind 扩页不再被字节裁剪撤销。** 启用 `DSH_FASTLOAD_MAX_BYTES` 且最新两个 turn
  都被 rewind 隐藏时，扩页找回的可见 turn 会被 `trim` 再次裁掉，首屏仍然空白还多花
  一次历史读取。`trim` 现在接受 `protectSeq`：扩页命中后保护首个可见消息所在的
  turn，连它都超过硬上限就整页不裁；扩页结果只经过这一次受保护的裁剪。
- 首屏快照缓存新增严格校验：页必须是非空 `snapshot`、末条 `seq` 与 cursor 一致，
  否则删除缓存并回退原始加载，避免把坏页发给客户端。
- 缓存命中后发现基线失配或补发事件不连续时，不再静默结束事件流（客户端会停在旧页上
  收不到后续更新），而是删除缓存并让流失败一次；客户端检测到该错误后用
  `session.resync()` 从零重建，重试走原始加载路径。新增三个回归用例覆盖连续补发、
  缺口与基线失配。
- Web 端新增空白诊断与自愈：记录进入窗口、错误与采样时间线，检测到
  “有页 + 有加载更早按钮 + 正文 0 行”时先尝试补页、再退化为重建；默认不再自动
  `location.reload()`，避免确定性场景下反复刷新。诊断埋点由
  `localStorage['dsh-fastload.debug']='1'` 开启。
- 新增 `<cacheDir>/serve.log`（`DSH_FASTLOAD_SERVE_LOG`）：每次 follow 记录一行
  `sid/initial/before/through/max/turns` 与缓存命中、扩展、写页结果，便于离线取证。

### 测试

- 新增 `test/compact.test.js`、`test/page-cache.test.js`、`test/scan-cache.test.js`，
  以及三个客户端流集成用例（只剥离首帧、缓存命中吞掉重复 opening、cursor 追平）；
  `npm test` 共 51 项。

## [0.3.0] - 2026-11-11

- **别的插件保留包装时不再叠加。** 卸载时如果 `follow` 已被另一个插件再包一层、无法覆盖回去，旧包装会
  切换为直通而不是继续保持生效；重新启用只按新配置包一层，不会把上一轮的条数继续压下去。
- 接入 Codex PR 公共审阅规则与本仓重点，保留现有 CI、人工批准和发布行为。

### 修复

- 禁用、卸载或热重载插件时还原宿主 `sessionController.follow` 并清除
  `__dshFastload` 标记；重新启用后立即按当前配置生效，不再出现状态显示未安装、
  旧包装却仍在改写首屏的情况。

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
