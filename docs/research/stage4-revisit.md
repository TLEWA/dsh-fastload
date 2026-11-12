# 阶段 4 复审：折叠组懒挂载 PoC 与上游最小补丁设计（2026-11-12）

**English abstract.** The earlier stage 4 feasibility study rejected replacing the
`conversation.chat.flow` entry because a third-party flow would have to redeclare the
`conversation.chat.node` child slot, the native chat components are not exported, and
`hidden=until-found` keeps native text searchable. This revisit tests a narrower path: keep the
native flow entry and its private slot core object, but replace only its `component` with a stable
wrapper that receives the native `renderSlot` and delegates every node to it except folded
`tool-call` nodes in a finished process group. The path works in a real DSH web client on DSH
0.2.2-rc.1: the entry is the same mutable object the renderer reads, the wrapper receives the
native `renderSlot`, all node renders go through the custom function, and no slot assembly or
authorization error was observed. In alternating warm-host A/B measurements, permanent
placeholders reduce click-to-first-row by 10.9% on the long fixture and 11.0% on the normal
fixture (n=6, standard preset), while cutting first-row DOM by 30% and 43%. Pixel parity after
expansion and re-collapse is exact at 1280x900 except for one anti-aliased pixel in a detailed
normal expanded view. Real `FindInPage` has now been exercised through a page-level CDP
session: the structural reveal passes, but find semantics and the active
match/highlight/scroll fail. The other limitation remains: the long fixture gains a
second ~39 ms Long Task after the first row. The permanent-placeholder PoC is therefore
**conditionally GO only as an off-by-default experiment**, not as a default behavior. The
progressive-hydration control is **NO-GO**: on a turn-rail jump into unloaded history it drained
for 12.9 s and produced 93 long tasks of 69-110 ms, versus one 781 ms task in stock. The report
also specifies a smaller upstream patch (U3) that avoids mutating `entry.component`: pass a
`searchOnly` flag through the owner and let the tool-call registration render its exact collapsed
summary text without mounting the full tool tree.

## 0. 结论

| 问题 | 结论 |
|---|---|
| 插件内是否有可运行方案 | **有，条件 GO（默认关闭实验）；结构性揭示 PASS，但查找语义 FAIL**：永久占位实验在真实 DSH Web 中功能、锚点、翻页、展开/折叠均通过，像素等价（1 个抗锯齿像素除外）；默认关闭 |
| 是否建议默认开启或发布 | **否**：依赖私有 `entry.component`；查找语义不等价（误报/漏报/活动匹配丢失）；long 首行后多一个 Long Task；normal/long 收益不一致 |
| 旧 NO-GO 是否被推翻 | **部分**：不需要新增 slot 声明，也不需要复刻 15 种节点视图；但私有接口和节点局部状态风险仍在，且“占位不破坏查找”的假设已被真实 `FindInPage` 实测证伪（误报/漏报/活动匹配丢失） |
| 渐进补挂（progressive） | **NO-GO**：首开可用且最终 DOM 与原生一致，但 rail/未加载历史场景后台长任务严重退化（12.9 s、93 个 69–110 ms Long Task） |
| 上游是否值得做 | **值得，但应换成 U3**：不改 ChatFlow/ChatGroupSeat，只给 `ChatNodeSeat` 加 `searchOnly`，由 tool-call 注册组件渲染精确摘要文本 |

一句话：**插件 PoC 证明了“折叠 tool-call 可以省略完整视图并显著减少首屏 DOM/挂载”，但没有证明它可安全默认发布；真实 `FindInPage` 实测显示结构性揭示 PASS、查找语义 FAIL；上游 U3 是把同一收益做成可接受产品的路径。**

## 1. 背景与旧结论

旧报告 `libs/research/slot-lazy-mount-feasibility.md` 的 NO-GO 依据：

1. `conversation.chat.flow` 是 single slot，第三方注册会与原生注册冲突；如果要渲染节点，必须声明 `conversation.chat.node` 子槽，而同一个 key 不能重复声明。
2. 原生 `ChatFlow`、`ChatNodeSeat`、`ChatGroupSeat` 没有从包入口导出，插件无法复用。
3. 原生折叠组使用 `hidden="until-found"`，节点文本仍在 DOM 中，Ctrl+F 能找到；只用 CSS/懒挂载会破坏查找语义。

阶段 4 计划里的“注册更高优先级 flow”没有解决第 1 点；CSS `content-visibility` 实验也没有收益（真正渲染的顶层行只有 66）。

## 2. 新假设与三条路径

不新增 slot 注册，也不重写 ChatFlow：

- `ctx.slots.entries('conversation.chat.flow')` 返回 SlotCore 内部的 entry 数组视图，元素就是 renderer 每次渲染读取的同一对象；
- 原生 entry 仍声明 `children: { 'conversation.chat.node': ... }`，因此 renderer 仍向 entry.component 注入原生 `renderSlot`；
- 把 `entry.component` 换成 wrapper，wrapper 原样调用 `props.renderSlot`，就仍通过原生 entry 的授权与 StaleAuthorization 检查；
- wrapper 只对“已完成、折叠、位于 process 窗口内的 tool-call”返回占位，其余委托原生；
- 永久占位（D1）把文本留在 `hidden=until-found` 子树内；渐进补挂（progressive）首帧占位，随后分片换回原生节点。

关键点：wrapper 是 `entry.component`，不是新的 slot 注册者，所以不触发 slot 声明冲突。

### 2.1 三条路径的分工

| 路径 | 首帧 | 最终 DOM | 查找语义 | 结论 |
|---|---|---|---|---|
| 永久占位 permanent | 折叠 tool-call 只渲染文本占位 | 保持占位，展开时才挂原生 | 结构性揭示 PASS；误报/漏报/活动匹配丢失 FAIL | 条件 GO（实验） |
| 渐进补挂 progressive | 先占位，双 rAF 后分片补原生 | 最终与原生一致 | Ctrl+F 捕获阶段 `flushSync` 全量补回 | **NO-GO**（rail 场景） |
| 原生 off | 全量挂载 | 原生 | 原生 | 基线 |

