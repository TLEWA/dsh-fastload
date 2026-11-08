# DSH 首次打开长会话：为什么慢，以及怎么把首帧压到 400 ms 内

> 状态：**调研 + 只读原型验证，未修改安装版**。本文聚焦“首次打开”的 Host 冷读与首帧路径；通用卡顿分析见 `dsh-long-session-open-lag.md`，补丁草案见 `dsh-long-session-open-lag.patch.md`。
>
> 2026-11-09 补充：已在隔离 profile 用 CDP 完成 P0 页预算的真实 A/B。公平样本（可见文本相同）为 **555.4 → 301.3 ms**；更早的 265.1 ms 来自 100/40/1 的 267 px 空页，不能作为首开结论。环境、口径与限制见 `dsh-cdp-benchmark-results.md`。
>
> 基线：`deepseek-ai/deepseek-harness` main `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；本机安装版 DSH 0.2.2-rc.1，build `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`。行号以源码基线为准；安装版 `app.asar` 内是编译后的 JS，只用于交叉核对。
>
> 测量环境：Windows，DSH Web GUI `http://127.0.0.1:7305`，`DSH_HOME=C:/Users/TLEWA/.dsh`，Node 24.22.1。会话样本：`cd3c83f5`（7.92 MB 日志，4.19 MB 默认首屏，“dsh 切换卡顿性能优化”）、`42fe5de7`（14.24 MB，“自动切换 opencode 服务商”）、`90300455`（7.07 MB，真正冷启动样本，“精简CDP技能并封装工具”）、`f5bfe783`（7.17 MB，从未打开过的冷样本）、`92fc0e84`（1.40 MB，“Pixiv 高级会员插件安装”）。

## English abstract

Opening a long DSH session is not one cost but two: the Host must materialize the log, and the renderer must mount the transcript. On the installed build, a warm-Host 4.19 MB opening page takes about 405 ms click-to-first-content. A later CDP A/B with identical visible text measured 555.4 ms for the stock 3.42 MB page vs 301.3 ms for a 100-message / 40-min / 2-turn page (0.87 MB); a 1-turn page at 283.5 ms was blank and is not a valid result. A truly cold 7.07 MB session takes about 559 ms, of which roughly 300–450 ms is Host log decoding/restoration. A tail-frame prototype decodes only the last N zstd frames, reproduces the full-decode history page byte-for-byte in all tested sessions, and cuts decode + parse from 183–486 ms to 15–48 ms. The recommended sequence is: (P0) a two-turn opening page budget, with a byte cap only as fallback when that page is still over 1.5 MB, (P1) a `readTail` fast path backed by the existing projection cache, (P2) deferring agent promotion until after the opening frame, and (P3) transcript virtualization for DOM/mount cost.

## 1. 结论先行

1. **首次打开有两个成本源，不能只用一个数字概括。**
   - **Host 冷读**：扫描 zstd 帧、逐帧解压、JSON.parse、Session restore/逐事件校验、projection 准备、分页、snapshot 序列化。
   - **Renderer 挂载**：JSON.parse 不是主因（6.5 MB 约 9 ms），主要成本是 React 全量挂载 transcript、布局和样式；大会话 transcript 有 8k–16k DOM。

2. **本机实测把两类成本分开了。**
   - 热 Host（日志已在内存）下，`cd3c` 默认 4.19 MB 页：`click → 首内容` **404.8 ms**，DOM **16,059**，long task **103 + 167 ms**。
   - 同一会话 P0 页（100 条 / 40 条最小 / 1 turn / 1.5 MB）：**301.5 ms**，页 **1.49 MB**，DOM **8,815**，long task **96 + 102 ms**。
   - 真正冷 Host 的 `903`（7.07 MB，之前从未打开）：**558.8 ms**，DOM 8,020，long task 86 + 102 ms。
   - `f5bfe` 冷探针（7.17 MB，只取 80/40/1 页）：Host 侧 **287.2 ms**，页 900,609 B。
   - 说明：热 Host 下页预算能拿回约 **100 ms**；真正冷启动下页预算只省 snapshot/挂载，Host 全量解码仍在，需要 P1 才能把首帧压到 **350–400 ms** 级。

