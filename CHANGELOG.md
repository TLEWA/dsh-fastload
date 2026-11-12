# 更新日志

记录本项目的所有重要变更。版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

[简体中文](CHANGELOG.md) · [English](CHANGELOG.en.md)

## [Unreleased]

### 修复

- **启动预热要求可用的 `mainReference`。** `armRestoreSignal` 现在把 `uiWorkspace.mainReference` 的对象形状与可读的字符串 `sessionId` 一并列为启动条件；缺失时预热直接标记 `skipped`（`main-reference-unavailable`），不再订阅选择信号或排队 follow，避免与原生恢复重复构建。回归测试：`skips restore prewarm when uiWorkspace has no live main reference`。
- **空闲刷新构建从入口即可取消。** 构建一开始就创建并登记 `AbortController`；`cache.lookup`、settle 等待、每次 `statRevision` 与首帧读取之后都检查取消与 `active`，会话在准备阶段被销毁时不再 follow 或写缓存，`report.aborted` 只计一次，超时仍按失败计数。回归测试：`a dispose during the page lookup cancels the build before it follows or stores`。
- **构建前读取 Agent 实时状态。** `createCacheRefresh` 接受可选 `statusOf(sessionId)`，`index.js` 传入 `agentStatusReader`；构建入口与 settle 之后各查询一次，`running` 时跳过 follow 并按 `idleMs` 重新排期，`idle`/`unknown` 或查询抛错保持原有放行行为，事件路径的 `agentStatus` 检查不变。回归测试：`reads the live Agent state when the event map is empty`。
- **页缓存命中后关闭流不再遗留调试探针。** `DSH_FASTLOAD_DEBUG=1` 且客户端只读取缓存首帧就 `return()` 时，整个生成器（含缓存 yield）都由 `finally` 停止探针，避免递归 `setImmediate` 持续占用 Host。回归测试：`closing after the cached frame stops the debug lag probe`。
- **启动预热先订阅再发起 follow。** `armRestoreSignal` 先建立 selection 订阅，确认状态仍为 `waiting` 后才排队；订阅抛错时预热标记 failed，不会留下已启动的 follow。回归测试：`does not prewarm when the selection subscription throws`。
- **超时的页缓存读取有界关闭迭代器。** `readOpening` 的 `return()` 最多等待 250 ms 并与超时竞速，随后释放全局 inFlight，超时仍计入失败。回归测试：`a timed-out opening releases the in-flight slot when return never settles`。
- **构建在 settle/stat 之后重新检查 Agent 状态。** 若期间 Agent 转为 running，则跳过 follow 并重新排期。回归测试：`re-checks Agent status after the settle wait`。
- **空闲刷新注册失败时释放已安装监听。** `agent/status` 或 `session/disposed` 订阅抛错时立即 `releaseRefresh()`，再发布 disabled 状态。回归测试：`releases idle refresh listeners when a later registration throws`。
- **异步探测后重新确认队首。** 探测期间队首 Session 被 dispose 或 Agent 转忙而移出队列时，pump 不再误删下一项并构建过期队首，而是重新循环处理当前队首。回归测试：`does not build a cancelled queue head after the load probe`。
- **插件卸载时停止已挂载的渐进懒加载组件。** 还原 slot `component` 不会卸载已渲染的 `FastloadLazyFlow`；现在每个挂载 wrapper 都登记同步 stop 函数，disposer 会取消 rAF/idle、移除 `keydown`/`beforematch` 监听，并让存活的 wrapper 立即回退原生渲染，不再补挂或执行 `flushSync`。回归测试：`the disposer stops mounted wrappers before restoring the slot`。
- **销毁会话时中止在飞构建。** `noteDisposed` 在删除 `runningBuilds` 条目前先 abort 对应 controller，已销毁会话不再占用全局唯一构建槽，也不会在首帧读取释放后继续写缓存。回归测试：`aborts an in-flight capture when the session is disposed`。

### 新增

- **延后真实 follow 改为默认开启（阶段 8 后续决定，未发布）。**
  `DSH_FASTLOAD_DEFER_LIVE_BUILD` 默认值从 `0` 改为 `1`；`0`/`off`/`no` 仍关闭。
  DSH 0.2.2-rc.1 的真实点击打开带 `activate=true`，因此点击路径不会延后，也没有可测
  收益；该开关只对预热、恢复等 `activate:false` 的被动请求最多延后 16 ms。设置
  `DSH_FASTLOAD_DEFER_LIVE_BUILD=0` 即恢复阶段 3 的时序。
