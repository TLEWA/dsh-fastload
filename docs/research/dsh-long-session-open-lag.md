# DSH 长会话从侧边栏打开卡顿：成因、实测与解决方案

> 状态：研究完成，方案待落地。本文只读分析安装版与公开源码，未修改 `D:/DSH/resources/app.asar`，也未改动用户 profile。
>
> 对象：DSH 桌面版 `0.2.2-rc.1`（build `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`），安装目录 `D:/DSH`。
> 对照源码：`deepseek-ai/deepseek-harness` main `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。
> 日期：2026-11-08（Asia/Shanghai）。
>
> **修订（2026-11-08 晚）：** 本文早期样本（`42fe5de7`，6.54 MB / 204 消息 / 617 ms）是胖尾 turn 的瞬时形态，不是稳定基线；同一会话后来默认页在 1.70–2.03 MB / 50–53 消息之间（真机探针时 1.70 MB，随后脚本 2.03 MB），Host snapshot 约 33 ms。热/冷首次打开的拆分、尾帧直读原型与新的 P0/P1/P2 顺序见 `dsh-long-session-first-open.md`。本文保留原样本作为案例，并在相关表格标注“早期样本”。

## English abstract

An early sample of `42fe5de7` produced a **6.54 MB / 204-message / 6-turn** page and took about **617 ms** to first frame. That page was a transient fat-tail shape: the current default page of the same session is 1.70–2.03 MB / 50–53 messages (1.70 MB at probe time, 2.03 MB in the later script) and its Host snapshot is about 33 ms. The stable finding is that the budget counts only `user/message` and `assistant/message`: tool events, system messages, and UTF-8 bytes are invisible, and `maxMessages: 500` never fires when the turn boundary arrives first.

See `dsh-long-session-first-open.md` for the hot-vs-cold measurements. In short: **P0** byte/turn-aware page budget; **P1** tail-frame read for a genuinely cold Host; **P2** delayed activation / single restore; **P3** transcript virtualization; **P4** log chunking/seekable; **P5** fat-turn, cold-host, and combined-open benchmarks. P0 is the immediate transfer/mount fix; P1 is the main fix for a cold first open.

---

## 1. 结论先行

> 本节以 `42fe` 的早期胖尾页为案例；它不是通用基线。热/冷拆分与当前实测见 `dsh-long-session-first-open.md`。

这次卡顿不是单一原因，而是四层成本在同一个点击里叠加：

1. **首屏页预算只看消息数，不看字节、工具事件和 DOM 成本（主因 A）。**
   当前 `HISTORY_PAGE_OPTIONS` 是 `{ maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }`。`paginate` 只统计 `user/message` 和 `assistant/message`，在第 6 个 turn 边界就切了；本会话 204 条消息 < 500，所以 `maxMessages` 从未触发。结果首屏 1,594 个事件、204 条消息、6 个 turn，wire JSON 6,535,625 B（约 6.54 MB）。这是官方 240-turn fixture 全部内容（3,262,577 B）的 **2.00 倍**，而页内只有 6 个 turn。

2. **同一点击做了冷读 + 两次 Session restore（结构性成本 B）。**
   `Session.open` 先 `follow({ activate: true })`；`WebController.follow` 用 `usingObservation({ projection: true })` 冷读日志并构造 snapshot，然后在 `yield opening` 之前 `retain + dispose + promote`；activation 走 `AgentLoop.resumeWith`，又 `open(write) / read / sessions.prepare` 一次。日志解码有 memo（`COLD_LOG_MEMO_MAX_ENTRIES=2`），通常只解一次，但 `Session.fromRestore`/`prepare` 与逐事件校验做了两次，两个 Session 对象并存，promotion 与首帧竞争。这个设计是有意的（打开即恢复、处理未闭合 turn），但基准没有把它和首屏快照合并计量。

3. **transcript 全量挂载（主因 C）。**
   `ChatFlow` 对 `entries.map` 全量生成 Node/Group seats，没有虚拟化；ui-chat README 明确写 “the transcript itself remains fully mounted”，只有右侧 turn rail 虚拟化。本次大会话 transcript 内 13,445 个 DOM 节点，整页 15,349 个；官方 241-turn 全量 fixture 也只有 17,064 个，本页达到其 **79%**。

4. **wire 冗余（放大器 D）。**
   历史 `assistant/message.data.stream` 合计 1,983,388 B（30.3%），只被 `streamUsage` 用作 usage 回退；`system/message` 合计 532,885 B（8.2%），被 turn/context 逻辑使用，不能直接丢。去掉 stream 能省约 30%，但单独做不够，且会改变 usage 回退语义。

**优先级判断：** P0（页预算）仍是热 Host 下投入产出比最高的修复：实测把 `cd3c` 从 4.19 MB / 404.8 ms 降到 1.49 MB / 301.5 ms，DOM 从 16,059 降到 8,815。但它不解决冷 Host 的全量解码；真正首次打开（`903`，7.07 MB）仍要约 558.8 ms，需要 P1 尾帧直读。P2（activation 延后/单次 prepare）是结构性优化，P2a 风险较低，P2b 需要单独的所有权设计；P3（虚拟化）解决 DOM/挂载，是 500-turn 量级的长期解。

---

## 2. 环境与复现

### 2.1 环境

| 项 | 值 |
|---|---|
| DSH | 桌面安装版 `0.2.2-rc.1` |
| build | `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8` |
| 安装目录 | `D:/DSH` |
| 运行时 checkout | `D:/DSH/resources/app.asar/dsh`（asar 单文件，213 MB） |
| DSH_HOME | `C:/Users/TLEWA/.dsh` |
| Web GUI | `http://127.0.0.1:7305` |
| 自带 Node | `.../dependencies/node/bin/node.exe`，v24.22.1 |
| sessions | 407 个 `.zstd` 文件，合计 243.0 MB |