3. **尾帧直读原型已经证明“只读最后若干帧”可行，而且结果与全量解码逐字节一致。**
   - 4 个会话、默认页与 P0 页全部 `exact: true`。
   - P0 页尾解 + 解析：`cd3c` **15.5 + 7.5 ms**；`42fe` **23.5 + 11.9 ms**；`903` **17.4 + 8.9 ms**；`f5bfe` **39.8 + 8.9 ms**。
   - 同会话全量解 + 解析：**229 / 486 / 183 / 305 ms**。尾解省掉 **85%–92%** 的解码/解析时间。
   - 这不是“预取缓存”：它直接服务任意已有会话，不需要新缓存域；projection cache 只用来补齐 projection 行，且要求 `asOfSeq === cursor`，否则回退全量。

4. **页预算不是 DOM 预算。**
   - `maxMessages` 从 500 降到 100，把 `cd3c` 的 anchor 从 820 降到 420，DOM 从 16.1k 降到 8.8k。
   - `maxBytes` 从 2.47 MB 压到 1.49 MB，anchor 仍是 420，DOM 仍是 8.8k；它主要减少传输/序列化/parse，不减少渲染行数。
   - 在 `cd3c` 上把 `maxBytes` 从 1.5 MB 降到 1.0 MB，页仍是 1.49 MB/420 anchors——因为页内第一个完整消息组本身超过 1 MB，按“不切组”规则不能再缩。
   - 因此 P0 的验收应看“页字节 + 时间 + long task”，DOM 目标要么接受约 9k，要么用更小的 `maxMessages`（80/40 实测 7.65k，但单次时间 360.8 ms，噪声较大），要么等 P3 虚拟化。

5. **推荐顺序：P0 页预算 → P1 尾帧直读 → P2 activation 延后/单次 prepare → P3 transcript 虚拟化 → P4 基准补齐。**
   - P0 是低风险、立即见效的传输/挂载修复。
   - P1 才是真正解决“冷 Host 首次打开”的主修复。
   - P2 把第二次 restore 从首帧关键路径移走；P2b 的“单次 prepare”风险高，单独 PR。
   - P3 解决的是 DOM/挂载，不是 Host 冷读；不要把它当成首开唯一方案。

## 2. 测量方法与口径

### 2.1 真机点击

- 用 CDP 复用 DSH Web GUI，点击侧边栏 `data-row-key="session:session-<id>"` 行。
- 时间口径：
  - `click → selected/title`：侧边栏选中态或窗口标题切换；
  - `click → first content`：transcript 首个 `data-chat-anchor-key` 由旧值变为新值（比“出现任意 anchor”更严格，避免把旧内容算进去）；
  - `DOM`：加载完成后的 `document.querySelectorAll('*').length`；
  - `long task`：`PerformanceObserver({entryTypes:['longtask']})`，只报 >50 ms。
- 单击样本存在 ±10%–15% 波动；表中数字用于比较量级，不作为绝对值承诺。

### 2.2 请求改写（只改页面内存，不改文件）

在页面里 patch `WebSocket.prototype.send`，只改写 `session/follow` 的 `maxMessages` / `maxBytes` / `turnWindow`，再调用原 `send`。这样可以在不修改安装版的前提下比较不同页预算。

### 2.3 Host 探针

直接向 `ws://127.0.0.1:7305/api/remote.mux` 发 `{type:'open', endpoint:'session/follow', payload:{args:{request:{...}}}}`，使用 `activate:false`，避免触发 agent 恢复。记录 `send → snapshot` 时间、snapshot 字节、records 数、消息数、cursor 和 `hasMore`。

### 2.4 尾帧原型

`tail-read-probe.mjs`（工作区文件，只读）：
- 扫描 zstd 帧（magic `0xFD2FB528`，解析 FHD / Window_Descriptor / Dictionary_ID / FCS / block header，支持 checksum）；
- 从最后一帧倒序解压，解到消息行数 ≥ `maxMessages + 40`；
- 按帧边界拼回 JSONL 行，校验 seq 连续；
- 用与 `history.ts` 相同的 `paginate` 规则分页，再做 `trimToBytes`（按消息组起点收缩，不切组）；
- 与全量解码的页做逐字节 `sha256` 比较。

脚本只验证“读尾 + 分页”的 CPU 和字节正确性；不含真实 Host 的 Session restore、projection fold、snapshot 序列化，因此表中的尾解时间应视为 P1 的下界，而不是完整 follow 时间。

## 3. 首次打开到底慢在哪

### 3.1 Host 侧

