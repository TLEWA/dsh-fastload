# DSH 长会话首次打开：CDP 隔离环境 A/B 实测

> 状态：在隔离 DSH profile 中用插件原型落地页预算，并用 CDP 驱动真实 Web GUI 做 A/B；未修改安装版 `D:/DSH/resources/app.asar`，未修改用户原 profile。
>
> **2026-11-09 修正**：此前主结论“P0 100/40/1 把 cd3c 首开从 530.9 ms 降到 265.1 ms”不成立为“公平首开”。追加视觉核对发现该页只有 **267 px 高、可见文本 102 字符**，因为 40 条消息全部落在最后一个失败 turn 里，屏幕上只有“已停止/任务已停止”。正确的 P0 候选是 **100/40/2**：首开 **301.3 ms**，可见文本 **850 字符，与 stock 完全相同**。旧数字保留在 §3.2 作为测量口径反例。
>
> 另一条追加结论：`maxBytes` 原型已落地并实测。它能把 cd3c 压到 600 KB/273 ms，也能把 8501 压到 503 KB/449 ms；但 600 KB 在 cd3c 上会把页面裁成“工具-only 空尾”，可见文本只剩 86 字符。**字节上限必须和“至少两个 turn / 可见内容填充”约束一起用，不能单独作为首屏策略。**

## 0. TL;DR

测试会话：`session-cd3c83f5-2d42-422d-895a-80b3a05a33af`（标题“dsh 切换卡顿性能优化”）。

公平对比（可见文本相同，都是 850 字符）：

| 指标 | stock | P0 100/40/2 | 变化 |
|---|---:|---:|---:|
| 首屏 wire 字节 | 3,424,190 B | 872,394 B | **-74.5%** |
| click → 首条 transcript | 555.4 ms | 301.3 ms | **-45.8%** |
| 最终 DOM 节点 | 9,946 | 4,601 | **-53.7%** |
| transcript anchors | 486 | 168 | **-65.4%** |
| long task 次数 / 总量 | 2 / 310 ms | 2 / 161 ms | **-48.1%** |
| 最大单次 long task | 235 ms | 94 ms | **-60.0%** |
| Host follow-first | 119 ms | 139 ms | 基本不变/噪声 |
| Host stringify | 13.7 ms | 3.7 ms | -73.0% |
| Host ws-send | 165 ms | 11 ms | 见 §3.5 口径 |
| 可见文本字符 | 850 | 850 | **相同** |
| flow 高度 | 2,741 px | 990 px | 仍高于视口 |

关键点：**不是“消息越少越好”**。100/40/1 的 283.5 ms 是空页；100/40/2 多花 18–36 ms，但用户真正看到的内容与 stock 一致，仍比 stock 快 46%。

## 1. 测试环境

- 安装版：DSH 0.2.2-rc.1，build c59d10aff167ad7eefead4b3a9082fb57c8fbfe8
- 隔离 DSH_HOME：`C:/Users/TLEWA/Desktop/DSHs/dsh/.measure-home`
- profile：renderboost，内含真实会话副本
- CLI：`C:/Users/TLEWA/AppData/Local/Programs/dsh/bin/dsh.cmd`
- 启动方式：`--profile renderboost --patch <overlay.yml> --no-open --port <port>`；不写 `web`
- 浏览器：CDP 驱动本机 DSH Web GUI，窗口 1258×802
- 测试日期：2026-11-09

两个 overlay：

- stock：`C:/Users/TLEWA/.dsh/temp-workspaces/9042904a-6548-41a4-8970-3f3f887386ed/disable-render-boost.yml`，只禁用 dsh-render-boost。
- P0：`C:/Users/TLEWA/.dsh/temp-workspaces/9042904a-6548-41a4-8970-3f3f887386ed/p0-page.yml`，禁用 dsh-render-boost，插入 rb-p0。

rb-p0 源码在隔离 profile 内：

- `C:/Users/TLEWA/Desktop/DSHs/dsh/.measure-home/profiles/renderboost/node_modules/rb-p0/index.js`
- `.../rb-p0/package.json`