- **阶段 4 复审 PoC：折叠组懒挂载（实验，Web 端，默认关闭）。** 新增
  `DSH_FASTLOAD_LAZY_GROUPS`（`localStorage['dsh-fastload.lazy-groups']='1'` 或
  `window.__DSH_FASTLOAD_LAZY_GROUPS__=true`）。只把已完成折叠 process group 里的
  tool-call 节点换成纯文本占位，group 外壳与锚点不变；assistant-step、运行中、交错输入、
  待审批、异常一律走原生 `renderSlot`。实现读取私有
  `ctx.slots.entries('conversation.chat.flow')` 并临时替换 `entry.component`，能力检测
  失败就回退 stock，卸载时仅在仍为本插件 wrapper 时还原。warm host 交替 A/B（n=6）：
  standard normal 点击→首行 481.6→428.6 ms（−11.0%）、DOM 8598→4888；long
  265.9→237.0 ms（−10.9%）、DOM 4114→2869；long 首行长任务 142.5→118.5 ms，但首行后
  多出约 39 ms 的第二个 Long Task（settled 142.5→181.5 ms），总长任务可能增加。
  逐预设矩阵、像素等价、锚点与翻页回归见 `docs/research/stage4-revisit.md`；真实
  `FindInPage` 已验证：结构性揭示通过，但活动匹配/高亮/滚动丢失，且存在误报/漏报。
  节点局部状态保留未验证；默认关闭，仅作为性能实验，不能作为 Ctrl+F 兼容方案。
- **阶段 4 复审对照：渐进补挂（实验，Web 端，默认关闭，本轮 NO-GO）。** 新增
  `DSH_FASTLOAD_LAZY_PROGRESSIVE`（`localStorage['dsh-fastload.lazy-progressive']='1'`
  或 `window.__DSH_FASTLOAD_LAZY_PROGRESSIVE__=true`），两者同时开启时渐进优先。首帧
  先占位，双 `requestAnimationFrame` 后用 `requestIdleCallback` 分片补回原生节点，
  Ctrl/Cmd+F 捕获阶段用 `flushSync` 全量补回。normal/long 首开收益与永久占位同量级
  （normal 576.9→513.8 ms，long 325.4→318.9 ms，n=6），最终 DOM/文本/滚动与 stock 一致；
  normal 补挂约 0.79–0.90 s、long 约 0.13–0.19 s，首开分片最长 19.9 ms。但在 turn rail
  跳转到未加载历史时补挂 12.9 s、产生 93 个 69–110 ms Long Task，同一场景 stock 只有
  1 个 781 ms 任务，按后台长任务判 **NO-GO**，仅保留作对照。

- **阶段 8 最终集成、回归与发布准备（本地分支，未发布）。** 把阶段 2+3+6 集成头与阶段 5
  延后构建、阶段 0 基线、阶段 4 CSS NO-GO 报告合并为 `feat/optimization-final`。13 个可执行
  回归场景中 12 通过、0 失败、1 未执行（子代理来源会话没有 workspace 行，侧栏不可达）；缓存
  命中路径在同一隔离 fixture 与 DSH 0.2.2-rc.1 上各跑 10 次，对比“全部开关关闭 / 全部开启”
  并列出阶段 0 stock 数字。阶段 7 的 7A 客户端校验优化与 7B 私有尾部读取器因没有硬数据
  **不实施**。其他实验开关仍默认关闭（defer 例外，见上一条）；禁用和卸载会经 disposer 还原 follow，热重载依赖
  宿主调用 disposer、本阶段未做真机验证。完整表格、限制和
  未执行项见 `docs/research/plugin-optimization-final-report.md`。