当前 JSONL 持久化没有“尾部读取”能力：`readStoredLog` 未命中 `coldLogMemo` 时，会读整个 `.zstd` 文件，`scanZstdFrames` 扫全部帧，再逐帧解压全部帧，最后 `validateStoredEvents` + `freezeStoredEvents`。所以一个 7–14 MB 的会话，首次打开必然解全部 3.4k–7.7k 帧。

离线单进程量级：

| 会话 | 日志 | 帧 | 事件 | 全量 decode | 全量 parse |
|---|---:|---:|---:|---:|---:|
| `cd3c` | 7.92 MB | 5,183 | 10,444 | 142.3 ms | 86.7 ms |
| `42fe` | 14.24 MB | 7,724 | 17,077 | 281.4 ms | 204.2 ms |
| `903` | 7.07 MB | 3,434 | 7,873 | 112.9 ms | 70.3 ms |
| `f5bfe` | 7.17 MB | 6,385 | 12,584 | 200.4 ms | 104.5 ms |

真实 Host 的 snapshot 时间（含读取、解码、restore、projection、分页、序列化，不含 renderer）：

| 会话 / 请求 | 页字节 | records | 消息 | Host snapshot |
|---|---:|---:|---:|---:|
| Pixiv 默认 | 1,399,013 | 465 | — | **26.1 ms** |
| `cd3c` 默认 500/50/2 | 4,193,892 | 1,652 | 192 | **94.4 ms** |
| `cd3c` 100/40/1（早期原型，无字节预算） | 2,469,614 | 813 | 100 | **51.9 ms** |
| `42fe` 默认（胖尾样本） | 6,594,793 | 1,603 | 207 | **170.0 ms** |
| `f5bfe` 80/40/1（冷 Host） | 900,609 | 447 | 56 | **287.2 ms** |

`f5bfe` 的 287 ms 最能说明“冷”的成本：页只有 0.9 MB，Host 仍要花约 287 ms，因为日志从未解析过。`cd3c` 的 94.4 ms 则是热 Host（之前已打开/被 observation 缓存命中），页 4.19 MB 的 snapshot 构造和传输占主导。

### 3.2 Renderer 侧

- 6.5 MB snapshot 的 `JSON.parse` 实测约 **9.2 ms**，不是瓶颈。
- 主要成本是 React 全量挂载：`ChatFlow` 对 `entries.map` 生成所有节点；`useChatViewport` 直接读 column 子行做锚点补偿；transcript 没有虚拟化。
- 大会话 transcript 有 8k–16k DOM；`cd3c` 默认页 16,059 DOM，P0 页 8,815 DOM，Pixiv 5,504 DOM。
- 挂载阶段出现 96–392 ms 的 long task；页越大，long task 越接近 200–400 ms。
- `content-visibility: auto` 可以减少 paint/layout，但不能减少 DOM/React 节点，只能作为 P3 前的临时缓解。

### 3.3 为什么“42fe 617 ms / 6.54 MB”不能当通用基线

早期样本 `42fe` 的首屏是“最后两个胖 turn”被 `turnWindow 50/2` 切出的 6.54 MB/204 消息页，click→首帧约 617 ms，transcript 13,445 DOM。后来同一会话的默认页变成 1.70 MB/50 消息，Host snapshot 约 33 ms。原因是尾部 turn 的形状变了，固定的消息数预算无法稳定约束字节。

这说明：

- `maxMessages=500` 对“一个 user turn 里 100–200 条 assistant/tool 消息”的胖回合几乎不起作用；
- `turnWindow` 先于 `maxMessages` 触发，页大小随尾部 turn 形状剧烈波动；
- 必须加**字节预算**，并且把它和 `maxMessages` 一起作为分页契约，而不是假设“消息数 ≈ 页大小”。

### 3.4 双击/再次点击不是首次打开

同一会话第二次点击（客户端 Session 已驻留）只需约 232 ms，React 挂载 long task 约 212 ms，`JSON.parse` 约 9.2 ms。首次打开多出来的部分是 Host 冷读 + 首次 snapshot + 首次挂载；优化首次打开不能只优化“再次点击”的路径。

## 4. 真机数据：热 Host 与冷 Host

### 4.1 热 Host（同一浏览器进程，日志已在内存）