当前 rb-p0 包装 `sessionController.follow`，支持：

- 初始请求改写 `maxMessages` / `turnWindow`；
- `RB_MAX_BYTES` 开启后，对首个 snapshot 按完整消息组从旧到新裁掉整组，直到 JSON 字节接近目标；
- 至少保留最新一个完整消息组；最新组超过软预算但低于 8 MB 硬上限时保留。

本轮 100/40/2 用 `RB_MAX_BYTES=0`，验证的是“两轮消息窗口”，不是字节上限。maxBytes 单独在 §3.3。

## 2. 测量方法

每次测量都从空白新会话开始，然后点击侧边栏中的目标会话行：

1. 启动一个全新的 DSH Host 进程，使用新的端口，浏览器打开新 origin；这样没有上次会话的 restore，也没有兼容弹窗的 localStorage。
2. 在页面注入测量 helper。
3. `row.click()` 作为 t0，启动 `PerformanceObserver({type:'longtask'})`。
4. 记录：
   - **firstAnchor**：第一个 `[data-chat-anchor-key]` 出现的时刻。它是“结构挂载”，不是 paint，也不是“用户看到第一行字”。
   - **DOM**：5 秒后的 `document.getElementsByTagName('*').length`。
   - **anchors**：`[data-chat-anchor-key]` 数量，是渲染行/锚点，不等同于消息条数。
   - **flowH**：`[data-chat-flow]` 的 bounding height，用来判断页面是否只有一小条。
   - **visibleText**：所有 anchor 中，矩形与聊天视口相交的节点 `innerText` 长度之和；用 76–708 px 作为视口范围。它比 firstAnchor 更接近“用户实际看到多少内容”。
   - **long task**：点击后开始的 >50 ms 主线程任务；记录 start/duration、总和与最大值。
5. Host 侧从 rb-probe 日志读取 follow-call、follow-first、stringify、ws-send 的时间与字节数。

为什么必须加 flowH/visibleText：只看 firstAnchor，会把“页面被裁成空壳”误判成“打开变快”。本轮 100/40/1 就是这种情况。

## 3. 结果

### 3.1 公平主结果：stock vs P0 100/40/2

stock（端口 9895，冷 Host、单实例）：

    wire            3,424,190 B
    firstAnchor     555.4 ms
    anchors         486
    DOM             9,946
    flowH           2,741 px
    visibleText     850 chars
    long tasks      75 ms + 235 ms = 310 ms, max 235 ms
    Host            follow-first 119 ms, stringify 13.7 ms, ws-send 165 ms

P0 100/40/2（端口 9897，冷 Host、单实例）：

    wire            872,394 B
    firstAnchor     301.3 ms
    anchors         168
    DOM             4,601
    flowH           990 px
    visibleText     850 chars
    long tasks      67 ms + 94 ms = 161 ms, max 94 ms
    Host            follow-first 139 ms, stringify 3.7 ms, ws-send 11 ms

两页的可见文本完全相同：都从上一轮 assistant 的同一段话开始，到本轮“已停止/任务已停止”结束；stock 只是额外挂了更早的 4 个 turn，用户在当前视口里看不到。P0 2-turn 页仍然有 990 px 内容高度，高于 600 px 左右的聊天视口，所以滚动条和“加载更早”都在。

收益拆解：

- wire 减少 2.55 MB（-74.5%），Host stringify 从 13.7 ms 降到 3.7 ms，ws-send 从 165 ms 降到 11 ms；
- renderer 少挂 5,345 个 DOM 节点，首条 transcript 提前 254 ms；
- Host follow-first 没有下降（119 → 139 ms），说明日志全量解码/分页仍是固定成本；
- long task 总量从 310 ms 降到 161 ms，最大单次从 235 ms 降到 94 ms。

### 3.2 反例：P0 100/40/1 的 265 ms 是空页

同一会话、同一测量脚本，只把 `minTurns` 从 2 改成 1（端口 9896）：