## 3. 环境、fixture 与测量口径

- DSH 0.2.2-rc.1 CLI：`libs/.worktrees/stage8-release/bench/.tools/dsh022/node_modules/@deepseek-ai/dsh/lib/bin.js`；
- 隔离 home：`libs/bench/home-s4`（`libs/bench/home` 的副本；profile 的 `dsh-fastload` junction 指向 `libs/.worktrees/stage4-revisit`）；sessions 只读；
- headless Chrome 157，1280×900，独立 user-data-dir；host 端口 11031，CDP 9361；未使用用户 GUI 12592、`~/.dsh` 或其它保留端口；
- warm host + page cache hit；每组先 warmup 再正式重复；off/lazy 交替，顺序固定为 off→lazy；
- normal：`session-f03b9395-d0bc-47e1-b500-ae5f2f8abc38`；long：`session-262d33b1-bf51-49f2-bf29-7016ed1216a8`；
- 指标：click→首个可见 flow 行（`firstVisibleRow`）、follow→snapshot、snapshot→首行、首行时/稳定后 DOM 节点、React commit 次数、>50 ms Long Task、Host CPU/WorkingSet 采样；
- 预设矩阵：`bench/.s4-matrix/home-standard` 为 home 模板，`cordis.patch.yml` 写 `ui-chat` 配置，`dsh --profile web --dump-config` 验证 effectiveConfig；standard 另测 `collapseTiming=completion/next-input` × `foldedReplies=all/final` 四组合；
- 样本量：四预设矩阵 standard/compact/detailed n=6、verbose n=3；standard 四组合 n=3；三模式对比 n=6；更早的 permanent A/B n=6/n=8 仅作交叉验证。所有表格标注 n，不把 n=3 当 n=6。

## 4. A–F 逐条验证

### A. entries 返回同一 entry、component 可写、下次渲染生效

探针证据（`bench/run-s4-probe.mjs`，输出在 `bench/.s4-out/probe`）：

- 安装前：`keys=[component,options,inject,children,store,locale,registrant]`；
- `Object.isFrozen(entry) === false`；`Object.getOwnPropertyDescriptor(entry,'component')` 为 `writable:true, enumerable:true, configurable:true`；
- `children = ['conversation.chat.node']`，原生 entry 的 node 子槽声明仍在；
- 安装后打开 long：`wrapperCalls=5`、`slotCalls=74`、`keysSeen={'conversation.chat.node':74}`、`nodeSlotCalls=74`、`hasRenderSlot=true`、`errors=[]`；
- 生产版同一 fixture：`wrapperCalls=5`、`slotCalls=74`，init lazy=28，说明首帧渲染已经使用 wrapper。

结论：**PASS**。`entries()` 返回的是 SlotCore 内部 entry 数组的渲染态视图，元素对象就是 renderer 读取的同一对象；component 未被冻结，改写后下一次 render 生效。这是私有接口，但行为可复现。

### B. wrapper 收到 renderSlot，所有节点路径都走 custom

- 原生 flow 注册在 `libs/dsh-src/dsh-client-ui-chat/lib/client.js:15437`，声明 `children: {'conversation.chat.node': {kind:'keyed', scope:'session', inject:CHAT_NODE_INJECT}}`；flow 是 `conversation.view` 的 single 子槽（同文件 15458）。
- `ChatFlow`（CHAT:6443-6528）明确解构 `renderSlot`，所有 node 行都经 `ChatNodeSeat`；`ChatNodeSeat` 在 CHAT:4593 调 `renderSlot('conversation.chat.node', routedOwner, ...)`。
- custom 只拦截 key=`conversation.chat.node`；其它 key 原样调用 `latest.current.renderSlot`。
- long 首开 74 次 node 渲染全部进入 custom：`callsByKind={user:2,turn-process:2,assistant-step:33,tool-call:34,turn-tail:2,turn-error:1}`，合计 74。

结论：**PASS**。没有出现 SlotAssemblyError / StaleAuthorizationError；authorization 仍由原生 `boundRenderSlot` 按原生 entry 的 children 检查。

### C. React 树、context、hooks、key 稳定；出错无条件回退

- wrapper 用 `React.useRef(props)` 保存最新 props，用 `React.useMemo` 生成 custom；custom 每次都读 `latest.current.renderSlot`，不复制 context，也不改 React key。
- wrapper 返回 `React.createElement(original, {...props, renderSlot: custom})`；original 仍是原生 `ChatFlow`，所以 context、hooks 和子组件树在原生组件内部保持不变。
- 出错路径：custom 的 try/catch 捕获异常后记录（上限 8 条）并调用原生 `renderSlot`；安装函数在 React/slots/entry 形状不符时直接返回 no-op；卸载时仅当 `entry.component === Wrapper` 才还原。
- 实测 `errors=[]`；`commitsAfterClick` off/lazy 均 16；展开/折叠、翻页、切会话均无 errors。
- 注意：替换 `entry.component` 会改变组件函数身份，安装后第一次渲染会重新挂载 flow（这是预期的一次性成本）；wrapper 自身没有引入 remount 循环。

结论：**PASS**。这是“在私有 entry 上做最小包装”，不是“复制原生实现”。

### D. Ctrl+F / hidden=until-found 兼容

#### D1. 永久占位文本作为查找镜像（已实测：结构揭示 PASS，查找语义 FAIL）

占位文本来自 `node.data` 的有界递归提取（最多 4000 字符，深度 ≤6，跳过 `raw/json`），放在 `hidden=until-found` 组内。真实 `FindInPage` 已在页面级 CDP session 上跑通（`FindInPage.findFirst/findNext/findPrev/stop`；Chrome 157，`WebContents::Find`），方法、逐 token 表格与截图见 `docs/research/stage4-find-verification.md`。旧结论“CDP 缺少 FindInPage 域”来自 browser-level session 的 `-32601` 和 `Schema.getDomains` 结果，是 session 层级的误判，已推翻。

