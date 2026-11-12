# 首次进入历史会话：P1–P8 落地评估（2026-11-12）

> 状态：**已实施 P4 / P5 + P8 的一部分**，其余项给出实测依据与上游改造方案。
> 基线：DSH 安装版 0.2.2-rc.1（`D:/DSH/resources/app.asar`，从 asar 提取的未压缩 ESM 源码见 `libs/dsh-src`）。
> 环境：Windows 11，Node 24.22.1，隔离 `DSH_HOME=libs/bench/home`（复制真实历史：533 个会话、370 MB 日志、
> 41 MB projection cache），`dsh web --port 3599`，Chrome headless + 原生 CDP 注入计时探针。
> 样本会话：`session-0ce06eba-de1b-4c3a-9b3e-b86208285685`（15.4 MB 日志、2 个 turn、每 turn 84 步、861 条事件）。

## English abstract

The first open of a long session is dominated by the opening page: stock sends 2.82 MB for a
2-turn, 861-event page that the existing turn window cannot shrink further. Four host-side changes
were implemented behind independent switches: a persisted session-header index (P4), a persisted
opening-page cache keyed by the persistence revision (P5), replay-stream stripping on the opening
frame (part of P8), and both are covered by unit tests. Measured on the sample session:
session/list build 238.7 ms → 82.0 ms (1.1–1.8 ms on a TTL hit); a cached opening is readable in
17 ms instead of a 583 ms cold page build; the wire page drops from 2,821,398 B to 1,562,989 B
(−44.6%) with byte-identical visible text (175 rows, 56,984 characters); first transcript rows
arrive ~11 % sooner. The remaining costs are upstream: the client waits for the workspace baseline
before it opens the remembered session (~190 ms), the projection cache opens its whole storage
domain at boot (41 MB), tool payloads are 62 % of the stripped page and need a protocol-level
summary + fetch-on-expand path, and promotion happens before the opening frame is yielded.

## 1. 实测时序（同一会话、同一 profile、缓存已预热）

Chromium 网络帧时间（相对导航开始）：

| 阶段 | stock | 本插件 |
|---|---:|---:|
| WS 建立 | ~500–690 ms | ~473–572 ms |
| workspace/follow baseline（会话列表 42,373 B） | 440.7 ms | 同一路径 |
| session/control baseline（projections 11,240 B） | 483.1 ms | 同一路径 |
| session/follow 发出 | 781 / 885 ms | 697 / 797 ms |
| snapshot 帧到达 | 1,106 / 1,215 ms | 944 / 1,057 ms |
| snapshot 字节 | 2,821,398 B | 1,562,989 B |
| follow → snapshot | 325 / 330 ms | 247 / 260 ms |
| 首屏行出现（`dom:flow-rows`） | 950.8 / 1,055.6 ms | 839.5 / 951.0 ms |
| 可见文本 | 175 行 / 56,984 字符 | 175 行 / 56,984 字符（逐字相同） |
| 长任务总耗时（>50 ms） | 578 / 738 ms | 562 / 728 ms |

结论：**页面体积是首开的主杠杆**；首屏内容、行数与滚动语义完全一致。

## 2. 逐项评估

### P1 会话列表与正文加载解耦 —— 不属于插件，需上游改客户端

- RPC 层没有“列表阻塞正文”：`ClientSessions.retain()` 直接 `manager.get(id).open()`，内部
  `await events.open(HISTORY_PAGE_OPTIONS)`，全程没有等待 `session.list` 的 await；`refreshList()`
  是独立的 single-flight。
- 真实延迟在客户端 `dsh-client-ui-workspace/lib/client.js` 的 `watchNavigation`（1583 行）：
  等 `workspaces.list` 与 `sessions.list` 都 ready（本样本 441 ms）后才 `restoreSelection`（1614 行），
  再 `replaceMain` 打开会话；follow 到 635 ms 才发出，中间约 190 ms 属于客户端决策与渲染。
- 插件侧无法安全接管这段状态机（会话流的所有权、取消、锚点补偿都在客户端服务里）。
  **上游提案**：localStorage 已有 `dsh.sessions.current` 时先乐观 open，列表到达后只做校验；
  或让 `workspace/follow` 的 baseline 先发会话摘要、projection 后补。