GitHub main `fcc0ad4` 与安装版在上述关键文件上一致；下文行号以 `fcc0ad4` 为准，安装版 compiled bundle 的行号只作定位参考。

### 2.2 最大会话

文件：
`C:/Users/TLEWA/.dsh/sessions/--C-Users-TLEWA-Desktop-DSHs-opencode-router--/session-42fe5de7-03a3-4628-a004-214ee16de663/session.v4.jsonl.zstd`

| 指标 | 值 |
|---|---|
| 压缩字节 | 13,997,575 |
| 独立 zstd 帧 | 7,670 |
| 解压字节 | 56,671,393 |
| 事件数 | 16,883 |
| parse 错误 | 0 |

> 该会话在调查期间继续增长：最新文件 14,241,406 B、7,724 帧、17,077 事件；上表保留首次测量值，便于复现当时的 6.54 MB 胖尾页。

主要事件类型：`assistant/message` 2,086、`tool/ptc-dispatch` 2,234、`tool/ptc-dispatch-start` 2,234、`step/start` 2,089、`step/end` 2,089、`tool/call` 2,042、`tool/result` 2,042、`job/registered` 804、`job/settled` 804、`user/message` 109、`turn/start` 47。

其他大会话：7.55 / 6.84 / 6.74 / 5.22 / 5.06 MB；>1 MB 的有 69 个，>5 MB 的有 6 个。这说明不是单个畸形文件，而是“长会话 + 胖回合”这一类。

### 2.3 复现方法

1. 打开 DSH Web GUI，侧边栏点击上述 session 行；用 CDP attach，记录 `click` 到首帧的 `performance.now()` 差。
2. 用 `PerformanceObserver({ entryTypes: ['longtask'] })` 记录 renderer 长任务；用 `document.querySelectorAll('*').length` 统计 DOM。
3. 等客户端 Session 驻留后再次点击同一行，区分“首次冷开”与“客户端已缓存”两条路径。
4. 程序化滚到 transcript 顶部，单独观察稳态滚动是否触发长任务。
5. 离线用 Node 逐帧解压日志，按当前 `paginate` 规则模拟不同页预算，计算 records JSON 的 UTF-8 字节。

### 2.4 浏览器实测

| 场景 | 结果 |
|---|---|
| `42fe` 早期胖尾样本（6.54 MB） | `click → 首内容` 约 **617 ms**；transcript 13,445 节点；392 ms long task |
| `cd3c` 默认 4.19 MB（warm Host） | **404.8 ms**；DOM 16,059；anchors 820；long task 103 + 167 ms |
| `cd3c` P0 1.49 MB | **301.5 ms**；DOM 8,815；anchors 420；long task 96 + 102 ms |
| `cd3c` P0 80/40（2.0 MB） | 360.8 ms；DOM 7,650；anchors 343；long task 129 + 118 ms |
| `903` 真正冷开 7.07 MB | **558.8 ms**；DOM 8,020；anchors 371；long task 86 + 102 ms |
| `Pixiv` 1.40 MB | 325.7 ms；DOM 5,504；anchors 186 |
| 同一会话再次点击（已驻留） | 约 **232 ms**；React 挂载 212 ms；`JSON.parse` 仅 9.2 ms |
| 程序化滚到顶部 | 未复现 long task |

结论：首次打开要分两种成本看。Host 已热时 renderer 主导（`cd3c` 404.8 ms 中约 280 ms 在 renderer），页预算可降到 301.5 ms；Host 冷时必须先全量解码日志，`903` 的 558.8 ms 主要花在 Host。`42fe` 的 617 ms 是胖尾页的早期样本，不是通用基线。小会话 340 ms 说明还有约 300 ms 的常数开销（插件、应用壳、IPC），大会话的增量则随页大小和 DOM 量级增长。

---

## 3. 调用链