**结构揭示 PASS（common token）。** 对同时存在于占位与原生隐藏文本中的 `.../bench/bug6-res.json`（原生 1 次、占位 4 次）：`findFirst` 57 ms 返回，`beforematch` 于 124.4 ms 触发，lazy 占位 28→0（141.4 ms），原生 group 展开、`aria-expanded` 变 true，最终 DOM 2877→4122，与 off 的 4122 一致，reveal 后 `innerText` 含该 token。显示/揭示链路成立。

**查找语义 FAIL。**

- **误报**：仅存在于占位的 `scans:22`（原生 0 次、占位 1 次）被 `findFirst` 命中（11 ms、`beforematch` 76.8 ms、lazy 28→0、DOM 4122、aria true），但 reveal 后原生 flow 与 `innerText` 均不含该 token，命中 rect 变 null——用户看到一条结果，展开后结果不存在。来源是占位保留了 `node.data` 中的原始参数。
- **漏报**：原生折叠摘要中的 `120000ms`（原生 1 次、占位 0 次）findFirst 无 `beforematch`、无 mutation，lazy 28、hidden 57、DOM 2877 全程不变；该文本在 permanent 下完全搜不到。
- **活动匹配/高亮/滚动丢失**：common 文本虽恢复，但 0/250/1050 ms 均无橙色高亮，页面仍锚在底部（scrollTop 19928→20376，容器最大值），没有滚到匹配位置；`findNext` 7 ms 把 scrollTop 从 20376 改到 5571，但该处 flow 不含 token、无高亮；`findPrev` 9 ms 停在 5571 不动。
- **对照**：data URL 校准证明 FindInPage 命令本身可用——findFirst/findNext/findPrev 都能触发 `beforematch`、移除 `hidden`、绘制橙色高亮并滚动（`getSelection()` 为空是因为高亮在浏览器绘制层）；可见 token “已停止” 的对照截图（`bench/.s4-out/find-verify2/vis-stop-at300.png`）有 4 处黄色高亮。差异来自“占位替换销毁了当前匹配 DOM”，不是 CDP 命令。

**覆盖率**（唯一 token 类型覆盖率，不是字符覆盖率；详表见验证报告第 3 节）：

- 严格早期口径（token 必须同时含字母和数字）：6+ **47.62%**（10/21）、8+ **17.86%**（5/28）；
- 修正口径（字母数字字符组成，不要求两类都有）：6+ **56.66%**（166/293）、8+ **37.44%**（82/219）；
- occurrence-weighted（修正口径）：72.55%（592/816）、45.74%（172/376）；
- 占位唯一 token 远多于原生（6+ 868 vs 293，8+ 1023 vs 219），占位含原始参数、路径、JSON 片段，误报面大；
- 旧报告的 90.7%（186/205）来自不同语料/正则，只作历史口径，与本轮不可比，也不能证明查找兼容。

`window.find` 的结论仍然成立但不能替代真实查找：它对本应用 hidden 组内原生摘要返回 false，对占位 token 也 false（尽管 `document.body.textContent` 包含它），并且不触发 `beforematch`。旧永久实验截图 `bench/.s4-out/find-lazy/lazy-immediate.png` 显示“命中占位 token 后组展开但无高亮”，与本轮实测一致。

结论：**结构性揭示 PASS，查找语义 FAIL**。D1 不能作为 Ctrl+F 兼容方案，只能作为默认关闭的性能实验。

#### D2. 首帧占位、idle 后挂载原生（已否决）

`bench/run-s4-ab-idle.mjs`，6 reps，long，off 与 idle 交替：

| 指标 | off | idle |
|---|---|---|
| click→首行 中位 | 256.85 ms | 263.6 ms |
| snapshot→首行 | 139.2 ms | 144.25 ms |
| 首行 DOM | 4114 | 4114 |
| settled DOM | 4122 | 4122 |
| commits | 16 | 17 |
| 首行 Long Task | 128 ms | 132.5 ms |

idle hydration 在首个可见行判定前已完成，DOM 没有减少，只多一次 commit。**D2 无首行收益，不值得。**

### E. 生命周期、锚点、选择、焦点、无障碍

已实测（standard，`bench/run-s4-lifecycle.mjs`、`run-s4-expand2.mjs`、`run-s4-progressive-lifecycle.mjs`、`run-s4-progressive-extras.mjs`、`run-s4-rail-parity.mjs`）：

- long 初始：`nodes=74`、`groups=2`、`lazy=28`、`hidden=57`、`scrollHeight=20624`；normal：`nodes=195`、`groups=6`、`lazy=85`、`hidden=186`。
- 展开可见 turn-process：lazy 28→0，hidden 57→2，DOM 2877→4126，`aria-expanded=true`；再折叠回 lazy 28、hidden 57、scrollHeight 20624。可逆，无 errors。
- 翻页“加载更早”：nodes 74→205，groups 2→5，lazy 28→89；`data-chat-anchor-key` 的 viewport top 582→582；无 errors。
- 切会话 long→normal→long：normal lazy 85，回 long 28；无 errors。
- turn rail 跳转：最终 DOM/文本/滚动与 off 完全一致（见第 8 节）；active mark 正确。
- rewind 入口可见（aria=“回退到此消息”），点击打开 popover（“回退到这条消息 / 继续吧 / 仅回退对话 / 仅回退上下文，不动工作区文件 / 无可还原的文件变更”），Escape 可关闭；**未实际执行 rewind**。
- 折叠占位在 hidden 组内不可选中；展开后原生文本可选中；展开后 `activeElement` 仍是触发的 BUTTON。
- 私有 DOM 锚点：顶层 flow 行 `data-chat-anchor-key` 保持；占位会移除嵌套 tool 锚点（`flow=null`），深层锚点受影响（见风险）。