### P2 精简 session/list 响应 —— 已足够小，不实施

- 列表走 `workspace/follow` baseline：533 个会话共 42,373 B（约 80 B/条），只含 summary 投影，
  没有 `contextHeaders` / `turnOutline` 这类大字段；cold 会话用 `projectionCache.cachedSnapshot`
  做零 I/O 读数。
- 结论：继续削减的收益低于 1 ms 级，风险（客户端字段缺失）不值得，保留现状。

### P3 Projection Cache 按需加载 —— 上游改造

- `SessionProjectionCache.init()` 里 `storageDomain.open({name:'session_projcache', version:7,
  layout:'per-record', ...})` 会把整个 domain 的每个 session 文档读入并逐条 zod 校验；本机 41 MB。
- 插件无法延迟：`cachedSnapshot` 依赖内存表；替换 storage-domain 语义会破坏版本校验与
  `backup-and-skip` 失效回退。
- **上游提案**：per-record 表 + 轻量索引（checkpoint key 与 rows 分文件），启动只读索引，
  首次访问再按 key 读 rows；或 boot 后 idle 预热并与首帧错峰。

### P4 会话目录扫描与索引 —— 已实施（`src/scan-cache.js`）

- 包装 `persistence.readGenerationHeader`：先 `stat`（bigint，含 size/mtimeNs），与索引命中则
  返回克隆的 header，未命中才解 zstd 首行；读写前后 stat 必须一致才落索引。
- 包装 `list`：single-flight + 400 ms TTL memo，吸收一次 boot 内的多次列表请求。
- 索引持久化到 `<cacheDir>/scan-headers.json`（1500 ms debounce、tmp+rename 原子替换、
  20,000 条按 mtime 裁剪）；任何异常静默回退到原始实现。
- 数据：`sessionQuery.listSessions` 238.7 ms → **82.0 ms**（有索引首调；无索引 205 ms），
  TTL 命中 **1.1–1.8 ms**；`sessionController.list` 在其上固定多约 40–50 ms。
- 正确性：append 必然改变 size 与 mtime，stale 条目不可能命中；删除文件自然不命中；
  多进程各自原子替换索引文件，最坏丢索引、不影响列表正确性。

### P5 持久化首屏快照 —— 已实施（`src/page-cache.js` + `wrapPageCache`）

- key = 协议版本 + sessionId + `persistence.stat().revision`（`dev:ino:size:mtimeNs:ctimeNs`）+
  页窗口/裁剪配置指纹；文件为 zstd（无 zstd 回退 gzip）。
- 命中：先 yield 缓存快照，再 `setImmediate` 让传输层冲刷；随后惰性拉真实流，若 cursor 与
  `assistantStream.revision` 一致则**吞掉**真实 snapshot、只把 `seq > cachedCursor` 的事件补发；
  不一致立即 evict 并结束，绝不下发第二个 opening（`RemoteJournalStream` 收到第二个
  `opened` 会直接 `protocolViolation`）。
- 写入：拿到真实首帧后按调用前的 revision 异步落盘（串行写链、tmp+rename、30 s 节流 LRU 到
  96 MB / 400 文件）；revision 变了自然 miss。
- 数据：缓存读取 **16.9–17.7 ms**，同一进程冷建页 583.5 ms；命中时 follow→页面约 60 ms。
- 边界：只服务初始页（`beforeSeq/throughSeq` 不参与），不影响 Agent 恢复（`activate` 语义原样透传）
  与写入（日志不动）。

### P6 预测性预加载 —— 已实施（客户端，复用上游已有的 `activate:false`）

- 上游不需要改：`session/follow` 的参数本来就带 `activate`。宿主只在
  `request.activate === true` 时 `retain`+`promote`（`dsh-api-session-controller/lib/index.js:2523`），
  省略或 `false` 走 `observation[Symbol.dispose]()`，只读不激活。之前的审计误判为“必须新增 RPC”。
