# 流式会话打开为什么会慢（stage 9 诊断）

日期：2026-11-14 · 环境：DSH 0.2.2-rc.1（Electron + Web SPA）· 会话
`session-0333c160-2cb0-4e81-a600-c7ae4fd4ab93`（PTC preset，单 turn）

## 结论

用户观察到的“模型正在输出文本时点进会话很慢、静态会话很快”，不是宿主建页慢，
而是三件事叠在一起：

1. **初始页在工具密集的会话里会膨胀到近千条事件、数 MiB。** “100 条消息”在 PTC
   会话里意味着约 10 倍的事件（每 step 约 10 条 `step/*`、`tool/*`、
   `job/*`、`tool/ptc-dispatch*`），实测 912 条事件 / 3.63 MiB。这部分载荷
   全都要经过 WebSocket 传输、`JSON.parse` 和 renderer 的同步装配。
2. **页缓存对“正在输出”的会话结构性失效。** 缓存键含 persistence revision（每次
   追加都变），命中后还要真实首帧的 `assistantStream.revision` 与缓存完全相等；
   流式期它每帧 +1，所以要么未命中，要么命中后几十毫秒内被丢弃，客户端整页重开
   （双击路径）。
3. **打开时还要展开当前 attempt。** 首帧的 `assistantStream.activeAttempt` 会被
   `expandAssistantStream` 展开成逐 delta 的 transient 条目（缓存里实测
   `nextIndex = 702`），全部进入 `ConversationAssembler.replaceWindow` 的
   sort / Map 写入 / `locationIndex.rebuild` / 逐条 `matchInput`。

stage 9（本 PR）处理 1 和 2：Agent 处于 `running` 时把初始页窗口收缩到 24 条消息，
并默认跳过页缓存读写；页缓存只保存“首帧没有进行中 attempt”的稳定页。3 仍然存在，
记录在文末的后续方向里。

## 观测手段

- `$DSH_HOME/cache/dsh-fastload/serve.log`：插件每次 `follow` 一行，含请求参数、
  `open→hit` / `open→live` 耗时、`records`、`cursor`、`hasMore`、
  assistant baseline `rev`、缓存命中/丢弃/写入事件。
- `$DSH_HOME/cache/dsh-fastload/pages/*.json.zst`：页缓存的完整 opening，可直接
  反解出 records 数量、字节构成与 `assistantStream`。
- 会话日志 `$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`：
  用 `zlib.zstdDecompressSync` 解开后逐行是 header（第 0 行）与事件（`seq`）。
- 宿主源码：`D:/DSH/resources/app.asar` 内的 TS 源码，例如
  `dsh/node_modules/@deepseek-ai/dsh-api-session-controller/src/history.ts`、
  `.../src/assistant-stream.ts`。
- 既有基准：`docs/research/plugin-optimization-final-report.md`、
  `docs/research/dsh-long-session-open-lag.md`。

## 证据 1：宿主建页不是瓶颈

同一台机器、同一宿主进程（pid 33056）的 `serve.log`：

| 会话状态 | 例子 | `open→live` | 页规模 |
| --- | --- | ---: | --- |
| 静态 | `session-54cec103…` 04:07 | 15 ms（命中）/ 13 ms（hit→live） | 350 records |
| 流式 | `session-0333c160…` 04:04:57 | 43 ms | 984 records |
| 流式 | `session-0333c160…` 04:14:12 | 47 ms | 913 records |

即宿主 `follow`（读日志、分页、构造首帧）在两种状态下都是 20–60 ms 量级，
静态与流式在这些样本上几乎没有差别。用户感知的几秒级差异不可能来自这里。

## 证据 2：初始页在工具密集会话里膨胀

对当前会话日志按宿主 `paginate` 的语义重放（`maxMessages` 只数
`user/message` + `assistant/message` 且 `surfaceOp === 'append'` 的事件；
`turnWindow` 在 turn/start 处判断 `count >= minMessages && turns >= minTurns`；
消息的 `groupStart` 取 `min(seq, sourceEventSeqs)`）：