未验证：运行时卸载/热重载还原（仅代码审查 + 关闭开关 reload）、Tab 全链路、屏幕阅读器、节点内部局部状态（工具输出内滚动/展开状态）在 permanent 折叠→展开后是否保留。

### F. 性能（真实浏览器）

统一口径：warm host + page cache hit；click→首个可见 flow 行；DOM 为首行时/稳定后 `document.querySelectorAll('*')` 数量；Long Task 用 PerformanceObserver；Host CPU/WS 用采样器。所有数字是各 rep 中位数，括号为 min–max 或 mean 单独标注。

#### F1. 四预设矩阵（permanent）

样本量：standard/compact/detailed n=6，verbose n=3（verbose 的 lazy 为 no-op，3 次足以确认）。所有数字为各 rep 中位数。

| 预设 (n) | fixture | off click | lazy click | 变化 | off snap | lazy snap | off DOM | lazy DOM | off LT 首/稳 | lazy LT 首/稳 |
|---|---|---|---|---|---|---|---|---|---|---|
| standard (6) | long | 265.85 ms | 236.95 ms | −10.9% | 154.45 ms | 132.1 ms | 4114 | 2869 | 142.5/142.5 | 118.5/181.5 |
| standard (6) | normal | 481.6 ms | 428.55 ms | −11.0% | 347.2 ms | 303.75 ms | 8598 | 4888 | 325/403.5 | 285.5/380 |
| compact (6) | long | 263.05 ms | 230.8 ms | −12.3% | 152.65 ms | 124.6 ms | 4114 | 2869 | 141/141 | 113/132.5 |
| compact (6) | normal | 474.1 ms | 421.25 ms | −11.1% | 336.85 ms | 279.95 ms | 8598 | 4888 | 320/397.5 | 269/350 |
| detailed (6) | long | 268.6 ms | 248.35 ms | −7.5% | 148.9 ms | 136.05 ms | 4114 | 2869 | 135/135 | 122/183.5 |
| detailed (6) | normal | 494.6 ms | 448.75 ms | −9.3% | 358.6 ms | 304.55 ms | 8598 | 4888 | 343.5/408 | 284/392.5 |
| verbose (3) | long | 285 ms | 313.3 ms | +9.9%（噪声，lazy=0） | 180.1 ms | 196 ms | 4112 | 4112 | 195/195 | 173/173 |
| verbose (3) | normal | 641.8 ms | 623.3 ms | −2.9%（lazy=0） | 502.1 ms | 502.2 ms | 8588 | 8588 | 522/539 | 547/605 |

内存与 Host CPU（heap / WorkingSet 峰值 / CPU 平均）：分表列出，CPU 采样噪声大，只作参考。

| 预设 | fixture | off heap/WS | lazy heap/WS | off CPU | lazy CPU |
|---|---|---|---|---|---|
| standard | long | 47.8 MiB / 556.7 MiB | 45.7 MiB / 556.7 MiB | 0.066 | 0.059 |
| standard | normal | 66.8 MiB / 529.1 MiB | 56.1 MiB / 529.1 MiB | 0.053 | 0.072 |
| compact | long | 48.6 MiB / 558.9 MiB | 46.0 MiB / 558.9 MiB | 0.065 | 0.051 |
| compact | normal | 67.1 MiB / 548.4 MiB | 56.3 MiB / 548.4 MiB | 0.055 | 0.057 |
| detailed | long | 48.2 MiB / 569.3 MiB | 46.3 MiB / 569.3 MiB | 0.039 | 0.039 |
| detailed | normal | 66.9 MiB / 522.3 MiB | 56.5 MiB / 522.3 MiB | 0.053 | 0.045 |
| verbose | long | 49.6 MiB / 557.6 MiB | 46.8 MiB / 557.6 MiB | 0.064 | 0.063 |
| verbose | normal | 64.3 MiB / 567.0 MiB | 66.1 MiB / 554.5 MiB | 1.027 | 1.005 |

- verbose 下 `foldCompletedTurns=false`、`stepGrouping='none'`，`processWindowReady=false`，没有 `hidden=until-found` 折叠组；lazyNodes=0，DOM 与 off 相同（4112/8588）。lazy 的 +9.9% 是 run-to-run 噪声，不应解读为收益或回归。
- detailed 下 `stepGrouping='history'`，仍有折叠；lazy 收益 7.5%–9.3%，小于 standard/compact。
- standard/compact 的 DOM 降幅 30.2%/43.1%（long/normal）。
- WorkingSet 在各组 off/lazy 间基本不变；heap 在 normal 上下降约 10–11 MiB，long 上下降约 2 MiB。Host WorkingSet 采样受进程/页面缓存影响，不能把差异归因于插件。

#### F2. standard 的 collapseTiming × foldedReplies 组合（n=3）

| 组合 | fixture | off click | lazy click | off DOM | lazy DOM | off LT first/settled | lazy LT first/settled |
|---|---|---|---|---|---|---|---|
| completion/all | long | 265.85 ms | 236.95 ms | 4114 | 2869 | 142.5/142.5 | 118.5/181.5 |
| completion/all | normal | 481.6 ms | 428.55 ms | 8598 | 4888 | 325/403.5 | 285.5/380 |
| next-input/all | long | 320.7 ms | 303.8 ms | 4114 | 2869 | 168/213 | 149/213 |
| next-input/all | normal | 566.9 ms | 518.5 ms | 8598 | 5408 | 440/545 | 394/527 |
| completion/final | long | 327.5 ms | 282.4 ms | 4114 | 2869 | 169/223 | 145/145 |
| completion/final | normal | 580.2 ms | 518.7 ms | 8598 | 4888 | 418/543 | 338/372 |
| next-input/final | long | 297.5 ms | 264.5 ms | 4114 | 2869 | 159/215 | 133/210 |
| next-input/final | normal | 570.6 ms | 534.7 ms | 8598 | 5408 | 435/547 | 390/492 |