- 实现：客户端监听侧栏会话行（`[data-row-key^="session:"]`）的 `pointerover`/`focusin`，
  150 ms 后发起 `session.follow({ address, assistantStream: true, activate: false })`，
  取首帧后立即 `iterator.return()`。队列上限 4、串行执行、同一会话 10 分钟 TTL 去重、
  指针移开取消、卸载时 abort；`localStorage['dsh-fastload.prewarm']='0'` 可关闭。
- 数据（bench，冷进程、清空页缓存、同一会话）：
  - 262d33b1（6.0 MB 日志）：点击→首行 **337 ms → 110 ms**（预热 follow 233 ms 在 hover 等待内完成）。
  - 6e1e17af（rewind 会话，扩展页 736 条）：**253 ms → 174 ms**（预热 175 ms，命中页缓存 18 ms）。
  - 宿主日志：预热请求 `activate=false`，点击请求 `activate=true` 且 `page cache hit`。
- 边界：预热只写页缓存，不激活 Agent、不写会话；真实打开仍走原来的 `activate:true` 并带
  页缓存校验；缓存失配时按既有逻辑丢弃。

### P7 图片与附件延迟加载 —— 本样本无收益，未实施

- 该会话 snapshot 中 `data:image` 0 处、base64 0 处；首帧字节 99.9% 是事件文本，不是图片。
- 设计（客户端/上游）：`<img loading="lazy" decoding="async">` + 已知宽高占位；缩略图需要附件
  服务产出派生资源，并保持鉴权（现有私有资源签名 URL 不变）。当前没有证据表明它在首开热路径上。

### P8 Tool Result 按需加载 —— 部分实施 + 上游方案

- 已实施：剥离 `assistant/message.data.stream`（replay 用的原始 chunk）。这些 chunk 只服务
  回放/统计，transcript 从 `data.message` 渲染，用量从 `data.usage` 读。替换为 `[]` 而不是删除
  key（`lastAssistantStreamChunk` 会直接迭代 `stream`，删除会 TypeError）。
  页面 2,821,398 B → **1,562,989 B（−44.6%）**，视觉零变化。
- 剥离后剩余构成：`tool/ptc-dispatch` 28.1%、`tool/result` 20.0%、`tool/call` 7.1%、
  `tool/ptc-dispatch-start` 7.4%、`assistant/message` 29.6%。工具类合计 62.6%。
- 完整按需加载需要协议扩展：opening 里对折叠工具的 payload 只发摘要（大小、首行、类型），
  客户端展开时按 `seq` 取全文并缓存；必须同时保证历史搜索、跳转与 Agent 上下文仍能拿到全文。
  这属于上游 controller/transport + 客户端 store 的改动，插件不能只改 wire 而不破坏展开逻辑。

## 3. 已有研究项的落地状态

| 研究项 | 状态 | 说明 |
|---|---|---|
| zstd `readTail` | 未实施（上游） | 插件无法替换 persistence 解码；P5 页缓存在冷启动直接跳过解码（17 ms），等效收益且不破坏校验。 |
| 延迟 Agent Activation | 未实施（上游） | `web/controller.js:112-127` 在 yield opening 前 `retain`+`promote`；提案改为 yield 后 `setImmediate`。 |
| 减少重复 Session Restore | 已缓解 | 宿主 `coldLogMemo` 按 id+revision 去重；P5 让冷进程连建页都跳过。同进程重复打开 0.8–1.3 ms。 |
| Transcript Virtualization | 未实施（上游） | 需要在 `dsh-client-ui-chat` 的 transcript 组件里接 `@tanstack/react-virtual`；插件的 DOM 层注入会与 React 渲染冲突。 |

## 4. 剩余问题与下一阶段

1. P1 乐观打开（上游客户端）——预计再省 150–200 ms，是当前最大的单点。
2. P8 完整方案：摘要 + 按需取全文，需要协议版本号与客户端展开钩子。
3. P3 lazy projection domain：收益在 Host 冷启动 CPU/内存，需 benchmark 启动阶段。
4. 页缓存的失效压力测试：连续写入、并发打开、revision 变化、缓存损坏（已有单测，仍需真机长跑）。
5. P6 的长时间可用性：预热与真实打开共享日志解析，仍需在真实 DSH 里观察 CPU 峰值与取消路径。