| 指标 | stock | P0 100/40/1 | P0 100/40/2 |
|---|---:|---:|---:|
| wire | 3,424,190 B | 808,549 B | 872,394 B |
| firstAnchor | 555.4 ms | **283.5 ms** | 301.3 ms |
| anchors | 486 | 157 | 168 |
| DOM | 9,946 | 4,382 | 4,601 |
| flowH | 2,741 px | **267 px** | 990 px |
| visibleText | 850 chars | **102 chars** | 850 chars |
| long task 总量 | 310 ms | 128 ms | 161 ms |
| 最大 long task | 235 ms | 66 ms | 94 ms |

100/40/1 的页面只有 267 px 高，屏幕上只有：

    继续
    已停止
    已停止
    已调用工具并运行了代码
    任务已停止 ...

它把 40 条消息全放进了最后一个失败 turn，而这个 turn 的工具调用默认折叠，所以可视内容只有 102 字符。283.5 ms 这个数字不是“长会话打开快了”，而是“只画了一个空壳”。此前记录的 265.1 ms / 4,382 DOM / 157 anchors 是同一形态，重复测量在 265–284 ms 之间波动；现在统一以 283.5 ms 的直测为准。

结论：**`minTurns:1` 不能作为首屏默认。** 对“最后一个 turn 很短/全是折叠工具调用”的会话，1 个 turn 不足以填满视口；2 个 turn 才稳定带回上一轮的可见上下文。

### 3.3 maxBytes 实测矩阵

rb-p0 在 500/50/2 的 Host 页上做响应级裁剪（Host 仍先分页，再按完整消息组裁掉旧组）。cd3c：

| 配置 | wire | firstAnchor | anchors | DOM | long task | flowH | visibleText |
|---|---:|---:|---:|---:|---:|---:|---:|
| stock 500/50/2 | 3,424,190 | 555.4 ms | 486 | 9,946 | 310 ms | 2,741 | 850 |
| maxBytes 1.5 MB | 1,391,852 | 320.6 ms | 260 | 6,138 | 215 ms | 未测 | 未测 |
| maxBytes 600 KB | 570,953 | 273.5 ms | 136 | 3,863 | 138 ms | **165** | **86** |
| P0 100/40/2 | 872,394 | 301.3 ms | 168 | 4,601 | 161 ms | 990 | 850 |

cd3c 的 600 KB 页虽然 firstAnchor 最快，但 flowH 只有 165 px，和 100/40/1 一样是工具-only 空尾；1.5 MB 页裁到 cutSeq 1082，页面还有可见正文，但比 2-turn 页更重，没有优势。

8501（`session-8501ce1b-1ebd-429b-ad60-e146d14f8713`，“dsh 窗口切换卡顿优化”）：

| 配置 | wire | firstAnchor | anchors | DOM | long task | flowH | visibleText |
|---|---:|---:|---:|---:|---:|---:|---:|
| stock 500/50/2 | 2,944,726 | 605.2 ms | 332 | 7,518 | 317 ms | 未测 | 未测 |
| maxBytes 1.5 MB | 1,389,749 | 639.5 ms | 172 | 4,717 | 354 ms | 未测 | 未测 |
| maxBytes 600 KB #1 | 503,704 | 448.8 ms | 101 | 3,629 | 220 ms | 2,894 | 3,157 |
| maxBytes 600 KB #2 | 503,704 | 462.3 ms | 101 | 3,629 | 211 ms | 2,894 | 3,157 |

8501 的 600 KB 页是“富尾”：最新 turn 本身有大段 Markdown，裁掉旧组后仍能填满视口；两次独立冷开得到 448.8 / 462.3 ms，比 stock 快约 24%。而 1.5 MB 页只裁到 1.39 MB，最新 turn 的关键路径没变，首开反而略慢于 stock（639.5 vs 605.2），说明 **maxBytes 的收益取决于最新 turn 有多重**，不是字节越小越稳。

### 3.4 翻页与数据完整性