~~~text
侧边栏点击
  → Session.open
    → events.open(HISTORY_PAGE_OPTIONS)                    client/sessions/session.ts:632
    → transport.follow({ activate: true, assistantStream: true, ... })
                                                           client/transport.ts:179
      → WebController.follow                               web/controller.ts:32
        → usingObservation({ sessionId, projection: true })  web/controller.ts:41
          → cold read: readStoredLog / decodeStoredLog
          → Session.fromRestore                            core/session/src/index.ts:611
          → seed + assertSessionEventEnvelope + validateNext
                                                           core/session/src/index.ts:639-667
        → history tail page: paginate(...)                  history.ts:132
        → opening snapshot                                 web/controller.ts:47
        → if activate && prepared: retain / dispose / promote
                                                           web/controller.ts:62-74
        → yield opening                                    web/controller.ts:75
  → client installWindow → ChatView → ChatFlow
    → ChatFlow entries.map (no virtualization)             ChatFlow.tsx:52
    → useChatViewport reads flow slot direct children
                                                           use-chat-viewport.ts:437-438, 481, 715
  → activation: AgentLoop.resumeWith
    → open(write) / read / sessions.prepare                agent-loop/src/index.ts:787-807
~~~

关键点：

- `HISTORY_PAGE_OPTIONS` 在 `client/sessions/session.ts:54`，`PAGE_MESSAGES=50` 在 `:52`，`JUMP_PAGE_MESSAGES=200` 在 `:57`（以上为改动前；P0 改为 40 / 100 / 1.5 MB，见 §8）。
- `resolveHistoryRequest` 在 `history/controller.ts:245` 校验参数；`history(...)` 在 `:213` 调 `paginate` 并 `pageRecords`。
- `paginate` 在 `history.ts:132`，`entryFor` 在 `:174`，`pageRecords` 在 `:187`。
- `SessionFollowRequest` 的 `activate?: boolean` 在 `types.ts:492`；注释明确 “omission leaves the read passive”。客户端 `transport.ts:179` 硬编码 `activate: true`，所以 Web 打开总是激活。
- `WebController.follow` 的 promotion 在 `yield opening` 之前启动；注释说这是为了让“只取 snapshot 就停止”的 consumer 仍然得到 activation。P2 会改成先 `yield`、再 `setImmediate` 调度；见 §8。
- `AgentLoop.resumeWith` 的第二次 `prepare` 在 `agent-loop/src/index.ts:787-807`；`Session.prepare` 在 `core/session/src/index.ts:1158`。

---

## 4. 首屏页实测数据

以下按 wire records `{ type: 'event', event }` 的 UTF-8 JSON 计算，和 `pageRecords` 的输出形状一致；不同统计口径（是否含 snapshot header/projections）会有几个百分点差异。

| 配置 `(maxMessages / minMessages / minTurns)` | cut | events | messages | turns | records bytes |
|---|---:|---:|---:|---:|---:|
| **500 / 50 / 2（当前）** | 15289 | 1,594 | **204** | 6 | **6,535,625** |
| 100 / 50 / 2 | 16086 | 797 | 101 | 5 | 2,158,445 |
| 100 / 40 / 1 | 16591 | 292 | 40 | 4 | 1,171,536 |
| 150 / 50 / 1 | 15686 | 1,197 | 150 | 5 | 4,026,736 |

当前页的组成：

| 组成 | 字节 | 占页 |
|---|---:|---:|
| `assistant/message.data.stream` | 1,983,388 | 30.3% |
| `assistant/message.data.message` | 900,869 | 13.8% |
| `system/message.data` | 532,885 | 8.2% |
| 其他（tool call/result、turn/step/job 等） | 3,118,483 | 47.7% |
| 合计 | 6,535,625 | 100% |

最大单事件：`system/message` seq 16805，274,769 B（约 25 万字符 system prompt）；seq 16654 258,422 B；assistant/message seq 15480 222,282 B（message 65,874 + stream 153,132）。

对比：

- 当前页 / 官方 240-turn fixture 全部内容 = 6,535,625 / 3,262,577 ≈ **2.00x**。
- 当前页 DOM / 官方 241-turn 全量 DOM = 13,445 / 17,064 ≈ **79%**。
- 当前页只有 6 个 turn，却已经接近官方“全部 240 turn”的 DOM 量级。

> 口径说明：下表是 `42fe` **早期胖尾页**的分页模拟（records-only UTF-8），不是通用基线。同一会话在 2026-11-08 晚默认页已变为 2,029,621 B / 53 消息 / 426 事件；P0 100/40/1+1.5MB 为 1,474,309 B / 41 消息 / 346 事件。新会话的热/冷实测见 `dsh-long-session-first-open.md`。

---

## 5. 根因

### 5.1 根因 A：页预算只看消息数

`history.ts:132` 的倒扫逻辑：

- 从 `end - 1` 往前扫；
- 遇到 `turn/start`：`turns++`，若 `count >= minMessages && turns >= minTurns`，`cut = index` 并 break；
- 只有 `user/message`、`assistant/message` 计入 `count`；
- `count >= maxMessages` 时，`cut` 取当前消息的 `groupStart`（`event.seq` 与 `sourceEventSeqs` 的最小值），避免把消息和它的来源切开。