| 场景 | 页字节 | click→selected/title | click→first content | DOM | long task |
|---|---:|---:|---:|---:|---|
| `cd3c` 默认 500/50/2 | 4.19 MB | 103.4 ms | **404.8 ms** | 16,059 | 103 + 167 ms |
| `cd3c` 100/40/1 + 1.5 MB（早期原型） | 1.49 MB | 96.0 ms | **301.5 ms** | 8,815 | 96 + 102 ms |
| `cd3c` 80/40/1 + 1.5 MB | 约 1.49 MB | 129.3 ms | **360.8 ms** | 7,650 | 129 + 118 ms |
| `cd3c` 100/40/1 + 1.0 MB | 1.49 MB | 125.8 ms | **399.4 ms** | 8,819 | 125 + 143 ms |
| Pixiv 默认 | 1.40 MB | — | **325.7 ms** | 5,504 | 107 + 133 ms |

`80/40` 与 `100/40` 的差异主要来自 `maxMessages`：80 条把 anchor 从 420 降到 343，DOM 从 8.8k 降到 7.65k；但这一次 80/40 的 360.8 ms 比 100/40 的 301.5 ms 慢，说明单次样本受调度/缓存影响，不能据此断定“更小一定更快”。1.0 MB 与 1.5 MB 的页字节、DOM 完全相同，是因为页内第一个完整消息组超过 1 MB，`maxBytes` 无法再缩。

### 4.2 冷 Host（日志第一次被解析）

| 场景 | 日志 | 页字节 | Host snapshot | click→first content | DOM | long task |
|---|---:|---:|---:|---:|---:|---|
| `903` 默认（真正首次打开） | 7.07 MB | — | 未单独测 | **558.8 ms** | 8,020（峰值 8,601） | 86 + 102 ms |
| `f5bfe` 80/40/1 冷探针 | 7.17 MB | 900,609 | **287.2 ms** | — | — | — |
| `42fe` 默认冷探针（胖尾） | 14.24 MB | 6,594,793 | **170.0 ms** | — | — | — |

`903` 的 558.8 ms 是“真正首次打开”的基准：Host 侧要解 7 MB 日志，renderer 只占约 100 ms。页预算在冷 Host 下主要减少 snapshot/传输/挂载，预计只能把 559 ms 压到约 450 ms；要到 350–400 ms，必须让 Host 不做全量解码。

## 5. P0：字节感知的首屏页预算

### 5.1 变更

- `SessionPageRequest` / `SessionFollowRequest` 增加可选 `maxBytes?: number`；
- `validateHistoryWindow` 校验 `maxBytes` 为正安全整数；
- `paginate` 增加可选 `maxBytes`，先按现有 `maxMessages` / `turnWindow` 得到候选 `cut`，再从页首按**消息组起点**向后收缩；
- 组起点 = 消息自身 index，或 `sourceEventSeqs` 在页内的最小 index；不切开一条消息的 source group；
- 单组超过软预算时允许保留整组；只有单组超过 **8 MB** 才允许按事件硬切；
- `hasMore = bounded > 0`；
- 客户端常量：`PAGE_MESSAGES=40`；`HISTORY_PAGE_OPTIONS={maxMessages:100,turnWindow:{minMessages:40,minTurns:2}}`；默认不设 `maxBytes`，只有 2-turn 页 >1.5 MB 时才启用；
- `JUMP_PAGE_OPTIONS` 必须显式 `maxMessages:500`、`maxBytes:3_000_000`，否则 `minMessages=200 > maxMessages=100` 会被 `validateHistoryWindow` 拒绝；
- `repairRequest` 转发 `maxBytes`，否则客户端常量不会到 Host。

### 5.2 实测页大小

`tail-read-probe.mjs` 用同一套分页规则，对全量解码和尾解都产出页；下表是 P0 页：

| 会话 | 默认页（500/50/2） | 早期原型页（100/40/1 + 1.5 MB） | 尾解 decode + parse |
|---|---:|---:|---:|
| `cd3c` | 4,355,409 B / 192 消息 / 1,652 事件 | **1,490,231 B / 54 / 445** | 15.5 + 7.5 ms |
| `42fe` | 2,029,621 B / 53 / 426 | **1,474,309 B / 41 / 346** | 23.5 + 11.9 ms |
| `903` | 2,841,970 B / 86 / 705 | **1,356,787 B / 38 / 304** | 17.4 + 8.9 ms |
| `f5bfe` | 1,017,533 B / 56 / 447 | **1,017,533 B / 56 / 447** | 39.8 + 8.9 ms |

四个会话的原型页都与全量解码逐字节一致（`exact: true`），`hasMore: true`。`f5bfe` 的默认页本来就在 1.5 MB 以下，所以页不变；这也说明字节预算是“上限”，不是“目标”。