结论：四种组合下 lazy 均降首行 4.7%–15.2%、DOM 降 30%–43%；`foldedReplies=final` 时 normal lazy DOM 为 5414（all 时 4894），仍显著低于 off 8604；`collapseTiming` 对 lazy 收益的影响小于 `foldedReplies`。

#### F3. 三模式对比（standard，n=6）

| fixture | 模式 | click 中位 | snapshot→首行 | 首行 DOM | settled DOM | commits | 首行 LT | settled LT | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| long | off | 325.35 ms | 178.6 ms | 4114 | 4122 | 16 | 162 ms | 194.5 ms | — |
| long | permanent | 313.55 ms | 163.15 ms | 2869 | 2877 | 16 | 146.5 ms | 184.5 ms | lazy 28 |
| long | progressive | 318.9 ms | 160 ms | 2869 | 4122 | 24 | 145.5 ms | 145.5 ms | drain 128.6–187.5 ms，7 chunks，max 10.8 ms |
| normal | off | 576.9 ms | 401.25 ms | 8598 | 8604 | 16 | 394.5 ms | 450 ms | — |
| normal | permanent | 528.85 ms | 351.3 ms | 4888 | 4894 | 16 | 380.5 ms | 469 ms | lazy 85 |
| normal | progressive | 513.8 ms | 342.15 ms | 4888 | 8604 | 39 | 359 ms | 359 ms | drain 790.7–903.3 ms，22 chunks，max 19.9 ms |

- progressive 首开收益与 permanent 同量级（normal 最好，long 略逊 permanent），最终 DOM/文本/滚动与原生一致。
- 但 progressive 的 commits 显著增加（normal 16→39），且 rail 场景出现严重后台长任务（第 7 节）。
- Host WorkingSet 在 permanent 与 off 间无可测差异（long 均 626,839,552 B；normal 同组约 620 MB），CPU 采样噪声大，不能据此下结论。

#### F4. long 首行后的第二个 Long Task

permanent 在 long 上首行 Long Task 从 142.5 降到 118.5 ms，但稳定后仍有约 181.5 ms 的长任务（多出约 39 ms），部分 rep 出现 55–77 ms 的第二个任务；off 稳定后多为 142.5 ms。归属未完全定位，候选是占位大文本布局或额外 commit。该现象是 permanent 不能默认开启的主要性能理由之一。

## 5. PoC 实现

### 5.1 开关

- permanent：`localStorage['dsh-fastload.lazy-groups']='1'` 或 `window.__DSH_FASTLOAD_LAZY_GROUPS__=true`；
- progressive：`localStorage['dsh-fastload.lazy-progressive']='1'` 或 `window.__DSH_FASTLOAD_LAZY_PROGRESSIVE__=true`；
- 两者同时开启时 progressive 优先；都默认关闭；非法/缺失值回退 off。

### 5.2 安装与还原

- 安装点：`client.js` 的 `ctx.effect` 开头调用 `installLazyGroups(ctx, require, state)`（client.js:618），cleanup 开头调用其 disposer；
- `installLazyGroups`（client.js:202）：
  - 读取 `ctx.get('slots')`（回退 `ctx.slots`）；
  - `slots.entries('conversation.chat.flow')` 取第一个 entry；
  - 能力检测：React、`react-dom.flushSync`（progressive 必需）、slots.entries、entry.component 类型；
  - 替换 `entry.component` 为 `FastloadLazyFlow`，并标记 `entry.__dshFastloadLazyGroups=true`；
  - 监听 `slots/changed` 或 `slots.subscribe`；找不到 entry 时 250 ms × 40 重试；
  - disposer 清 timer/listener，仅当 `entry.component === Wrapper` 时还原 original 并删除标记。
- wrapper：`useRef` 保存最新 props，`useMemo` 生成 custom；custom 仅拦截 `conversation.chat.node`，eligible 时返回占位，否则 `latest.current.renderSlot(key, owner, opts)`；异常回退原生。
- 占位：`<div data-fastload-lazy-group data-fastload-lazy-key=... style="min-height:18px;white-space:pre-wrap">文本</div>`；progressive 占位为空 div（文本在补挂后出现）。
- eligible（client.js:191 / src/lazy-groups.js:68）：`turnProcess.foldable===true` 且 `open!==true`；`node.kind==='tool-call'`；`spec` 存在；`anchorSeq>=spec.processStartSeq`；`answerAnchorSeq==null || anchorSeq<answerAnchorSeq`。
- progressive：双 `requestAnimationFrame` 后 `requestIdleCallback`（无则 `setTimeout 0`）分片，每片最多 4 节点 / 5 ms；Ctrl/Cmd+F 捕获阶段 `flushSync` 全量补挂；`beforematch` 兜底；切会话/卸载 cancel idle/raf/listener；per-mount 状态避免旧 cleanup 取消新 mount。
- 纯函数：`src/lazy-groups.js` 导出 `LAZY_GROUPS_SLOT`、`lazyGroupEligible`、`lazyGroupMode`、`LAZY_PROGRESSIVE_KEY` 等；`test/lazy-groups.test.js` 覆盖 eligibility、文本提取、模式优先级、shipped-client markers。

### 5.3 代码位置

- `client.js:123-574`：实验实现（常量、文本提取、eligibility、install、wrapper、progressive drain、cleanup）；
- `src/lazy-groups.js`：纯函数；
- `test/lazy-groups.test.js`：Node 单测；
- `docs/research/stage4-revisit.md`：本报告。

## 6. 与原生等价性证据（正常滚动/展开）

### 6.1 permanent

`bench/run-s4-parity.mjs`（standard/detailed，OFF vs lazy）：