这带来三个后果：

1. **`maxMessages=500` 对胖回合几乎不起作用。** 本会话第 6 个 turn 边界已经满足 `50 条 + 2 turns`，而总消息只有 204 条，`maxMessages` 永远没机会触发。
2. **工具事件、system 事件、stream 字节完全不计入预算。** 当前页 1,594 个事件里，消息只有 204 条；其余 1,390 个是 tool/step/job/system 事件。它们照样要序列化、过 IPC、被 renderer parse，并生成 DOM。
3. **`pageRecords` 不做 wire 裁剪。** `history.ts:187` 直接 `events.map(entryFor)`；历史 assistant 的 `data.stream` 原样返回，尽管它只用于 usage 回退。

所以“页预算 500 条”在体感上并不是 500 条消息的页，而可能是“6 个 turn、204 条消息、6.5 MB”的页。消息数是一个很弱的代理指标。

### 5.2 根因 B：冷读 + 两次 Session restore

`WebController.follow` 先用 `usingObservation({ projection: true })` 冷读：

- `readStoredLog` / `decodeStoredLog` 解全部 zstd 帧；
- `Session.fromRestore`（`core/session/src/index.ts:611`）构造 Session；
- `prepare`（`:1158`）对每个事件执行 `assertSessionEventEnvelope` 与 `surfaceManager.validateNext`（`:639-667`）。

然后 `activate === true` 时：

- `observation.retain()` 保留 lease；
- `dispose` 原 observation；
- `promote(promotion)` 启动 activation；
- 之后才 `yield opening`；
- activation 的 `AgentLoop.resumeWith`（`agent-loop/src/index.ts:787-807`）又 `open(write)`、`read`、`sessions.prepare` 一次。

日志字节通常只解一次（`COLD_LOG_MEMO_MAX_ENTRIES=2`），但 **Session restore/逐事件校验做了两次**，两个 Session 对象并存。promotion 在首帧之前启动，和 renderer 的 parse/挂载竞争 CPU 与 I/O。

这不是“多余代码”，而是有意的产品语义：打开会话就要恢复 agent、修复未闭合 turn、处理 pending approval。问题在于基准没有把“snapshot 首帧”和“activation”合并计量；代码里也没有把 promotion 移出首帧关键路径。

离线全量脚本的量级（同一台机器，逐帧 zstd + 全量 JSON.parse + 递归 freeze）：7,670 帧 decode 205 ms、56.7 MB parse 174 ms、递归 freeze 96 ms，合计约 475 ms。**这是全量脚本的上界，不是 `follow` 实测**；真机 Host 只构造一页，成本低得多：

| 场景 | 首屏 pages | Host snapshot |
|---|---:|---:|
| `Pixiv` 1.40 MB | 465 records | 26.1 ms |
| `cd3c` 4.19 MB（默认） | 1,652 records | 94.4 ms |
| `cd3c` 100/40 | 813 records | 51.9 ms |
| `42fe` 6.59 MB（早期胖尾） | 1,603 records | 170.0 ms |
| `f5bfe` 7.17 MB（冷，80/40） | 900,609 B | 287.2 ms |

所以 617 ms 不能直接归因于“Host 解了 475 ms 的日志”。热 Host 下 renderer 是主头；冷 Host 下全量解码和 restore 才重新变成主头（`903` 558.8 ms）。注意：Node `zlib.zstdDecompressSync` 只解第一帧，必须按 magic `28 b5 2f fd` 切帧逐帧解码；直接用一次 `zstdDecompressSync` 会得到截断结果。

### 5.3 根因 C：transcript 全量挂载

`ChatFlow.tsx:26` 是 `memo(function ChatFlow...)`，`:52` 对 `entries.map` 生成 `ChatNodeSeat` / `ChatGroupSeat`；`ChatView.tsx:61/202/230` 使用 `useChatScroll`、`columnRef`、`data-chat-flow`。

ui-chat README 第 170 行原文：

> “The turn rail mounts only visible marks, overscan, and the focused mark's neighbors... the transcript itself remains fully mounted.”

也就是说，turn rail 虚拟化了，transcript 没有。`useChatViewport` 还依赖 flow slot 的直接子行：

- `use-chat-viewport.ts:437-438`、`:481`、`:715` 用 `(column.querySelector(':scope > [data-slot="conversation.chat.flow"]') ?? column).children`；
- 锚点用 `[data-chat-anchor-key]`，翻页锚点用 `[data-chat-paging-anchor]`；
- 翻页时先补偿 capped group，再补偿 transcript scrollport；remounted row 用 semantic key 解析。

这解释了为什么“只做 content-visibility”不够：它减少 paint/layout，但 React 仍然创建并保留 13k 个 DOM 节点；`useChatViewport` 的行查询也仍然要面对全部子行。真正要降 DOM，必须虚拟化，并且要保留这些 DOM 契约。

### 5.4 根因 D：wire 冗余