| 窗口 | records | 首帧 JSON | 消息 | turn |
| --- | ---: | ---: | ---: | ---: |
| 100 / `{minMessages:40,minTurns:2}`（现状） | 912 | 3.63 MiB | 100 | 0 |
| 24 / `{minMessages:24,minTurns:1}`（本 PR） | 243 | 0.63 MiB | 24 | 0 |

事件构成（同一会话，1703 条事件）：`tool/ptc-dispatch-start` 248、
`tool/ptc-dispatch` 247、`job/registered` 173、`job/settled` 172、
`step/start` 166、`assistant/message` 166、`tool/call` 166、
`tool/result` 165、`step/end` 165、`user/message` 11。按字节拆分：
`tool/ptc-dispatch` 48.7%、`tool/result` 25.2%、`assistant/message` 14.7%、
`tool/call` 4.1%、`tool/ptc-dispatch-start` 3.7%，其余为 `job/*` 与 `step/*`。

也就解释了为什么“100 条消息”的页会达到 3.5 MB：一条消息平均 ~32 KB，
而字节预算是关的（`DSH_FASTLOAD_MAX_BYTES=0`）。

**为什么不能靠现有的字节裁剪兜底：** `src/trim.js` 只在 `turn/start` 切，且整 turn
保留；对一个很长、工具密集的 turn，打开 `maxBytes` 也切不动它（默认 `maxBytes=0`，
本来就不生效）。另外 `planTrim` 现在为了算总量会对整页 `JSON.stringify`，真开起来
每次首帧还要多付 10–20 ms 宿主开销。

## 证据 3：页缓存对流式打开结构性失效

页缓存键 = `digest([PAGE_CACHE_VERSION, sessionId, persistenceRevision, variant])`。
流式期每次追加事件后 persistence revision 都会前进，所以键几乎不可能重复：

- 本会话 03:39:50–04:04:57 共 11 次打开，`serve.log` 中**全部是 miss**；
- 25 分钟里 `pages/` 写出 201 个文件、33 MB，最新单个页文件 3.55 MB，
  其中 `records` 约占 99.9%，`assistantStream` 只有 166 B–26 KB。

即使碰巧命中，命中路径也要求真实首帧的 `assistantStream.revision` 与缓存完全
相等（`index.js` 的 `wrapPageCache` 首帧校验），否则 `evict` + 抛
`fastload page cache is stale: baseline moved <real>/<cached>`，客户端整页 resync：

```
03:41:32.522 open session-0333c160 … (hit)
03:41:32.522 hit  cursor=76 records=77   （lookup 约 43 ms）
03:41:32.571 live rev=666                （cached assistant baseline = 506）
03:41:32.571 drop baseline=666/506
03:41:32.602 open session-0333c160 …     （客户端第二次完整 open）
03:41:32.618 live rev=668
```

即流式期的缓存命中不但没有收益，还会把一次打开变成两次完整安装。
`SessionAssistantStreamAccumulator` 的 `revision` 是**逐帧计数器**（收到一帧 +1，
`start` 帧 `revision === 1` 且已有 revision 时清零重来），不是字节数也不是
attempt 的 chunk 数；只要模型还在输出，它就一定在动。

## 证据 4：renderer 侧的剩余成本

宿主只花 20–60 ms，剩下的是客户端：

- 既有基准（warm host，883 records / 1.56 MB 首屏）：`follow→snapshot` 54.6 ms，
  `snapshot→首行` 319.7 ms，`JSON.parse` 只有 9.2 ms，>50 ms Long Task 1 个
  （120–340 ms）。说明成本在装配与 React 首次提交，而不是解析。
- 打开时会先 `assistantStream.replace(entries, baseline)`：把 `activeAttempt` 的
  compact stream 展开成逐 delta 的 transient 条目（`seq = durableCursor + 1 - 1/(n+1)`
  的小数），缓存快照里实测 `nextIndex = 702`（另一次采样 59、两次 0，取决于打开时
  attempt 停在哪）。