| 预设 | fixture | 初始 lazy | 展开后 lazy | 展开 DOM（off/lazy） | 展开文本 hash（off/lazy） | flow 行（off/lazy） | 行 rect diff | 再折叠 scrollTop/scrollHeight |
|---|---|---|---|---|---|---|---|---|
| standard | long | 28 | 0 | 74/74 | 9859d144/9859d144 | 76/76 | 0 | 19928/20752 |
| standard | normal | 85 | 0 | 195/195 | e4d854e0/e4d854e0 | 201/201 | 0 | 10070/10894 |
| detailed | long | 28 | 0 | 74/74 | 相同 | 76/76 | 0 | 相同 |
| detailed | normal | 85 | 0 | 195/195 | 相同 | 201/201 | 0 | 相同 |

像素 diff（1280×900，Pillow，截图在 `bench/.s4-out/parity/<preset>-<session>/{off,lazy}-{top,middle,bottom,expanded}.png`）：

- standard long、standard normal、detailed long 四态 changed=0；
- detailed normal 仅 expanded 1 像素（266,76）254 vs 255（侧栏/主区分隔线抗锯齿），重跑复现；top/middle/bottom 均 0。

### 6.2 progressive

`bench/run-s4-progressive-parity.mjs`（standard，done 后）：

- long：off/progressive 初始 DOM 74/74、lazy 0、scrollTop 19928、scrollHeight 20752；top/mid/bottom bodyHash 均 `9860dd1`；expanded 74/74、hash `a49fca2b`；recollapsed 19928/20752；rowDiff 0；
- normal：DOM 195/195、scroll 10070/10894；hash 全 `d4a9df87`；expanded 195/195、hash `4734a4b`；rowDiff 0；
- 像素 diff（`bench/.s4-out/parity-progressive/{off,progressive}-{top,middle,bottom,expanded}.png`）：long/normal 四态全部 changed=0、bbox null、maxdiff 0。

**结论：正常滚动、展开、再折叠的可见区域与文本等价（1 个抗锯齿像素除外），展开后 DOM 数与原生一致。**

## 7. 真实 find-in-page 验证结果与边界

**能力。** 页面级 CDP session 支持 `FindInPage.findFirst/findNext/findPrev/stop`（Chrome 157，`WebContents::Find`）。旧“CDP 缺少 FindInPage 域”的判断来自 browser-level session 返回 `-32601`、`Schema.getDomains` 不含该域，属于 session 层级误判，已推翻。headless/headful 的 Ctrl+F 仍然只触发页面 DOM keydown、不能打开浏览器查找栏，但这已不再是验证阻塞项。

**data URL 校准。** 两个 `hidden=until-found` 段含同一 token：findFirst/findNext/findPrev 均能触发 `beforematch`、移除 `hidden`、绘制橙色高亮并滚动，prev 回到首个匹配。`getSelection()` 始终为空，因为高亮在浏览器绘制层，不能用 Selection 判断。

**正式 fixture（long）三类 token**（`bench/.s4-out/find-verify2/result.json`，每类在全新 permanent 页面单独 findFirst）：

| case | token | callMs | beforematch | lazy | 最终 DOM | reveal 后文本 | 判定 |
|---|---|---:|---:|---:|---:|---|---|
| common | `.../bug6-res.json` | 57 | 124.4 ms | 28→0（141.4 ms） | 4122（aria true） | innerText 含 token | 显示 PASS |
| extra | `scans:22` | 11 | 76.8 ms | 28→0（93.7 ms） | 4122（aria true） | token 消失 | 误报 |
| missing | `120000ms` | 5 | 无 | 28 不变 | 2877 | 无 | 漏报 |

**活动匹配丢失。**

- common 展开后页面仍锚在底部（scrollTop 19928→20376，容器最大值），0/250/1050 ms 截图无橙色高亮；可见 token “已停止” 的对照截图（`bench/.s4-out/find-verify2/vis-stop-at300.png`）有 4 处黄色高亮，说明高亮器本身工作，是替换操作销毁了当前匹配。
- `findNext` 7 ms：scrollTop 20376→5571，但该处 flow 不含 token、无可见高亮；`findPrev` 9 ms 停在 5571 不动。
- data URL 对照证明 findNext/findPrev 命令本身可用，问题在“替换掉当前匹配 DOM”，不是 CDP 调用。

**覆盖率与占位 token 数量。** 严格早期口径 6+ 47.62%（10/21）、8+ 17.86%（5/28）；修正口径 56.66%（166/293）、37.44%（82/219）；occurrence-weighted 72.55%（592/816）、45.74%（172/376）。占位唯一 token 6+ 为 868 vs 原生 293，8+ 为 1023 vs 219；旧 90.7% 是不同语料/正则下的历史值，不可比。

**边界（仍未验证）。**

- CDP 没有查找栏的 1/N 计数、上下箭头和“DOM 替换后自动重搜”；真实 UI 可能显示 0/0 或触发重搜，但不会保留当前高亮。
- findNext/findPrev 在 permanent 替换后的行为只测了一个 token/fixture；data URL 对照只证明命令本身可用。
- 覆盖率只算 long fixture；normal 的 85 组占位未逐 token 重算。
- headless/headful 的 Ctrl+F keydown 是 CDP 合成按键；菜单/系统级查找未验证。
- 未验证桌面 Electron；真实查找栏 UI 的 1/N 计数与自动重搜也未验证。

**结论：结构揭示 PASS；查找语义与活动匹配 FAIL。任何“Ctrl+F 无差异”的结论仍超出本轮证据。**

## 8. progressive 的 NO-GO 证据

### 8.1 rail 跳转（standard long）

`bench/run-s4-rail-parity.mjs`，点 turn rail 第 3 个 mark，跳到未加载历史：