注意：上表验证的是“尾帧读取能得到与全量一致的页”，不是最终首屏参数。CDP 实测中 100/40/1 在 `cd3c` 上只渲染 267 px、102 字符，属于空页；最终推荐改为 100/40/2，见 §5.3。

### 5.3 为什么是 100 / 40 / 2，而不是 500 / 50 / 2

- `minTurns:2` 保证首屏至少带回上一轮可见上下文；`minTurns:1` 在 `cd3c` 上只画出 267 px、102 字符的工具-only 空尾，虽然 firstAnchor 更快，但不是可用的打开结果；
- `minMessages:40` 保证短 turn 也能被包含；
- `maxMessages:100` 防止单个胖 turn 撑出 200+ 消息；
- **默认不加 `maxBytes`**；只有 2-turn 页自身超过 1.5 MB 时才启用，并且不得少于 2 个 turn。`maxBytes=600KB` 在 `cd3c` 上会裁成 165 px/86 字符空尾，在 `8501` 上则是 2,894 px/3,157 字符的富尾，说明字节上限不能单独决定首屏质量；
- 不切消息组保证 tool call / result / assistant message 的上下文完整；超过 8 MB 才允许硬切。

CDP 公平样本中，100/40/2 把 `cd3c` 的首屏从 3.42 MB/486 anchors/9,946 DOM 降到 0.87 MB/168 anchors/4,601 DOM，可见文本仍为 850 字符；firstAnchor 从 555.4 ms 降到 301.3 ms。100/40/1 的 283.5 ms 不能计入，因为页面只有 102 字符。页预算解决“渲染行数/传输字节”，不减少 Host 首次全量解码。

### 5.4 页预算的边界

- **不是 DOM 预算**：DOM 由渲染行/anchor 数决定；100/40/2 的 4,601 DOM 主要来自 168 个 anchor。`maxBytes` 只裁旧消息组，不能减少最新 turn 的行数。
- **可能被单组撑破**：一条 assistant 消息或一个 tool group 本身可能超过 1.5 MB；规则允许整组保留，所以页字节是软上限，8 MB 才是硬上限。
- **可能裁出空尾**：只按字节裁会优先扔掉旧 turn；如果最后一个 turn 全是折叠的工具调用，600 KB 页可能只剩 165 px。必须同时要求至少 2 个 turn，并用 flowH/visibleText 做回归。
- **不是缓存**：它只减少首帧要序列化/传输/挂载的量，不减少 Host 首次全量解码。对热 Host 有效，对冷 Host 只能省一部分。

如果产品坚持 DOM ≤7k：100/40/2 在 `cd3c` 上实测 4,601，已经满足；不需要再降 `maxMessages`。`maxBytes` 只能作为“2-turn 页仍超 1.5 MB”时的兜底，不能用来追求更小 DOM，否则会裁出空尾。真正的 DOM 下限仍要等 P3 虚拟化。

## 6. P1：尾帧直读（真正的冷首开修复）

### 6.1 原型结果

下表是早期 100/40/1 原型页，用于验证“尾帧读取与全量页一致”；最终首屏推荐 100/40/2，见 §5.3。

| 会话 | 早期原型页 | 尾解帧数 | 尾解 decode | 尾解 parse | 与全量页 |
|---|---:|---:|---:|---:|---|
| `cd3c` | 1,490,231 B | 583 | 15.5 ms | 7.5 ms | 逐字节一致 |
| `42fe` | 1,474,309 B | 451 | 23.5 ms | 11.9 ms | 逐字节一致 |
| `903` | 1,356,787 B | 445 | 17.4 ms | 8.9 ms | 逐字节一致 |
| `f5bfe` | 1,017,533 B | 607 | 39.8 ms | 8.9 ms | 逐字节一致 |

同会话全量 decode + parse 是 229 / 486 / 183 / 305 ms；尾解只解最后 445–607 帧，省掉前面的 2.8k–7.3k 帧。

### 6.2 设计

**持久化层（可选能力，不破坏现有实现）：**

~~~ts
readTail?(id, options: {
  maxMessages: number
  maxBytes?: number
}): Promise<{
  header: SessionHeader
  inheritedEventCount: number
  events: readonly SessionEvent[]
  cursor: SessionSeqCursor
  hasMore: boolean
} | undefined>
~~~

JSONL 实现：