历史 assistant 的 `data.stream` 在页内 1.98 MB（30.3%）。在客户端，它主要被 `streamUsage` 用作 usage 回退（安装包 `client.js` 的 13177/13197 附近）；如果 `data.message.usage` 存在，stream 不是必需的。`system/message` 0.53 MB 被 turn/context 逻辑使用（`client.js` 11544/12045/12060/12071/12110 附近），不能直接丢。

可选优化：历史页的 assistant 消息去掉 `data.stream`，保留 `data.message`；当 `message.usage` 缺失时再保留 stream。这个改动能再省约 30%，但会改变 usage 回退路径，建议作为 P0 之后的独立小改动，不和页预算混在一个 PR。

### 5.5 为什么体感是“卡顿”而不是“慢”

热 Host 的 `cd3c` 首开 404.8 ms 里，long task 为 103 + 167 ms；冷 Host 的 `903` 首开 558.8 ms 里，long task 为 86 + 102 ms；再次点击仍有 212 ms 的挂载 long task。用户感知的不是“网络慢”，而是页面在点击后近半秒无响应，然后一次性出现大量内容。页预算和虚拟化分别砍掉“要传/要解析的内容”和“要挂载的 DOM”，这是体感最直接的两个杠杆。

---

## 6. 排除项

### 6.1 projection cache 不是根因

`C:/Users/TLEWA/.dsh/storages/session_projcache/sessions/session-42fe5de7-....json` 存在；最新为 1,193,891 B，identity 匹配，35 个 row，最大 seq 17076（尾部 17077 附近）。cold open 只回放尾部极少事件，不是每次全量 fold。projcache 目录 434 个文件，最大约 1.19 MB；侧边栏 list 只读 header/projection cache，不打开 cold body。

所以“每次打开都重放全部事件”这个假设不成立；但“冷读 + 两次 prepare”仍然成立，二者不要混淆。

### 6.2 90 个插件是常数开销，不是大会话特异性

profile/plugins 中没有插件替换 `conversation.chat.flow`；ui-chat 的 `transcriptView=detailed`、`performanceUsage=detailed` 只影响展示，不影响挂载量。小会话 340 ms vs 热大会话 404.8 ms、冷大会话 558.8 ms 的差仍然存在，说明插件是背景成本，不是主因。

### 6.3 不是单纯 JSON.parse

第二次点击时客户端 Session 已驻留，`JSON.parse` 只有 9.2 ms，但 React 挂载 long task 仍有 212 ms。把 parse 优化到 0 也解决不了挂载和首开页传输。

### 6.4 不是单纯 zstd decode

逐帧 decode 205 ms 是**全量脚本**的上界，不是 Host `follow` 的实测；即使 decode 免费，胖页的 snapshot 构造、IPC、renderer parse 和 13k DOM 仍然存在。冷 Host 的真问题是它必须先把日志解完才能构造页（`903` 558.8 ms），这正是 P1 尾帧直读要绕开的。

### 6.5 本次没有复现稳态滚动卡顿

程序化滚到顶部没有触发 long task；本次样本的主因是打开/首次挂载。如果用户反馈的是“滚动时卡”，那 P2 的优先级要提前；当前证据不支持把滚动当成主因。

---

## 7. 官方基准的盲区

### 7.1 `benchmarks/long-session-browser`

- 240 个 turn，每个 turn 1 条 user + 1 条 assistant；
- fixture 3,262,577 B；
- 初始 25 个 turn；全量 241 个 turn 时 17,064 DOM；
- open 预算 900 ms，CI 1,125 ms；
- fixture 只有 40 个 tool result、20 个 code fence。

### 7.2 `benchmarks/session-open`

- 127,400 个事件；
- first-history 预算 220 ms，agent-resume 450 ms；
- 但两者是分开测的：first-history 用 `follow({ address })` 不激活，agent-resume 单独 `ctx.agents.resume`。

### 7.3 `apps/web/tests/complex-history.perf.ts`

- 500 个 turn；
- 每 10 个 turn 放 10 个 tools；
- 默认只加载 24 个 turn。

### 7.4 缺什么

- **没有“胖回合”**：一个 user turn 里 100–200 条 assistant/tool 消息；
- **没有 combined Web open + activate**：snapshot 首帧和 promotion 同时发生；
- **没有按字节设预算**：只按消息数/turn 数，无法覆盖 stream/system/tool 的字节；
- **没有把 DOM 量和页字节关联**：240 个 turn 的 fixture 太“瘦”，本会话 6 个 turn 就能到 6.5 MB / 13.4k DOM。

所以官方基准不会拦住这次回归；P4 需要补 fat-turn fixture 和 combined-open 场景。

---

## 8. 解决方案

> 首次打开的完整实测、尾帧原型和回退矩阵见 `dsh-long-session-first-open.md`。本节给可执行顺序，以及与旧版报告的差异：**P0 页预算 → P1 尾帧直读 → P2 activation → P3 虚拟化 → P4 分块/seekable → P5 基准**。

