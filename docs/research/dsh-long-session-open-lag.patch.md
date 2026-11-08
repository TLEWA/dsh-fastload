# DSH 长会话首屏优化：P0 + P1 补丁草案（尾帧直读）

> 状态：**草案，未应用**。本文只给出可落地的 diff 方向、测试与基准清单，不修改安装版 `D:/DSH/resources/app.asar`，也不修改用户 profile。
>
> 基线：`deepseek-ai/deepseek-harness` main `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。行号以该 commit 为准；落地前请重新核对。
>
> 关联报告：`dsh-long-session-open-lag.md`、`dsh-long-session-first-open.md`。

## 1. 变更清单

| 层 | 文件 | 变更 | 风险 |
|---|---|---|---|
| 协议 | `packages/api/session-controller/src/types.ts` | `SessionPageRequest` / `SessionFollowRequest` 增加 `maxBytes` | 低，可选字段 |
| 校验 | `packages/api/session-controller/src/history.ts` | `validateHistoryWindow` 校验 `maxBytes` | 低 |
| 分页 | 同上 | `paginate` 增加字节预算，按消息组收缩 | 中，分页语义 |
| Host | `packages/api/session-controller/src/history/controller.ts` | 把 `maxBytes` 传进 `paginate` | 低 |
| 客户端 | `packages/api/session-controller/src/client/sessions/session.ts` | 新页预算常量；JUMP 显式配置 | 低 |
| 客户端 | `packages/api/session-controller/src/client/transport.ts` | `repairRequest` 转发 `maxBytes` | 低 |
| 持久化 | `packages/session/session-persistence/src/index.ts` | 可选 `readTail` 接口 | 低，可选能力 |
| JSONL | `packages/session/session-persistence-jsonl/src/index.ts` | 倒序帧解码 + JSONL 行拼接 | 高，需要回退矩阵 |
| 观察 | `packages/session-query/session-query/src/observation.ts` | `observeTail` + projection cache 校验 | 中 |
| Web | `packages/api/session-controller/src/web/controller.ts` | 首屏尾读快路径 + 延后 activation | 中，activation 语义 |
| 测试 | 对应包内 spec | 分页/转发/尾读/回退/激活 | — |
| 基准 | `benchmarks/long-session-browser`、`benchmarks/session-open` | fat-turn + cold Host + combined open | — |

建议拆成三个 PR：

1. **P0**：协议 + 分页 + 常量 + transport（可直接改善热 Host 首屏）。
2. **P1**：`readTail` + `observeTail` + `follow` 快路径 + 延后 activation（冷 Host 首屏）。
3. **P2b**：单次 prepare / SessionPreparation 所有权转移（单独设计，不在此草案内）。

---

## 2. P0：字节预算

### 2.1 `types.ts`

~~~diff
@@ export interface SessionPageRequest
   readonly maxMessages?: number
+  /** Maximum UTF-8 bytes of the returned wire event records. Omitted = no byte budget. */
+  readonly maxBytes?: number
   readonly turnWindow?: {
@@ export interface SessionFollowRequest
-export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> {
+export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'maxBytes' | 'turnWindow'> {
~~~

### 2.2 `history.ts`：校验

~~~diff
-export function validateHistoryWindow(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): void {
+export function validateHistoryWindow(
+  request: Pick<SessionPageRequest, 'maxMessages' | 'maxBytes' | 'turnWindow'>,
+): void {
   if (request.maxMessages !== undefined
     && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
     throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
   }
+  if (request.maxBytes !== undefined
+    && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0)) {
+    throw new RemoteError('gateway/bad-request', 'maxBytes must be a positive safe integer', {})
+  }
   const window = request.turnWindow
~~~

### 2.3 `history.ts`：字节感知的 `paginate`

保留现有消息/turn 倒扫逻辑。找到 `cut` 后，再按“从页首到 group 起点”的 UTF-8 字节收缩；**不能切断一个消息 group**。至少保留一个完整 group；单 group 超过 8 MB 才允许硬切。

~~~diff
+const BYTE_BUDGET_HARD_LIMIT = 8 * 1024 * 1024
+const WIRE_ENCODER = new TextEncoder()
+
+function wireBytes(event: SessionEvent): number {
+  return WIRE_ENCODER.encode(JSON.stringify(entryFor(event))).byteLength
+}
+
+/**
+ * Shrink [cut, end) from the front while preserving whole message groups.
+ * A group boundary is the message event's seq or the minimum sourceEventSeq
+ * in the page; this mirrors the existing maxMessages cut.
+ */
+function byteBoundedCut(
+  events: readonly SessionEvent[],
+  cut: number,
+  end: number,
+  maxBytes: number | undefined,
+): number {
+  if (maxBytes === undefined || cut >= end) return cut
+  let bytes = 0
+  let next = end
+  // Walk groups from the end; keep the newest suffix that fits.
+  for (let i = end - 1; i >= cut; i = groupStart(events, i, cut) - 1) {
+    const start = groupStart(events, i, cut)
+    const size = sumWireBytes(events, start, next)
+    if (bytes + size > maxBytes && next < end) break
+    bytes += size
+    next = start
+  }
+  return next
+}
+
 export function paginate(...) {
   // ... existing backward scan and cut computation ...
+  const bounded = byteBoundedCut(events, cut, end, maxBytes)
+  if (bounded > cut) cut = bounded
+  // A single group larger than the hard limit is allowed, but never a page
+  // above 8 MiB: degrade to the group start and let the client page older.
   return { events: events.slice(cut, end), cut, hasMore: cut > 0 }
 }
~~~

实现注意：

- `groupStart` 必须与现有 `maxMessages` 的 `groupStart` 语义一致：取 message `seq` 与 `sourceEventSeqs` 的最小值，不能只看 `seq`。
- 字节入口与 `pageRecords` 使用同一 `entryFor` 信封；不要用事件裸 JSON 估算。
- `maxMessages` 仍然是硬上限：先按消息/turn 切，再按字节收缩；`maxBytes` 不会把页扩大。
- `hasMore` 保持 `cut > 0`；`cut === 0` 但日志还有更早事件时，客户端应回退全量路径。

### 2.4 `client/sessions/session.ts`

~~~diff
-export const PAGE_MESSAGES = 50
+export const PAGE_MESSAGES = 40
-const HISTORY_PAGE_OPTIONS = {
-  maxMessages: 500,
-  turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 },
-}
+const HISTORY_PAGE_OPTIONS = {
+  maxMessages: 100,
+  turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 },
+}
-const JUMP_PAGE_OPTIONS = {
-  ...HISTORY_PAGE_OPTIONS,
-  turnWindow: { ...HISTORY_PAGE_OPTIONS.turnWindow, minMessages: JUMP_PAGE_MESSAGES },
-}
+const JUMP_PAGE_OPTIONS = {
+  maxMessages: 500,
+  maxBytes: 3_000_000,
+  turnWindow: { minMessages: JUMP_PAGE_MESSAGES, minTurns: 1 },
+}
~~~

**关键陷阱：** `JUMP_PAGE_OPTIONS` 不能继续继承 `HISTORY_PAGE_OPTIONS.maxMessages`。`JUMP_PAGE_MESSAGES=200` 大于 `HISTORY` 的 `100` 时，`validateHistoryWindow` 会以 `minMessages > maxMessages` 拒绝所有 jump 请求。JUMP 必须显式写 `maxMessages: 500`。

**maxBytes 默认关闭：** 100/40/2 已经把 `cd3c` 压到 0.87 MB；默认再加 1.5 MB 上限没有收益，反而可能在“工具-only 尾 turn”上裁出空尾。只有 2-turn 页自身 >1.5 MB 时才启用，且不得少于 2 个 turn。

### 2.5 `history/controller.ts`

~~~diff
 const request = resolveHistoryRequest(raw, observation)
-const page = paginate(observation.events, request.beforeSeq, request.maxMessages, request.throughSeq, request.turnWindow)
+const page = paginate(
+  observation.events,
+  request.beforeSeq,
+  request.maxMessages,
+  request.throughSeq,
+  request.turnWindow,
+  request.maxBytes,
+)
~~~

`resolveHistoryRequest` 要把 `maxBytes` 一并带出；不要只从 `raw` 读 `maxMessages`。

### 2.6 `client/transport.ts`

~~~diff
 function repairRequest(request: SessionPageRequest): SessionPageRequest {
   return {
     ...request,
     maxMessages: request.maxMessages,
+    maxBytes: request.maxBytes,
     turnWindow: request.turnWindow,
   }
 }
~~~

> 当前实现只转发 `maxMessages` 和 `turnWindow`；漏掉 `maxBytes` 会让客户端预算在 gateway 前被静默丢弃。

### 2.7 测试

- `history.spec`：默认无 `maxBytes` 行为不变；`maxBytes` 精确切到 group 起点；至少保留 2 个 turn/2 个完整 group；单 group 超 8 MB 才硬切；`maxMessages` 优先；非法 `maxBytes`（0、负数、非整数）拒绝。
- `transport.spec`：`repairRequest` 转发 `maxBytes`；旧客户端不带该字段仍工作。
- `session.spec`：`HISTORY_PAGE_OPTIONS` / `JUMP_PAGE_OPTIONS` 满足 `minMessages <= maxMessages`；jump 请求能通过校验。
- 真机/基准（CDP 冷 Host，可见文本相同）：`cd3c` 3.42 MB / 555.4 ms / 486 anchors / 9,946 DOM → 0.87 MB / 301.3 ms / 168 anchors / 4,601 DOM；100/40/1 的 283.5 ms 是 267 px/102 字符空页，不能计入。

---

## 3. P1：尾帧直读

### 3.1 持久化接口

在 `packages/session/session-persistence/src/index.ts` 增加**可选**能力，旧 backend 不实现时自动回退：

~~~ts
export interface SessionLogTail {
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
  readonly cursor: number
  readonly hasMore: boolean
}

export interface SessionPersistence {
  // ... existing methods ...
  /**
   * Read enough trailing events to serve one page. Returns undefined when the
   * tail cannot be recovered safely; callers must fall back to open/read.
   */
  readTail?(
    sessionId: string,
    options: { maxMessages: number; maxBytes?: number; signal?: AbortSignal },
  ): Promise<SessionLogTail | undefined>
}
~~~

### 3.2 JSONL 实现

在 `packages/session/session-persistence-jsonl/src/index.ts` 增加 `readTail`。不要复用 `readStoredLog`，因为后者会全量解码。

~~~ts
async readTail(sessionId, options) {
  const snapshot = await this.stat(sessionId, { signal: options.signal })
  if (!snapshot?.location) return undefined
  const { bytes: buffer } = await readStableJsonlFile(snapshot.location.path, options.signal)
  const scan = scanZstdFrames(buffer)
  if (scan.tornStart !== undefined || scan.frames.length < 2) return undefined
  const frames = scan.frames

  // 1) The header is already parsed by stat(); frame 0 is header-only.
  const header = snapshot.header
  const inherited = snapshot.inheritedEventCount ?? 0

  // 2) Walk frames backwards, accumulating decompressed JSONL chunks.
  const chunks: Buffer[] = []
  let bytes = 0
  let messages = 0
  for (let i = frames.length - 1; i >= 1; i--) {
    const chunk = decompressZstdFrame(buffer, frames[i])
    chunks.push(chunk)
    bytes += chunk.byteLength
    messages += countMessageLines(chunk) // may over-count split lines; re-count after join
    if (bytes >= (options.maxBytes ?? 1_500_000) + 64 * 1024
      && messages >= options.maxMessages + 40) break
  }

  // 3) Join oldest -> newest, keep only complete lines. Drop the first
  //    partial line if the reverse walk started mid-line.
  const text = Buffer.concat(chunks.reverse()).toString('utf8')
  const lines = completeLines(text) // split on '\n', drop last partial
  const events = []
  for (const line of lines) {
    const event = parseEventLine(line)
    if (!event) return undefined
    events.push(event)
  }

  // 4) Validate seq continuity and page cursor.
  for (let i = 1; i < events.length; i++) {
    if (events[i].seq !== events[i - 1].seq + 1) return undefined
  }
  const cursor = events.at(-1)?.seq
  if (cursor === undefined) return undefined
  const hasMore = events[0].seq > inherited + 1
  return { header, inheritedEventCount: inherited, events, cursor, hasMore }
}
~~~

实现注意：

- `scanZstdFrames` 只扫结构；`decompressZstdFrame` 可以单帧解压。不要用 `zstdDecompressSync` 一次解全文件：它只解第一帧。
- `readStableJsonlFile` 仍读全文件字节，但**不解压全部帧**；7 MB 文件读字节约几十 ms，尾解 15–40 ms。
- 一行 JSON 可能跨帧：必须把倒序 chunk 反转后拼接，再按 `\n` 切；不能逐帧独立 parse。
- torn final frame、帧边界切行、seq 断裂、parse 失败、header 缺失/多行：一律返回 `undefined`，由调用方回退全量；`scanZstdFrames` 抛 corrupt 时也要在 `readTail` 顶层 catch，不能把打开变成异常。
- 读到的 `identity`/`revision` 必须与 `stat` 匹配；追加中的日志只接受稳定前缀，否则回退。
- `hasMore` 不能用 `events[0].seq > 1` 粗判；要减去 `inheritedEventCount`，否则 seed 会话会误判。
- 不要在 `readTail` 里调用 `Session.fromRestore` 或 `sessions.prepare`；它只返回事件和 header。

### 3.3 观察层

在 `packages/session-query/session-query/src/observation.ts` 增加 `observeTail`，不要构造完整 `Session`：

~~~ts
async observeTail(sessionId, options): Promise<TailObservation | undefined> {
  const persistence = this.ctx.persistence
  if (!persistence.readTail) return undefined
  const stat = await persistence.stat(sessionId)
  if (!stat.header) return undefined
  const tail = await persistence.readTail(sessionId, options)
  if (!tail) return undefined

  const cached = await this.ctx.sessionProjectionCache.cachedSnapshot(
    tail.header,
    this.ctx.sessionProjections.keys,
  )
  if (!cached || cached.asOfSeq !== tail.cursor) return undefined

  return {
    source: 'tail',
    header: tail.header,
    events: tail.events,
    cursor: tail.cursor,
    hasMore: tail.hasMore,
    projections: cached.values,
    inheritedEventCount: tail.inheritedEventCount,
  }
}
~~~

注意：`cachedSnapshot` 只接受 header/keys；如果它的 identity 校验需要 `inheritedEventCount`，把 `tail.inheritedEventCount` 一并传入或先构造等价 meta。要求 `asOfSeq === cursor`，否则尾页缺 projection，必须回退。

### 3.4 `WebController.follow` 快路径

只在**初始页、普通 Session、非 live、非 subagent、`inheritedEventCount===0`、无 `beforeSeq/throughSeq`** 时尝试：

~~~ts
const canTail = request.beforeSeq === undefined
  && request.throughSeq === undefined
  && origin !== 'subagent'
  && !this.isLive(sessionId)
const tail = canTail
  ? await this.ctx.sessionQuery.observeTail(sessionId, {
      maxMessages: request.maxMessages ?? DEFAULT_MAX_MESSAGES,
      maxBytes: request.maxBytes,
    })
  : undefined

if (tail) {
  const opening = {
    type: 'snapshot',
    header: { ...tail.header },
    projections: projectionsFromTail(tail),
    ...historyFromTail(tail, request),
  }
  this.bindListeners(opening.cursor)
  yield opening
  if (request.activate) schedulePromoteById(sessionId)
  return
}
// existing usingObservation path
~~~

`historyFromTail` 仍复用 `paginate`：把 `tail.events`、`throughSeq: tail.cursor`、`maxBytes` 传入；若 `cut===0` 且 `tail.hasMore`，说明尾读不足以覆盖一页，回退全量。快路径失败（`undefined`、异常、projection miss）必须静默回退，不能把打开变成错误。

### 3.5 activation

尾读路径没有 prepared `Session`，不能直接 `retain/promote`。新增：

~~~ts
private schedulePromoteById(sessionId: string): void {
  setImmediate(() => {
    void this.promoteById(sessionId).catch((error) => {
      this.emit('api-session/error', { sessionId, error })
    })
  })
}

private async promoteById(sessionId: string): Promise<void> {
  const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
    projection: false,
  })
  using owned = observation
  const result = await this.agents.resolveObservedAgent(owned)
  if ('error' in result) throw result.error
}
~~~

- 激活发生在 `yield opening` 之后；首帧不再等第二次全量 restore。
- `setImmediate` 要在 `yield` 前调度，但回调在首帧让出事件循环后执行。
- live 会话、pending approval、未闭合 turn 不走延迟路径；仍立即激活。
- 消费者在收到 snapshot 后立即停止，`setImmediate` 仍会执行，activation 不丢。

### 3.6 回退矩阵

| 条件 | 行为 |
|---|---|
| `readTail` 未实现 / 返回 `undefined` | 回退 `usingObservation` |
| projection cache 缺失 / identity 不匹配 / `asOfSeq !== cursor` | 回退 |
| torn final frame / 跨帧行 / seq 断裂 / parse 失败 | 回退 |
| `inheritedEventCount !== 0` / seed 会话 | 回退 |
| live / subagent / `beforeSeq` / `throughSeq` | 回退 |
| 读取中日志被追加 / revision 变化 | 回退 |
| `cut === 0` 且 `hasMore` | 回退 |

### 3.7 测试与验收

- `readTail.spec`：多事件帧、跨帧 JSON 行、torn 尾、seq 断裂、header 单独帧、`inheritedEventCount`、尾页与全量 `pageRecords` 逐字节一致。
- `observeTail.spec`：cache 命中/过期/identity 不匹配；`asOfSeq !== cursor` 回退。
- `web-controller.spec`：快路径成功、每个回退条件、`activate:false`、abort、live/subagent。
- 真机：`903` 7.07 MB 冷 Host 尾读 Host ≤80 ms；`42fe` 14.24 MB 尾读 22.5+8.8 ms；`cd3c` 15.5+7.5 ms；`f5bfe` 39.8+8.9 ms。目标 click→首内容 ≤350 ms。

---

## 4. P2a：activation 移出首帧关键路径

当前 `WebController.follow` 在 `yield opening` 之前调用 `this.promote(promotion)`。改成“先 retain/dispose，调度 `setImmediate`，再 `yield`”：

~~~diff
-  observation.retain()
-  observation.dispose()
-  this.promote(promotion)
+  observation.retain()
+  observation.dispose()
+  setImmediate(() => { this.promote(promotion) })
   yield opening
~~~

注意：

- 不要把 `promotion` 的 `dispose` 放到 `setImmediate` 里；必须在 `yield` 前完成租约转移。
- pending approval / 未闭合 turn 仍立即 `promote`；延迟只用于普通已完成 turn。
- 失败必须上报；不能静默吞掉，否则会话看起来打开但 agent 没恢复。
- `promoteById`（尾读路径）和 `promote(promotion)`（全量路径）共用同一失败上报。

P2b（单次 prepare）不在此草案：它需要让 `SessionPreparation` 支持所有权转移，或让 `SessionStore.adopt` 接受 preparation；设计不清会出现两个消费者持有同一个未发布 Session。

---

## 5. 基准与指标

### 5.1 新 fixture

- **fat-turn**：1 个 user turn + 150 条 assistant/tool 消息，含 25 万字符 system prompt；用来覆盖“消息数少但字节/行数巨大”的页。
- **cold-host**：7–14 MB、数千 zstd 帧、首次打开；Host 进程不预热。
- **combined-open**：同一点击里计 snapshot 构造、IPC、renderer parse、React 挂载、activation；不要像 `session-open` 那样把 first-history 和 agent-resume 分开测。

### 5.2 指标

页字节、消息数、事件数、DOM、long task、`fromRestore`/`prepare` 次数、Host `follow` 耗时、renderer 首内容时间。CI 用中位数和 p95，单次点击不作为验收。

### 5.3 预期

- P0：CDP 冷 Host 公平样本 555.4 → 301.3 ms；wire 3.42 → 0.87 MB；DOM 9,946 → 4,601；可见文本 850 字符不变。
- P1：7 MB 冷 Host 558.8 → 约 350 ms（Host 尾读 ≤80 ms）；页 bytes 与全量路径逐字节一致。
- P2a：首帧不再与第二次 restore 竞争；combined open+activate 不高于 1,125 ms。
- P3：500-turn 全量展开 DOM ≤5k；无 >50 ms long task。

---

## 6. 风险

- **尾读正确性是第一位**：跨帧行、torn 尾、seq 断裂必须逐字节验证；任何不确定都回退全量。
- **projection cache 一致性**：`asOfSeq` 必须等于尾读 `cursor`；turn 结束写入、live 追加、缓存淘汰都可能不一致。
- **P0 的 DOM 收益来自消息数**：`maxBytes` 只减旧消息组，不减少最新 turn 的行数；100/40/2 实测 4,601 DOM。`maxBytes=600KB` 可能裁出空尾，必须配 2-turn 下限和 flowH/visibleText 回归。
- **JUMP 继承陷阱**：`JUMP_PAGE_OPTIONS` 必须显式 `maxMessages`，否则 `minMessages 200 > 100` 被拒绝。
- **activation 语义**：延迟只用于普通已完成 turn；pending approval / 未闭合 turn 立即激活；失败上报。
- **P2b 所有权**：不要在没有所有权设计时复用 prepared Session。
- **安装版边界**：本草案不修改 `D:/DSH/resources/app.asar` 或 profile；真机预算实验通过页面 WebSocket patch 完成。