1. `stat` 得到 header / revision / size，复用现有 `stat` 的 identity；
2. 读取压缩文件（当前 `readStableJsonlFile` 仍是全文件读，但只做 1–3 ms 的 `scanZstdFrames`，不再解全部帧）；
3. 单独解第一帧得到 header；
4. 从最后一帧倒序 `decompressZstdFrame`，把解出的行按顺序拼回去，处理跨帧行；
5. 解到消息行数 ≥ `maxMessages + 40` 后停止，按 `paginate` 规则算候选页；
6. 用 `trimToBytes` 按组起点收缩；
7. 校验 seq 单调、事件 envelope、torn final frame；任何异常返回 `undefined`，调用方回退全量；
8. 返回 `cursor`、`hasMore` 和页事件。

**Observation / Host 层：**

- 新增 `SessionObservationReader.observeTail(sessionId, request)`：`stat` → `readTail` → `sessionProjectionCache.cachedSnapshot(header)`；
- 要求 `cachedSnapshot` 的 `asOfSeq === cursor`；当前 4 个样本的 projection cache 都满足（35 行、identity 匹配），但 live 会话可能落后，落后就回退；
- 返回一个轻量 `TailObservation`（header / events / cursor / projections），不持有 prepared Session；
- `WebController.follow` 在**初始请求**（`beforeSeq` / `throughSeq` 都为空）、普通 Session、非 subagent、`inheritedEventCount===0` 时先尝试 tail；失败再走现有 `usingObservation`；
- `history()` 对 tail 使用 `hasMore` 覆盖，`cut=0` 且未到日志头时回退；
- `loadOlder` / `jump` 仍然走全量路径，因为它们需要任意历史页；
- tail 路径的 activation 用 `promoteById(sessionId)`，在 `yield opening` 之后 `setImmediate` 调度；不依赖 prepared Session 的 `retain()`。

### 6.3 为什么不是“再加一个 opening cache”

- opening cache 需要新缓存域、写入时机、失效/版本校验和 live 尾部一致性；tail read 复用现有日志 + projection cache，不引入新的持久状态。
- tail read 对“从未打开过、也没有 projcache”的会话仍然需要 fallback；但本机 4 个样本都有 projcache，说明常见路径可命中。
- 如果未来 projcache 命中率不够，再考虑“last opening”缓存；那是 P1.5，不是第一步。

### 6.4 正确性风险

- **跨帧行**：一条 JSONL 事件可以跨 zstd 帧；倒序解码后必须按帧顺序拼行，不能假设一帧一行。
- **torn final frame**：最后一个帧可能不完整；`scanZstdFrames` 返回非空 `tornStart` 时保守回退全量。若未来用 `decompressZstdPrefix` 修复，必须再校验 seq 和行边界，不能把半行当事件。
- **seq 断裂**：tail 从中间开始时，`baseSeq` 不是 0；分页/`hasMore` 要用相对偏移，不能用绝对 seq 当数组下标。
- **source group 越界**：如果页内消息的 `sourceEventSeqs` 指向 tail 起点之前，无法确认组起点；这种情况必须回退全量，或在 tail 里多解一段直到覆盖所有 source。原型样本都通过，但要用胖回合/跨页 tool group 做单测。
- **projection cache 落后**：`asOfSeq !== cursor` 时不能拼一个“旧 projection + 新 events”的 opening；直接回退。
- **live 会话**：有 live agent 时 tail 可能与内存状态不一致；只在非 live 时尝试。
- **activation 语义**：tail 路径没有 prepared Session，必须确保 `promoteById` 能完成恢复；pending approval / 未闭合 turn 不能因为延后而丢失。

## 7. P2：activation 移出首帧关键路径

### 7.1 现状

`WebController.follow` 先 `usingObservation`（prepare 一次），构造 opening，然后在 `yield opening` 之前 `promote`；`AgentLoop.resumeWith` 又 `open(write)`、`read` 全量、`prepare` 一次。首帧与第二次 restore 竞争。

### 7.2 草案

- 全量路径：`observation.retain()` 后不立即 `promote`，先 `yield opening`，再 `setImmediate` 调度 `promote(retained)`；保留 retained lease，consumer 只取 snapshot 也会激活；
- tail 路径：`yield opening` 后 `setImmediate(() => promoteById(sessionId))`；
- 失败必须走 `reportPromotionFailure`（Host logger / session error surface），不能静默吞；
- pending approval / 未闭合 turn 仍应尽快激活；`setImmediate` 只让出当前 tick，不跨 I/O。
- 单次 prepare（P2b）：让 activation 复用 observation 的 prepared Session，需要 `SessionPreparation` 所有权转移 / `SessionStore.adopt`；涉及 lease、取消、错误合并，单独 PR，不和 P2a 混。