| 指标 | off | progressive |
|---|---|---|
| before nodes/groups/lazy | 74/2/0 | 74/2/0 |
| after nodes/groups/lazy | 1296/14/0 | 1296/14/0 |
| after scrollTop/scrollHeight | 1836/29706 | 1836/29706 |
| after body/innerText hash | 9987877e | 9987877e |
| 总耗时 | 2524 ms | 12921 ms |
| Long Task | 1 个 781 ms（start 2392） | 93 个 69–110 ms（start 2147 后持续到 14605 ms） |
| 补挂 | 无 | firstFramePending=369，93 chunks，369 nodes，maxChunk=110 ms |

最终 DOM/文本/滚动与 off 完全一致，但后台补挂 12.9 s、93 个 >50 ms 长任务，明显比 off 的单个 781 ms 更差。这触发任务书“后台长任务明显变差即 NO-GO”的判据。

### 8.2 为什么分片没有救回来

- 每片 4 节点 / 5 ms 的上限只限制“代码循环”，不限制 React 提交；一次 `flushSync` 补挂会重新渲染大量祖先/子树，实际单次 69–110 ms。
- rail 一次性把 369 个占位节点加入 pending，`requestIdleCallback` 在持续渲染压力下仍不断得到调度，形成连续长任务。
- 该场景的首屏并没有变快（总耗时反而更长），因此不能以“首开收益”交换后台退化。

## 9. 上游最小补丁设计（U3）

目标：保留“折叠 tool-call 不挂完整视图”的收益，但不改 `entry.component`，且让折叠态文本与展开后摘要同源，尽量保住 Ctrl+F。

### 9.1 改动点

1. `packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx`（构建产物 `libs/dsh-src/dsh-client-ui-chat/lib/client.js:4491`，node 渲染在 4593）：
   - 在计算 `processHidden` 之后、`routedOwner` 之前加：
     `const searchOnly = processHidden && processMember && !processOpen;`
   - 把 `searchOnly` 放进传给 `renderSlot` 的 owner，例如
     `routedOwner = { ...owner, node: routedNode, searchOnly };`
   - 外层 div、`data-chat-anchor-key`、`data-chat-paging-anchor`、`data-chat-flow-key` 全部保持原样。
2. `packages/client/ui-tool/src/client/toolCall.tsx`（注册 `name:'conversation.chat.node', key:'tool-call'`）：
   - 注册的 `component: ToolCallTree` 改为 `component: ToolCallNode`。
   - `ToolCallNode` 是无 hooks 的薄包装：`props.searchOnly === true` 时返回
     `<span data-chat-search-mirror>{toolCallSearchText(props.node)}</span>`，否则返回
     `<ToolCallTree {...props}/>`。条件分支不改变 hook 顺序。
   - `toolCallSearchText(node)` 从现有折叠摘要路径抽出，保证文本与用户折叠时看到的完全一致；不要用 `node.data` 通用递归镜像。
   - 某工具无法给出精确摘要时返回 `null`，`ToolCallNode` 直接渲染 `ToolCallTree`，即该工具不懒挂载，保证查找语义不退化。
3. `ChatGroupSeat`（同文件 4921）不需要改：`GroupMembers` 仍挂载 seat，seat 自己决定节点视图。
4. `ChatFlow`（同文件 6443）不需要改：`renderSlot` 仍由 flow 注入，`searchOnly` 只是 owner 新字段。
5. 若要扩到 assistant-step，按同样方式给对应注册组件加包装；摘要文本未精确抽出前保持原生挂载。

### 9.2 为什么上游 U3 可能恢复查找语义

当前 permanent 占位**并未**保留查找语义：实测有误报（`scans:22`）、漏报（`120000ms`），reveal 后活动匹配/高亮/滚动也会丢失（见 D1 与第 7 节）。U3 只是候选修复，不是已证结论。其理由是：

- 折叠时 `hidden=until-found` 子树里是**与折叠摘要同源的纯文本**，用户查找命中的字符串与展开后看到的摘要一致，可消除“占位含原始参数”造成的误报面。
- `beforematch` / 用户点击展开后 `processOpen=true`，`searchOnly=false`，React 在同一位置挂载完整 `ToolCallTree`；文本镜像被替换，不重复命中。
- 如果浏览器在替换瞬间滚动到已被移除的文本节点，可能落点抖动；最小验收要求真实 Chrome 对折叠组内唯一字符串做 Ctrl+F，确认 group 展开且选区/滚动落在完整视图内。失败就退回“不懒挂载该 kind”。

### 9.3 最小验收测试

1. 单测：`toolCallSearchText` 对每种 tool-call 形状返回与折叠摘要一致的非空文本；未知形状返回 null。
2. React 测试：`searchOnly=true` 只渲染一个 `span[data-chat-search-mirror]`，不挂载 `ToolCallTree`；`searchOnly=false` 完整挂载；切换不抛 hook 顺序错误。
3. 真实 Chrome 手工/E2E：long fixture 中折叠 tool-call 的唯一年份/命令文本 Ctrl+F → group 展开 → 文本可见并可选中；再折叠后不重复命中。
4. 生命周期：展开→折叠→再展开两次，`aria-expanded`、`data-chat-anchor-key`、`scrollTop`、焦点保持；运行中/交错输入/aborted 组永远 `searchOnly=false`。
5. 性能：同一 fixture 首行时间、DOM 数、首行前后 Long Task；验收要求首行收益成立且总 Long Task 不增加超过 10%。
6. 兼容：老版本 tool 包没有 `searchOnly` 字段时，chat 传了也没人消费，必须仍渲染完整视图（当前设计天然满足）。

## 10. 失败、未执行与限制