- cd3c 600 KB 页：点击“加载更早”后 anchors 136 → 486，DOM 3,863 → 9,950，flowH 165 → 2,741，visibleText 恢复到 2,735；无重复 anchor，按钮仍在（hasMore 仍为 true）。
- cd3c 1.5 MB 页：anchors 260 → 523，DOM 6,138 → 10,528，无重复 anchor，按钮仍在。
- 8501 600 KB 页：anchors 101 → 340，DOM 3,629 → 7,692，无重复 anchor，按钮仍在。

这说明响应级裁剪没有改变 `baseSeq` 语义：客户端用裁剪后第一条 event.seq 继续 `beforeSeq`，翻页能接上，不会因为裁掉记录而出现重复/断层。尚未做的是滚动锚点像素级回归和“连续点 3 次加载更早”的稳定性。

### 3.5 Host 侧拆解

| 阶段 | stock cd3c | P0 100/40/2 | 说明 |
|---|---:|---:|---|
| follow-call → follow-first | 119 ms | 139 ms | 日志读取/分页/snapshot 构造，基本不变；差值在噪声范围 |
| snapshot stringify | 13.7 ms | 3.7 ms | 3.42 MB → 0.87 MB |
| WebSocket send | 165 ms | 11 ms | 大页发送时的缓冲/背压；单次样本，波动大 |

maxBytes 是在 `follow-first` 之后、stringify 之前做响应级裁剪，所以 Host 的 follow-first 不会因为 maxBytes 变小；它额外增加约 10–30 ms 的裁剪时间。正式实现应把字节上限放进 `paginate`，在构造 records 时直接切，避免先构造全页再裁。

结论：

- Host 冷读不是这次收益的来源。页预算只减少 snapshot 序列化和后续传输，不减少从头解压日志的固定成本。
- ws-send 的 165 ms 很可能包含大 buffer 的发送/背压等待，不能简单理解为纯 CPU；但它确实发生在首条 transcript 之前，会推高首开时间。
- 只改页预算无法把首开压到 150 ms 级：Host 仍有约 120–140 ms 的冷读，renderer 仍有约 160 ms 的挂载。

## 4. 解读

1. **公平的页预算确实有效**：在可见内容与 stock 相同的前提下，100/40/2 把首开从 555 ms 降到 301 ms，DOM 减半，long task 减半。这是低风险、可立即落地的第一刀。
2. **只看 firstAnchor 会骗人**：100/40/1 的 283 ms 是空页；任何页预算的验收都必须同时看 flowH 和 visibleText。建议把“首屏可见文本不少于 stock 的 80%”加入回归门槛。
3. **minTurns=2 是首屏的安全底线**：它保证最后一个 turn 前面至少还有一轮可见上下文。对失败/工具-only 的尾 turn，这一点尤其重要。
4. **maxBytes 是兜底，不是主策略**：它能处理“消息少、单组大”的会话（8501），也能把 cd3c 压到 600 KB，但会裁出空尾。正式实现必须加“至少 2 个 turn / 至少 N 个可见字符”的下限，并且只能按完整消息组切。
5. **翻页链路可用**：136→486、101→340 的恢复说明小页不会破坏“加载更早”；但翻页后的滚动锚点、连续翻页仍需正式回归。
6. **Host 侧还有大头**：follow-first 仍在 120–140 ms，P1 尾帧直读、P2 延后 promote/减少重复 restore、P3 seekable 仍是把首开压到 200 ms 以下的必要条件。

## 5. 建议的正式方案

首屏（普通打开）：

- `PAGE_MESSAGES = 40`
- `HISTORY_PAGE_OPTIONS = { maxMessages: 100, turnWindow: { minMessages: 40, minTurns: 2 } }`
- 正常会话**不要**默认加 maxBytes；872 KB 的 2-turn 页已经足够小。
- 只有当 2-turn 页自身超过 1.5 MB 时才启用 maxBytes；切点必须落在完整消息组，且**不得少于 2 个 turn**。
- 如果 2 个 turn 仍超过 1.5 MB，保留 2 个 turn，允许到 8 MB 硬上限；只有超过 8 MB 才在“更老的那个 turn”内部继续裁，当前 turn 必须完整。
- JUMP 必须显式写自己的窗口，例如 `{ maxMessages: 500, maxBytes: 3_000_000, turnWindow: { minMessages: 200, minTurns: 1 } }`，否则会被 `validateHistoryWindow` 的 `minMessages > maxMessages` 拒绝。