### P0：首屏页预算（立即落地）

1. `packages/api/session-controller/src/history.ts` 增加可选 `maxBytes`：从消息 group 起点按后缀字节收缩，不切 group；至少保留 2 个 turn（2 个完整消息组）；仅当 2-turn 页仍超过 1.5 MB 时才启用；单 group 超过 8 MB 才允许硬切；`hasMore` 仍按 `cut > 0`。
2. `packages/api/session-controller/src/client/sessions/session.ts`：`PAGE_MESSAGES=40`；`HISTORY_PAGE_OPTIONS={maxMessages:100,turnWindow:{minMessages:40,minTurns:2}}`；默认不设 `maxBytes`，只有 2-turn 页 >1.5 MB 时才启用。`JUMP_PAGE_OPTIONS` 必须显式 `{maxMessages:500,maxBytes:3_000_000,turnWindow:{minMessages:200,minTurns:1}}`，否则 `minMessages:200 > maxMessages:100` 会被 `validateHistoryWindow` 拒绝。
3. `types.ts` 的 `SessionPageRequest/SessionFollowRequest` 增加可选 `maxBytes`；`transport.ts` 的 `repairRequest` 透传；`history/controller.ts` 把 `maxBytes` 交给 `validateHistoryWindow` 和 `paginate`。
4. 省略 `maxBytes` 的旧调用保持旧行为；`maxMessages` 仍限制消息数，`maxBytes` 只限制字节。二者不互相替代。

CDP 公平样本（`cd3c`，冷 Host，可见文本相同）：默认 500/50/2 为 3.42 MB / 555.4 ms / 486 anchors / 9,946 DOM；P0 100/40/2 为 0.87 MB / 301.3 ms / 168 anchors / 4,601 DOM，可见文本 850 字符不变。100/40/1 的 283.5 ms 是 267 px/102 字符的空页，不能作为收益。P0 解决“传得多、挂得多”，不解决冷 Host 的全量解码；真正的首次打开仍需 P1。

注意：DOM 由渲染行数决定，不由字节决定。100/40/2 已把 anchors 486→168、DOM 9,946→4,601；`maxBytes` 只压缩旧消息组，不减少最新 turn 的行数。`maxBytes=600KB` 在 `cd3c` 上会裁成 165 px/86 字符空尾，在 `8501` 上则是 2,894 px/3,157 字符的富尾，说明字节上限必须配合 2-turn 下限和可见填充验收。

### P1：尾帧直读（冷首次打开的主修复）

目标：不准备完整 `Session`、不全量解码 7–14 MB 日志，直接从日志尾部帧恢复“最新一页 + cursor + hasMore”。

- 持久化接口：`SessionPersistence` 增加可选 `readTail(id,{maxMessages,maxBytes})`，返回 `{header,inheritedEventCount,events,cursor,hasMore}` 或 `undefined`（表示不可安全尾读，调用方回退）。
- JSONL 实现：`stat` 取 header/revision；读文件；`scanZstdFrames` 只扫帧结构；从最后一帧倒序 `decompressZstdFrame`；拼 JSONL 行并 parse；按 seq 连续性和消息数停止；torn 尾、跨帧行、seq 断裂、parse 失败一律返回 `undefined`。
- 读取层：`SessionObservationReader.observeTail` 用 `stat` 的 header + `readTail` + `sessionProjectionCache.cachedSnapshot(header)`；要求缓存 `asOfSeq === cursor`，否则回退完整 observation。
- `WebController.follow` 只在**初始页、普通 Session、非 live、非 subagent、`inheritedEventCount===0`、无 `beforeSeq/throughSeq`** 时尝试尾读；其余请求保持全量 observation。
- `history` 对尾读页直接使用 `readTail` 的 `cursor/hasMore`；若 `cut===0` 且日志还有更早事件，回退全量。
- 激活不能丢：新增 `promoteById(sessionId)`，在 `yield opening` 之后用 `setImmediate` 调度；失败发 `api-session/error`。live 会话、pending approval、未闭合 turn 仍立即激活。

原型实测（只读脚本，逐字节与全量页一致）：`903` 7.07 MB 全量 decode+parse 183 ms，尾读 P0 仅 17.4+8.9 ms；`42fe` 14.24 MB 全量 486 ms，尾读 22.5+8.8 ms；`cd3c` 7.92 MB 全量 229 ms，尾读 15.5+7.5 ms；`f5bfe` 7.17 MB 全量 305 ms，尾读 39.8+8.9 ms。完整 tail 路径估算 `903` 约 51 ms（decode 29.5 + parse 12.3 + paginate 5.4 + projcache 1.7 + snapshot 2.0），wire 1,357,107 B。目标：7 MB 冷 Host 的 Host 侧 ≤80 ms，click→首内容 ≤350 ms。