- 真实查找已用页面级 CDP `FindInPage` 验证（命中、`beforematch`、hidden 移除、结构揭示）；真实查找栏 UI 的 1/N 计数、自动重搜、活动匹配是否更差仍未验证。
- 永久占位文本不是精确摘要：严格口径 6+/8+ 覆盖率 47.62%/17.86%，修正口径 56.66%/37.44%（旧 90.7% 为不同语料/正则的历史值，不可比）；占位还含折叠态不显示的原始参数，实测误报/漏报/活动匹配丢失；不能作为查找等价方案。
- long 首行后的第二个 Long Task 未定位；总 Long Task 可能比 off 更差。
- 运行时卸载/热重载还原未实测；只验证了代码路径和关闭开关后的 reload。
- Tab 键盘全链路、屏幕阅读器、实际 rewind 未验证。
- 真实桌面 Electron 未测；所有数字来自 headless Chrome。
- 节点局部状态（工具输出内滚动/展开）在 permanent 折叠→展开后是否保留未测。
- `entry.component` 是私有接口；DSH 升级后可能失效，能力检测只能保证“不安装”，不能保证“升级后仍有效”。
- progressive 只在 standard long/normal 上做完整三模式；其他预设未做 progressive 矩阵。

## 11. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `entry.component` 私有、可被下一个 DSH 版本改掉 | 开关打开后可能不生效或渲染异常 | 能力检测 + try/catch + 默认关闭；升级后重跑 A/B |
| 文本镜像不精确 | Ctrl+F 漏命中/多命中/活动匹配丢失（已实测） | 默认关闭；上游改为精确 `toolCallSearchText`；真实查找栏验收 |
| 节点视图卸载 | 局部状态、内部滚动、二级展开丢失 | 只对 tool-call 折叠节点；文档明示；上游可保留状态或接受 |
| long 第二个 Long Task | 总阻塞增加 | 定位来源；上游验收要求总长任务不退化 |
| slot 重注册/热重载竞态 | wrapper 覆盖或丢失 | 监听 `slots/changed`、标记防重复、dispose 条件还原 |
| 与其它改 flow entry 的插件冲突 | 互相覆盖 | `__dshFastloadLazyGroups` 标记；检测到已标记就不安装 |
| progressive rail 长任务 | 后台卡顿 | **已判 NO-GO**，不默认开启，不推荐 |
| 真实查找栏行为未验证（计数/重搜） | 用户 Ctrl+F 可能显示 0/0 或重搜后落空；活动匹配/高亮丢失已实测 | 不宣称兼容；上游 U3 用精确摘要并做真实查找栏验收 |

## 12. 下一步建议

1. **不要把 permanent 设为默认**；页面级 `FindInPage` 已实测结构揭示 PASS、查找语义 FAIL。若要继续插件路线，发布前仍需在真实可见 Chrome 查找栏做手工回归（验证 1/N 计数、自动重搜、活动匹配是否更差），并定位 long 第二个 Long Task。
2. **优先上游 U3**：只覆盖 tool-call，先做 `toolCallSearchText` + `ToolCallNode`，不碰 ChatFlow/ChatGroupSeat；用真实 Chrome 查找验收。
3. 在真实桌面 Electron 复测 normal/long；headless CLI 数据不能直接外推到桌面。
4. 开关打开时补一次禁用/热重载回归，确认 `entry.component` 还原。
5. progressive 不再投入；除非重做分片为“每帧最多一次 React 提交 + 可中断优先级”，否则 rail 场景无法达标。

### 12.1 提交前最终验证

在删除临时诊断字段（`liveRef`、额外透传 prop）之后，重新跑了测试、gate 和真实浏览器冒烟：

- `npm test`：128/128 pass（`node --test`）。
- `dsh-ci-gate`：PASS，16 ok / 0 warn / 0 fail / 2 skip；tarball 31 files / 176 KiB。
- 真实浏览器冒烟（headless Chrome 157，DSH 0.2.2-rc.1，host 11031，home-s4，开关只开 permanent）：
  - long 初始 `lazy=28`、`nodes=74`、`hidden=57`、`scrollHeight=20624`，`errors=[]`；
  - 点可见 turn-process 展开后 `lazy=0`、`hidden=2`、`aria=true`、`scrollHeight=20664`，原生节点重新出现，可选中文本；
  - 再折叠回 `lazy=28`、`hidden=57`、`scrollHeight=20624`；
  - 切到 normal 得到 `lazy=85`、`nodes=195`，切回 long 仍是 `lazy=28`、`nodes=74`；
  - 加载更早后 `nodes=205`、`groups=5`、`lazy=89`，所选锚点的 viewport top 保持 582，`errors=[]`。
- 这一轮只验证“清理后仍可运行”，不替代第 6 节的像素等价与第 8 节的 progressive 反证。

## 附录：证据与复现

- A/B：`bench/.s4-out/ab-prod-normal/{rows.json,summary.json}`、`bench/.s4-out/ab-prod-long/{rows.json,summary.json}`；
- 四预设矩阵：`bench/.s4-out/matrix-<preset>-<collapse>-<folded>-<session>/{rows.json,summary.json}`；
- 三模式：`bench/.s4-out/ab-progressive/{rows.json,summary.json}`（如目录名不同，以 `run-s4-progressive.mjs` 输出为准）；
- parity：`bench/.s4-out/parity/`、`bench/.s4-out/parity-progressive/`；
- rail：`bench/.s4-out/rail-parity/`；
- lifecycle：`bench/.s4-out/lifecycle/`、`expand2/`、`progressive-lifecycle/`、`progressive-extras/`；
- 查找：`bench/.s4-out/find-verify2/{result.json,vis-stop-at300.png}`（真实 FindInPage，脚本 `bench/run-s4-find-verify.mjs`、`bench/proto-real-find-vis.mjs`）、`bench/.s4-out/find-headful/after-find.png`、`bench/.s4-out/find-lazy/lazy-immediate.png`；
- 运行脚本：`bench/run-s4-*.mjs`（临时脚本，未全部提交）；首行定义与 DOM/commit/long task 采集见 `bench/lib/measure.mjs`、`bench/lib/probe.mjs`。
- 代码：`client.js:123-574`、`src/lazy-groups.js`、`test/lazy-groups.test.js`。