验收：

- 首屏 wire ≤ 2 MB，anchors ≤ 250，DOM ≤ 6,000；
- firstAnchor ≤ 400 ms（cd3c 冷 Host）；
- flowH ≥ 聊天视口高度，visibleText ≥ stock 的 80%；
- 无 >200 ms 的单次 long task；
- “加载更早”后 anchors 恢复、无重复 anchor、无 seq 断层；
- 现有 benchmark 不回归。

## 6. 限制

- 主样本只有 cd3c 和 8501 两个会话；冷首次打开各 1–2 个干净样本，绝对值有 ±10%–15% 波动。
- firstAnchor 是结构挂载，不是 paint；visibleText 是 innerText 长度，不是像素级可见面积。它能抓住“空页”这类大问题，但不能替代真实用户感知测试。
- maxBytes 是响应级裁剪原型，不是 Host 源码实现；正式实现还要处理 JUMP 页、连续翻页、sourceEventSeqs 边界和 8 MB 硬上限。
- 42fe 这类 13.99 MB / 16,883 事件的会话没有在本轮重新做 CDP 冷开；其页预算仍只有离线模拟数据。
- 未测真实用户机器上的磁盘冷缓存、Windows Defender、CPU 频率等外部因素；这些会同时影响 stock 和 P0。

## 7. 下一步

1. 把 maxBytes 落到源码：`types.ts` → `validateHistoryWindow` / `paginate` / `history()` → `transport repairRequest` 全链路；加“至少 2 个 turn”下限。
2. 增加可见填充回归：flowH / visibleText / 至少一条非空 assistant 文本；不要只断言 firstAnchor。
3. P1 尾帧直读：已有只读原型，四个会话与全量页 exact；接入 Host 后把冷读从 ~120 ms 降到 ~20–40 ms。
4. P2 延后 promote：把第二次 restore 移出首帧关键路径；pending approval/未闭合 turn 仍立即激活。
5. 补基准：把“胖回合”（单 user turn 内 100–200 条 assistant/tool 消息）、“失败/工具-only 尾 turn”和“combined Web open + activate”加入 `benchmarks/session-open`。
6. 正式实现后重跑：至少 3 次冷开、2 个大会话、1 个 2.9 MB 级会话，记录 p50/p95。

## 附录：可复现资产

- P0 overlay：`C:/Users/TLEWA/.dsh/temp-workspaces/9042904a-6548-41a4-8970-3f3f887386ed/p0-page.yml`
- stock overlay：`C:/Users/TLEWA/.dsh/temp-workspaces/9042904a-6548-41a4-8970-3f3f887386ed/disable-render-boost.yml`
- P0 插件：`C:/Users/TLEWA/Desktop/DSHs/dsh/.measure-home/profiles/renderboost/node_modules/rb-p0/index.js`
- Host 探针日志：`C:/Users/TLEWA/Desktop/DSHs/dsh/.measure-home/rb-probe.log`
- P0 请求/裁剪日志：`C:/Users/TLEWA/Desktop/DSHs/dsh/.measure-home/rb-p0.log`
- 空页反例截图：`C:/Users/TLEWA/.dsh/temp-workspaces/9042904a-6548-41a4-8970-3f3f887386ed/p0-final.png`
- cd3c 600 KB 空尾截图：`C:/Users/TLEWA/.dsh/temp-workspaces/9042904a-6548-41a4-8970-3f3f887386ed/cd3c-600k.png`
- 8501 600 KB 富尾截图：`C:/Users/TLEWA/.dsh/temp-workspaces/9042904a-6548-41a4-8970-3f3f887386ed/8501-600k.png`