预期：P2a 不移除 Host 冷读，但把第二次 restore 从首帧前移走；对热 Host 的首帧竞争有收益，对冷 Host 收益有限。真正的冷首开收益来自 P1。

## 8. P3：transcript 虚拟化

- 在 `ChatFlow` 内用 `useVirtualizer`，只渲染可视行 + overscan；
- 保留 `data-chat-flow-key`、`data-chat-anchor-key`、`data-chat-paging-anchor` 语义；
- `Load older` / `turnSpacer` 放在虚拟列表外；
- 适配 `useChatViewport` 的行查询、锚点补偿、翻页恢复、active turn；
- 用 `anchorTo:'end'` 保持追加时贴底；
- 安装包内 `@tanstack/react-virtual` 3.14.10 + `@tanstack/virtual-core` 3.17.8 已包含 `anchorTo` / `ScrollAnchor`，不需要为了 `anchorTo` 升级；
- 备选 `react-virtuoso` `MessageList`，但引入新依赖且同样要适配 DOM 契约；
- 验收：500-turn 场景 DOM ≤5k，无 >50 ms long task；翻页不跳；文本选择/Ctrl+A/打印/查找需产品确认。

## 9. P4：基准与指标

- 新增 fat-turn fixture：1 个 user turn、120 条 assistant/tool 消息、每条 assistant 带 20 KB `data.stream`、总页 4–6 MB；
- 新增 combined open：`follow({activate:true})`，同时测 snapshot 首帧、promotion 开始/结束、`fromRestore` 次数；
- 新增 cold-Host 场景：新进程/清 `coldLogMemo`，打开 7 MB 会话，记录 Host decode/parse/restore；
- `complex-history` 增加胖回合变体；
- 指标：page bytes/events/messages、Host snapshot 耗时、`fromRestore` 次数、prepare 耗时、promotion 耗时、renderer parse/mount/long task、DOM；
- 现有 `session-open` / `long-session-browser` 不应回归。

## 10. 验收标准

### P0

- 首屏页 ≤ **2 MB**；消息 ≤ **100**；不切消息组；
- 热 Host 4 MB 级会话 `click → first content` ≤ **350 ms**（本机实测 301.5 ms）；
- 无 > **200 ms** renderer long task；
- DOM：胖 tool 回合 ≤ **9k**；正常会话 ≤ **7k**；7k 以下由 P3 或 80/40 复测决定；
- `maxBytes` 省略时与现有行为一致；
- 现有基准不回归。

### P1

- 冷 Host 7 MB 会话 Host 侧 `readTail` + 分页 ≤ **80 ms**；
- 真正冷首次打开 `click → first content` ≤ **400 ms**；
- tail 页与全量页逐字节一致（至少 4 个真实会话 + fat-turn fixture）；
- projection cache 缺失/落后/torn/seq 断裂/跨帧行/source 越界全部回退，不产生错误页；
- live/subagent/非初始请求不进入 tail 路径；
- activation 不丢。

### P2

- 一次 open 只发生一次 `fromRestore`/`prepare`（P2b 达成时）；
- combined open + activate ≤ **1,125 ms**（沿用 long-session-browser CI 预算）；
- 只取 snapshot 的 consumer 仍完成恢复；pending approval/未闭合 turn 行为不变。

### P3

- 500-turn 场景 DOM ≤ **5k**；
- 无 > **50 ms** long task；
- 翻页/追加/跳转不跳锚点；文本选择行为经产品确认。

## 11. 风险与开放问题