- **客户端核心/诊断分层（阶段 6，Web 端）。** 默认路径不再遍历 React Fiber 采样、
  不保留错误/拒绝/flush/build 日志数组、不包装 `console.error`、不挂载
  `window.__DSH_FASTLOAD__`，也不注册 7 个仅用于 instrument 的延时器。首次导航
  实测注册的 `setTimeout` 8 → 1、事件监听 9 → 7（只保留 P6 与输入空闲所需的 7 个
  document 监听）。补页、Load older 锚点补偿、`/rewind` 空白自愈、错误恢复、P6
  与启动预热的行为和节奏常量（900/700/8/1500 ms）都不变。诊断开关为
  `localStorage['dsh-fastload.diagnostics'] = '1'` 或
  `window.__DSH_FASTLOAD_DIAGNOSTICS__ = true`，**默认关闭**；原型 patch 还需同时
  打开 `dsh-fastload.debug`。`client.js` 源码 1916 → 1962 行、94,098 → 96,408 字节，
  增量来自开关、注释与 `watchEmpty` 的 DOM 先行判定，运行时注册量下降。首次导航
  脚本执行耗时未在真实浏览器中测量。
- **空闲页缓存预热（阶段 3，Host 端，默认关闭）。** 会话静默约 4 秒后，宿主用只读
  `session/follow({ activate: false })` 复用现有建页/裁剪流程，把首屏写入 P5 页缓存。
  构建前后各读一次 `sessionPersistence.stat` 的 revision，不一致就丢弃重建，避免把旧页
  发布到新 revision；同一 session 去重、全局并发 1，Agent 忙碌或 Host 事件循环延迟时推迟。
  刷新请求带内部标记，不经过页缓存服务、不计入缓存命中；不激活 Agent、不写 session
  store、不改原始日志。用 `DSH_FASTLOAD_IDLE_CACHE_REFRESH=1` 开启；真实首开收益本次
  未执行测量。
- **延后真实 follow（阶段 5，Host 端，默认关闭）。** 页缓存命中且请求为初始页、
  `activate !== true`、`assistantStream` 无进行中的 attempt、Agent 已知空闲时，缓存帧发出后
  把真实 `follow` 的构建延后最多 16 ms（切片调度，同 session 新请求、abort 或 Agent 转忙
  立即取消）；任一条件不满足或状态无法判断都保持原时序，延后期间出错回退到阶段 3 的单次
  `setImmediate`。默认关闭时时序、字节和日志与阶段 3 一致；`DSH_FASTLOAD_DEBUG=1` 时
  `serve.log` 增加 `timing` 行（`lookup/send/resume/defer/live/build/stall`），默认路径不读
  时钟。A/B 实测（最终每组 8 次命中，另有每组 16 次的前置块）：真实构建约 4–5 ms，真实
  首帧在缓存帧发出后 11–20 ms 到达，首行在发出后约 170 ms 才出现，未观察到与首帧绘制的
  竞争；开关默认关闭，暂不建议开启。
- **会话预测性预加载（P6，Web 端）。** 鼠标悬停或键盘聚焦侧栏会话行 150 ms 后，
  客户端用 `session/follow({ activate: false })` 预建首屏页并落页缓存；真实点击
  直接命中缓存。被动读取不会激活 Agent、不写会话；队列最多 4 个、串行执行，
  同一会话 10 分钟内只预热一次；延迟窗口内移开指针会取消，已开始的预热跑完即止
  （只读、不激活）。bench 同一会话冷启动实测
  点击到首行 337 ms → 110 ms，Host 日志确认预热请求 `activate=false`、
  点击请求 `activate=true` 且命中页缓存。可用
  `localStorage['dsh-fastload.prewarm'] = '0'` 或 `window.__DSH_FASTLOAD_PREWARM__ = false` 关闭。
- **启动预热（阶段 2，Web 端，默认关闭）。** 页面启动时读取
  `localStorage['dsh.sessions.current']`，在 workspace / sessions 列表仍在加载时用
  同一套只读 `activate: false` follow 预建上次会话的首屏页，不等待列表、不写选择、
  不导航、不建正式 Session。解析失败、空值、子代理地址、已删除/空白会话或拿不到
  UI 选择信号时静默跳过；原生恢复开始打开同一会话（或用户改选）时取消尚未完成的
  预热，只中止本插件自己的只读流。与 P6 共用串行队列和 10 分钟 TTL；成功预热后
  同一标签页 60 秒内不重复。开关与 P6 极性相反：
  `localStorage['dsh-fastload.restore-prewarm'] = '1'` 或
  `window.__DSH_FASTLOAD_RESTORE_PREWARM__ = true` 才开启。真实浏览器基准未执行。

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