- `ConversationAssembler.replaceWindow` 随后清空 9 个 Map/Set、`[...entries].sort`、
  全部 `inputs.set`、`locationIndex.rebuild`、逐条 `matchInput`、最后全量
  `markDirty`；复杂度是 O(页事件 + transient)。`settleAssistant` 每次结算还会
  扫一遍 `inputs`。

本 PR 把第一项从 912 条压到 243 条，transient 那部分不受页预算影响（它取决于当前
attempt 的 delta 数），属于残余成本。

## 方案与取舍（本 PR）

- `src/config.js`：新增 `runningMaxMessages`（默认 24）、`runningPageCache`
  （默认 `false`）。
- `index.js`：在 `install()` 里统一取 `statusOf`（可被测试注入），初始页 +
  `!refreshing` 时读实时 Agent 状态；`running` 时把请求改写成 24 条、
  `turnWindow={ minMessages: min(MIN_MESSAGES, 24), minTurns: 1 }`（`minMessages`
  必须 ≤ `maxMessages`，否则宿主抛 `gateway/bad-request`），并跳过缓存读写。
  `serve.log` 的 open 行新增 `mode=running|idle` 与 `cache=on|off` 便于复核。
- `wrapPageCache` 的 `store`：首帧 `assistantStream.activeAttempt` 存在时不写，
  只缓存稳定页。
- 内部缓存刷新（`refreshing`）保持 canonical 窗口，避免把 24 条的页写进 100 条的
  缓存 variant。

取舍：流式期窗口只覆盖最后 24 条消息，更早的历史由内置“加载更早”补回（插件不改
分页语义）；`DSH_FASTLOAD_RUNNING_MAX_MESSAGES=100` 即可恢复旧行为。

## 未做与后续方向

- **字节裁剪的消息对齐切点（PR2）**：`planTrim` 现在只能切 `turn/start`，单 turn
  会话完全失效。宿主 `paginate` 自己允许页首落在消息的 `groupStart`，所以把切点
  扩大到“消息 groupStart ∪ turn/start”，并在轮次规则不满足时降级到消息规则，是
  与宿主语义一致的做法；同时把“全量 stringify 求总量”改成从尾部累加，避免给首帧
  加 10–20 ms。配套加 `runningMaxBytes`（1 MiB）作运行期安全网。
- **transient 展开与装配成本**：可以在客户端侧观察/裁剪，但涉及宿主私有接口与行为
  风险，留待单独评审。
- **真正的真机 A/B**：需要重启用户的 GUI（本 PR 未做，避免打断正在进行的工作）。
  重启后 `serve.log` 的 open 行会出现 `mode=running` 且 `records` 从近千降到
  两三百，可直接复核；bench 侧可用 `bench/run.mjs --scenarios warm-host` 对比
  `records` / 首屏 WS 字节 / `snapshot→首行`，但 bench 样本是静态会话，无法覆盖
  streaming 状态。

## 附录：复现本文数字

1. 解压会话日志，丢弃第 0 行（header），其余按 `seq` 排序；
2. 用宿主 `paginate` 的规则从尾部向前扫：`turnWindow` 在 `turn/start` 处判断，
   消息只数 `user/message`、`assistant/message` 且 `surfaceOp === 'append'`，
   切点取 `min(seq, sourceEventSeqs)`；
3. 对切出的 `records` 求 `JSON.stringify(...).length` 即为首帧字节。

源码位置：`dsh-api-session-controller/src/history.ts`（`MESSAGE_TYPES`、
`validateHistoryWindow`、`paginate`）、`src/assistant-stream.ts`
（`revision` 与 `activeAttempt.nextIndex`）、客户端
`src/client/sessions/assistant-stream.ts`（`replace`）、
`dsh-client-ui-conversation/src/client/conversation/assembler.ts`
（`replaceWindow`）。