回退矩阵：projection cache 缺失/identity 不匹配/`asOfSeq !== cursor`；文件在读取中追加；torn final frame；帧边界切断 JSON 行；seq 不连续；非零 `inheritedEventCount`；live/subagent；任何 `undefined` 都回到现有全量路径。

### P2：activation 移出首帧关键路径 + 单次 restore

P2a（低风险）：`WebController.follow` 目前先 `retain+dispose+promote` 再 `yield opening`。改成 `retain` 后先 `yield opening`，再 `setImmediate` 调度 `promote`；保留“消费者收到 snapshot 后立即停止也仍会激活”的最终语义。pending approval、未闭合 turn、live 会话仍立即激活。

P2b（结构性）：`AgentLoop.resumeWith` 又做一次 `open(write)+read+prepare`，而 `follow` 的 observation 已经 prepare 过一次。把 `observation` 的 prepared `Session` 通过所有权转移交给 agent resume，避免第二次 `Session.fromRestore` 和逐事件校验。`SessionPreparation` 目前只有 `dispose/release`，没有公开 `adopt/take`；需要新增“发布/转移所有权”接口，或让 `SessionStore.adopt` 接受 preparation。不要盲目增大 `preparedSessionCacheSize`：每个大会话的 Session 是几十 MB。

验收：一次打开只发生一次 `fromRestore`/`prepare`；combined Web open+activate ≤1,125 ms；activation 不丢；pending approval 不被延迟。

### P3：transcript 虚拟化

`ChatFlow` 目前对 `entries.map` 全量生成 seat；ui-chat README 明确 transcript 全量挂载，只有 turn rail 虚拟化。包内已有 `@tanstack/react-virtual 3.14.10`，但只用于 TurnNavigator。

建议：升级到 3.16+，用 `anchorTo:'end'`；在 `ChatFlow` 内建立 `useVirtualizer`；保留 `data-chat-flow-key`、`[data-chat-anchor-key]`、`[data-chat-paging-anchor]`；把 Load older/turnSpacer 放到列表外；适配 `useChatViewport` 的行查询、锚点补偿和翻页恢复。备选 `react-virtuoso MessageList`；`content-visibility` 只能作过渡。

验收：500-turn fixture 全量展开后 DOM ≤5k；无 >50 ms long task；文本选择、锚点、翻页、跳转不回归。

### P4：日志与 snapshot 分块

P1 已经覆盖“尾部一页直读”。更长远的解是给 JSONL 增加 `seq → frame/byte` sidecar 或 zstd seekable 索引，让任意 `beforeSeq` 都能直接定位；snapshot 分块传输，避免单条 6 MB 帧；历史 assistant `data.stream` 在 `usage` 存在时可裁剪（本会话 2,086 条全有 `data.usage`，但需保留无 `usage` 时的回退）。

### P5：基准与指标

官方 `long-session-browser` 是 240 turn × 1 user + 1 assistant，没有“一个 turn 里 100–200 条 assistant/tool 消息”的胖回合；`session-open` 的 first-history 不激活，agent-resume 单测，且只取默认 50 条；`complex-history` 每 10 turn 才 10 个 tool。需要补：

- fat-turn fixture：1 个 user turn + 150 条 assistant/tool，含 25 万字符 system prompt；
- cold Host fixture：7–14 MB、数千 zstd 帧、首次打开；
- combined Web open+activate：同一点击里计 snapshot、promote、首帧；
- 指标：页字节、消息数、事件数、DOM、long task、`fromRestore` 次数、Host `follow` 耗时、renderer 首内容时间。

## 9. 验收标准

### P0

- 热 Host 4 MB 会话：wire 页 ≤2 MB、消息 ≤100、DOM ≤9k、click→首内容 ≤350 ms、无 >200 ms long task。
- 胖回合：至少保留一个完整消息 group；单 group 超 1.5 MB 时允许超预算，但必须有 8 MB 硬上限。
- `42fe` / `903` / `f5bfe` 的 P0 页 bytes 与离线脚本逐字节一致；JUMP 仍能取到 500 条 / 3 MB 页，且不被 `minMessages 200 > maxMessages` 拒绝。
- 现有 history/transport 测试与官方基准不回归。

### P1

- 7 MB 冷 Host：Host 尾读 ≤80 ms；click→首内容 ≤350 ms；页与全量路径逐字节一致。
- 回退矩阵全部通过：cache 缺失/过期、torn frame、跨帧行、seq 断裂、live/subagent、非零 inherited、读取中追加。
- activation 不丢；pending approval 和未闭合 turn 不被延迟。

### P2

- 一次打开只发生一次 `fromRestore`/`prepare`；combined open+activate ≤1,125 ms；activation 成功或明确上报失败。

### P3

- 500-turn 全量展开后 DOM ≤5k；无 >50 ms long task；锚点、翻页、选择、跳转不回归。

### P4/P5

- sidecar/seekable 读取任意 `beforeSeq` 与全量页一致；新 fixture 进入 CI，指标可追踪。

## 10. 风险与开放问题