1. **`maxBytes` 与 `minMessages` 的优先级**：字节/组边界优先，`minMessages` 是目标不是硬保证；产品需要确认。
2. **单组超预算**：一条消息可能自带数 MB stream；允许整组成页，8 MB 才硬切。
3. **字节计数成本**：每条事件 `JSON.stringify` 一次，当前页规模约 15 ms/6.5 MB；可在 seq 维度缓存，先不做。
4. **DOM 与字节不相关**：`maxBytes` 不能替代 `maxMessages`/虚拟化；如果 DOM 是硬指标，考虑 `maxEvents`。
5. **sourceEventSeqs 完整性**：需要真实胖回合日志验证组起点；不完整时页首可能多带/少带 tool 事件。
6. **tail 跨帧行/torn 尾**：必须用真实日志做单测，不能只依赖原型样本。
7. **projection cache 命中率**：本机 4 个样本都命中，但 live/刚结束的会话可能落后；落后回退会重新变慢，需要指标。
8. **tail 仍然全文件读压缩字节**：当前只省解压/解析；如果日志 50 MB+，还需要 fs 尾部读或 sidecar/seekable。
9. **P2a 错误路径**：延后 promote 后失败不能向 consumer 抛，必须接 Host 错误上报。
10. **P2b 所有权**：两个 Session 的 lease/取消/错误路径不同，单独设计。
11. **基准环境**：官方基准多在 Linux CI，本机 Windows；绝对毫秒不可直接比较，应看比例和回归。
12. **样本量**：本文真机点击多为单次样本；301.5 vs 360.8 这类差异需要多轮 A/B 才能定论。

## 12. 附录

### A. 尾帧原型命令

~~~bash
node tail-read-probe.mjs --root "C:/Users/TLEWA/.dsh/sessions" --json
node tail-read-probe.mjs --root "C:/Users/TLEWA/.dsh/sessions" --sessions cd3c83f5,42fe5de7,90300455,f5bfe783 --json
~~~

脚本只读，不写会话日志和 profile。

### B. 真机请求改写（示意）

~~~js
const original = WebSocket.prototype.send
WebSocket.prototype.send = function (data) {
  try {
    const message = JSON.parse(data)
    if (message.type === 'open' && message.endpoint === 'session/follow') {
      const request = message.payload.args.request
      request.maxMessages = 100
      request.maxBytes = 1_500_000
      request.turnWindow = { minMessages: 40, minTurns: 2 }
      data = JSON.stringify(message)
    }
  } catch {}
  return original.call(this, data)
}
~~~

### C. 源码定位

| 主题 | 位置 |
|---|---|
| 页常量 / 打开 / loadOlder | `packages/api/session-controller/src/client/sessions/session.ts:52-60`、`:419-428`、`:632` |
| wire follow / repairRequest | `packages/api/session-controller/src/client/transport.ts:179-183`、`:239` |
| 页请求类型 | `packages/api/session-controller/src/types.ts:473-498` |
| 参数校验 / 分页 / records | `packages/api/session-controller/src/history.ts:25-48`、`:132-189` |
| Host history | `packages/api/session-controller/src/history/controller.ts:213-227` |
| Web follow / promote | `packages/api/session-controller/src/web/controller.ts:32-77` |
| Agent resume 二次 restore | `packages/core/agent-loop/src/index.ts:761-832` |
| observation / prepared cache | `packages/session-query/session-query/src/observation.ts:56-163`、`:243-273` |
| projection cache | `packages/session/session-projection-cache/src/index.ts:162-170`、`:223-246` |
| JSONL 解码 | `packages/session/session-persistence-jsonl/src/index.ts:801-872`、`:993-1077` |
| zstd 原语 | `packages/session/session-persistence-jsonl/src/zstd.ts:48-145` |
| transcript 全量挂载 | `packages/client/ui-chat/src/client/chat/ChatFlow.tsx:26-52` |
| viewport | `packages/client/ui-chat/src/client/chat/use-chat-viewport.ts:437-438`、`:481`、`:715` |

### D. 社区与现成能力

- TanStack Virtual Chat: <https://tanstack.com/virtual/latest/docs/chat>
- TanStack Virtual Chat 博客: <https://tanstack.com/blog/tanstack-virtual-chat>
- `anchorTo:'end'` PR: <https://github.com/TanStack/virtual/pull/1173>
- react-virtuoso MessageList loading older: <https://virtuoso.dev/message-list/tutorial/loading-older-messages/>
- zstd seekable format: <https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md>

### E. 复现实验摘要

- 热 Host `cd3c`：默认 4.19 MB / 404.8 ms / 16,059 DOM；P0 1.49 MB / 301.5 ms / 8,815 DOM。
- 冷 Host `903`：7.07 MB / 558.8 ms / 8,020 DOM；`f5bfe` Host 287.2 ms / 0.9 MB 页。
- 尾解：P0 页 1.0–1.5 MB，decode + parse 23–49 ms；与全量页 `exact:true`。
- 结论：P0 解决热 Host 与传输，P1 解决冷 Host 全量解码；两者叠加才有 350–400 ms 的首次打开。