- **尾读正确性**：跨帧 JSON 行、torn 尾、seq 断裂、压缩流边界都必须逐字节验证并回退；不能把“尾读失败”变成“打开失败”。
- **projection cache 一致性**：`asOfSeq` 必须等于尾读 `cursor`；turn 结束写入、live 尾部追加、缓存淘汰都会造成不一致，必须有明确回退。
- **P0 不控制 DOM**：`maxBytes` 只减传输字节；胖回合的 DOM 仍由消息行数决定。7k DOM 目标要靠 80/40 或 P3，不能写进 P0 验收。
- **JUMP 继承陷阱**：改小 `HISTORY_PAGE_OPTIONS.maxMessages` 会让继承它的 `JUMP_PAGE_OPTIONS` 出现 `minMessages > maxMessages`；JUMP 必须显式配置。
- **activation 所有权**：P2b 涉及 SessionPreparation 的所有权转移和 SessionStore；设计不清会把“复用”变成“两个消费者持有同一个未发布 Session”。
- **基准盲区**：官方 fixture 没有胖回合、没有冷 Host、没有 combined open+activate；本机 CI 机器差异大，验收要用中位数 + long task，不只看单次点击。
- **安装版边界**：本报告和补丁是上游草案，没有修改 `D:/DSH/resources/app.asar` 或 profile；真机预算实验是通过页面 WebSocket patch 完成的。

## 11. 附录

### A. 复现脚本（离线页统计）

~~~js
import fs from 'node:fs'
import zlib from 'node:zlib'

const buf = fs.readFileSync(process.argv[2])
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = [0]
for (let i = buf.indexOf(magic, 1); i !== -1; i = buf.indexOf(magic, i + 1)) starts.push(i)
const text = Buffer.concat(starts.map((start, i) =>
  zlib.zstdDecompressSync(buf.subarray(start, starts[i + 1] ?? buf.length)),
)).toString('utf8')
const events = text.split('\n').filter(Boolean).map(JSON.parse)

function paginate(events, maxMessages, minMessages, minTurns) {
  let count = 0, turns = 0, cut = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'turn/start') {
      turns++
      if (count >= minMessages && turns >= minTurns) { cut = i; break }
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    count++
    let groupStart = event.seq
    for (const source of event.sourceEventSeqs ?? []) groupStart = Math.min(groupStart, source)
    if (count >= maxMessages) { cut = groupStart; break }
  }
  return { cut, page: events.slice(cut) }
}

const { cut, page } = paginate(events, 500, 50, 2)
const records = page.map((event) => ({ type: 'event', event }))
console.log({ cut, events: page.length, messages: page.filter((e) =>
  e.type === 'user/message' || e.type === 'assistant/message').length,
  bytes: Buffer.byteLength(JSON.stringify(records)) })
~~~

### B. 浏览器 instrumentation（示意）

~~~js
const longTasks = []
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration))
}).observe({ entryTypes: ['longtask'] })

const start = performance.now()
document.querySelector('[data-session-id="..."]').click()
requestAnimationFrame(() => console.log('first frame', performance.now() - start))
console.log('dom', document.querySelectorAll('*').length, 'longTasks', longTasks)
~~~

### C. 社区与源码链接

- TanStack Virtual Chat: <https://tanstack.com/virtual/latest/docs/chat>
- TanStack Virtual Chat 博客: <https://tanstack.com/blog/tanstack-virtual-chat>
- `anchorTo: 'end'` PR: <https://github.com/TanStack/virtual/pull/1173>
- react-virtuoso MessageList loading older: <https://virtuoso.dev/message-list/tutorial/loading-older-messages/>
- zstd seekable format: <https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md>

### D. 源码定位表

| 主题 | 位置 |
|---|---|
| 页常量 | `packages/api/session-controller/src/client/sessions/session.ts:52-60` |
| 打开/加载更早 | `.../session.ts:419-428`、`:632` |
| wire follow | `packages/api/session-controller/src/client/transport.ts:179`、`:239` |
| 页请求类型 | `packages/api/session-controller/src/types.ts:473`、`:492` |
| 参数校验 | `packages/api/session-controller/src/history.ts:33` |
| 分页 | `packages/api/session-controller/src/history.ts:132-166` |
| records | `.../history.ts:174-187` |
| Host history | `packages/api/session-controller/src/history/controller.ts:213`、`:245` |
| Web follow/promote | `packages/api/session-controller/src/web/controller.ts:32-76` |
| Session restore/prepare | `packages/core/session/src/index.ts:611`、`:1158`、`:639-667` |
| Agent resume | `packages/core/agent-loop/src/index.ts:787-807` |
| observation | `packages/session-query/session-query/src/observation.ts:124`、`:324` |
| projection cache | `packages/session/session-projection-cache/src/index.ts:223` |
| transcript | `packages/client/ui-chat/src/client/chat/ChatFlow.tsx:26-52` |
| viewport | `packages/client/ui-chat/src/client/chat/use-chat-viewport.ts:437-438`、`:481`、`:715` |
