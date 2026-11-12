# 阶段 4 查找验证：真实 FindInPage 下的 permanent / progressive

- 日期：2026-11-12；工作树 `libs/.worktrees/stage4-revisit`（`feat/stage4-revisit`，HEAD `50aae2a`）
- Chrome 157.0.8103.52（headless，CDP）；long fixture `session-262d33b1-bf51-49f2-bf29-7016ed1216a8`
- 结论：**common 结构性显示/揭示 PASS，但活动匹配/高亮/滚动 FAIL；extra 误报；missing 漏报；permanent 默认关闭；progressive NO-GO。**
- 本轮未 commit、未 push、未改版本号、未改默认行为、未触碰用户 12592 GUI。

## English abstract

Stage 4's placeholders were re-tested against Chrome's real find-in-page implementation via the CDP `FindInPage` domain (Chrome 157, `WebContents::Find`), not `window.find`. A data-URL calibration confirms that a match on `hidden=until-found` content fires `beforematch`, removes `hidden`, and paints the native orange highlight.

On the long DSH fixture, a **common** token that exists in both the permanent placeholder and the native hidden text triggers the native group's `beforematch`; lazy placeholders drop 28→0, the settled DOM returns to the native 4122 nodes, and `aria-expanded` becomes true. **The structural display/reveal path passes, but the active match, highlight and scroll position are lost.**

**Find semantics fail.** A placeholder-only token (`scans:22`) is a false positive: it expands the group, then disappears. A native-only token (`120000ms`) is a false negative: no `beforematch`, no expansion. Coverage is 47.62%/17.86% under the strict early tokenizer (6+/8+; 56.66%/37.44% under the corrected alphanumeric tokenizer), and replacing the matched placeholder destroys the active match, highlight, and scroll position. Permanent is therefore **default-off only**; progressive remains **NO-GO** (12.9 s / 93 long tasks in the background drain).

## 1. 实测方法

- 真实查找：page session 调用 `FindInPage.findFirst(query)`，采样 0/60/250/1050 ms；必要时紧跟 `findNext/findPrev`，最后 `stop`。
- 采样内容：`beforematch` 事件、`[hidden="until-found"]`、`[data-fastload-lazy-group]`、DOM 数、flow `textContent`/`innerText` 是否含 token、`scrollTop`、`aria-expanded`、`getSelection()`、token 节点 rect、前后截图。
- 先做 data URL 校准：两个 hidden 段含同一 token，验证 findFirst/findNext/findPrev 能触发 `beforematch`、移除 hidden、绘制高亮并滚动。`getSelection()` 始终为空，高亮是浏览器绘制层，不能用 Selection 判断。
- token 语料：最大 `conversation.chat.flow` 的 `textContent`（排除 style/script）；原生 flow 33,882 字符，permanent 28 个占位约 93,899 字符。
- 三类 token：common `C:/Users/TLEWA/Desktop/DSHs/dsh-plugins/libs/bench/bug6-res.json`（原生 1 次/占位 4 次）；extra `scans:22`（原生 0/占位 1）；missing `120000ms`（原生 1/占位 0，来自原生 flow 摘要，不是 CSS）。
- 说明：common 在 reveal 前同时存在于占位和原生 DOM，所以它不是"仅占位"测试；误报结论只看 extra。

## 2. 真实 FindInPage 结果

`bench/.s4-out/find-verify2/result.json`；每类在全新 permanent 页面单独 findFirst。

| case | token | callMs | beforematch | lazy | 最终 DOM | reveal 后文本 | 判定 |
|---|---|---:|---:|---:|---:|---|---|
| common | `.../bug6-res.json` | 57 | 124.4 ms | 28→0（141.4 ms） | 4122（aria true） | innerText 含 token | **显示 PASS** |
| extra | `scans:22` | 11 | 76.8 ms | 28→0（93.7 ms） | 4122（aria true） | token 消失 | **误报** |
| missing | `120000ms` | 5 | 无 | 28 不变 | 2877 | 无 | **漏报** |

### 2.1 common：显示路径 PASS

- `beforematch` 在 124.4 ms 触发，目标原生 flow item（`DIV.EvIC1a_flowItem`）；lazy 28→0 于 141.4 ms，hidden 57→2→1。
- 原生 group reveal 调 `setTurnProcessOpen(..., true)`，`process.open=true` 后 wrapper 的 `lazyGroupEligible` 变 false，占位换回原生。
- DOM 2877→4122，与 off 完全一致；group `aria-expanded` false→true。
- 页面原本在底部（scrollTop 19928→20376，容器最大值），展开后仍锚在底部；**没有滚动到匹配位置**。
- 250/1050 ms 截图无橙色高亮；可见 token "已停止" 的对照截图 `vis-stop-at300.png` 有 4 处黄色高亮，证明高亮器工作。common 的匹配被替换操作销毁。
- 结论：父 agent 关心的"beforematch 后原生 reveal 是否置 process.open、wrapper 是否换回原生"——**是，显示链路 PASS**；但活动匹配/高亮/滚动丢失。

### 2.2 extra：明确误报

- findFirst 命中占位 `scans:22`，触发 beforematch、展开 group、DOM 到 4122。
- reveal 后原生没有这个 token，flow/innerText 均不含，命中 rect 变 null。
- 用户看到一条查找结果，展开后结果不存在；这是**占位原始 `node.data` 文本**造成的结构性误报。

### 2.3 missing：明确漏报

- `120000ms` 在 off 原生 flow 中存在（off 下可见），但 permanent 占位没有。
- findFirst 无 beforematch、无 mutation；lazy 28、hidden 57、DOM 2877 全程不变。
- 原生折叠摘要中的文本在 permanent 下完全搜不到，这是**漏报**。

### 2.4 活动匹配丢失与导航

- common 文本虽然恢复，但 250/1050 ms 无高亮、无滚动到 y=-14326 的匹配。
- `findNext` 7 ms：scrollTop 20376→5571，但 flow 又不含 token，无可见高亮；`findPrev` 9 ms 仍停在 5571。
- data URL 对照证明 `findNext/findPrev` 本身可用（next 滚到 hidden 段、触发 beforematch、高亮；prev 回到首个匹配）。差异来自"替换掉当前匹配 DOM"，不是 CDP 命令问题。
- CDP 看不到查找栏计数/重新搜索；高亮与滚动丢失是直接证据，真实查找栏可能显示 0/0 或触发重搜，但不会保留当前高亮。

## 3. 覆盖率

语料：原生最大 flow vs 全部占位文本；下表是唯一 token 类型覆盖率（不是字符覆盖率）。

| 口径 | 6+ | 8+ | 说明 |
|---|---:|---:|---|
| 严格早期口径（token 必须同时含字母和数字） | **47.62%**（10/21） | **17.86%**（5/28） | 父 agent 指定引用，早期 result.json 口径 |
| 修正口径（字母数字字符组成，不要求两类都有） | 56.66%（166/293） | 37.44%（82/219） | 更符合"含字母数字"的定义 |
| occurrence-weighted（修正口径） | 72.55%（592/816） | 45.74%（172/376） | 按原生出现次数加权 |

- 占位唯一 token 远多于原生：6+ 为 868 vs 293，8+ 为 1023 vs 219；占位包含原始参数、路径、JSON 片段，误报面大。
- 旧报告 90.7% 是不同语料/正则下的弱指标，不能与本轮直接比较，也不能证明查找兼容。
- 无论采用 47.6%/17.9% 还是修正值，覆盖率都远不足以支撑"占位可替代原生文本"。

## 4. progressive

| 状态 | pending | lazy | DOM | findFirst | beforematch |
|---|---:|---:|---:|---|---:|
| 自然前台，drain 完成 | 0 | 0 | 4122 | 可用 | 1 |
| 延迟 idle（4 s），无 keydown | 28 | 28 | 2877 | 无命中 | 0 |
| Ctrl+F keydown 后 | 0 | 0 | 4122 | 可用 | 1 |

- 自然前台（加 `Page.bringToFront`）：firstFrame 662.1 ms、start 762 ms、done 858.1 ms，drain 96.1 ms、7 chunks、max 5.6 ms；最终 DOM 4122、flow 550,843 字符，与 off 相同。
- 之前 `startedAt=null/pending=28` 是页面在后台、`requestIdleCallback` 没跑造成的假象。
- 延迟 idle 时占位为空、没有文本，真实 find 无法命中，也不会触发 beforematch；drain 窗口内整段原生隐藏文本不可查找。
- 真实 CDP Ctrl+F（modifiers=2、KeyF）keydown 34–36 ms 内全量 flush：pending 0、lazy 0、DOM 4122、reason keydown；随后 findFirst 命中、bm=1。
- 合成 `beforematch` 也能 flush（58 ms、reason beforematch）。
- rescue 依赖页面收到 keydown；菜单/系统级 find 是否经过 keydown 未验证。
- **progressive 仍 NO-GO**：既有 12.9 s / 93 个 69–110 ms 后台 Long Task 的性能退化；本轮补充的是 drain 窗口内的查找缺口，不改变 NO-GO。

## 5. 性能表

**口径与可比性**：三模式来自同轮 A/B（`progressive-long/normal`，n=6）；四预设来自 `matrix-*` 独立批次（verbose n=3）。**绝对耗时跨批次不可比，只能比较同批 Δ。** 三模式表为 standard 预设。

### 5.1 standard 三模式（n=6）

来源：`bench/.s4-out/progressive-long/summary.json`、`rows.json`；`bench/.s4-out/progressive-normal/summary.json`、`rows.json`。

| fixture | 模式 | 首行 ms | 首行 DOM | 稳定 DOM | 首行 LT ms | settled LT ms | commits |
|---|---|---:|---:|---:|---:|---:|---:|
| long | off | 325.35 | 4114 | 4122 | 162.0 | 194.5 | 16 |
| long | permanent | 313.55 | 2869 | 2877 | 146.5 | 184.5 | 16 |
| long | progressive | 318.9 | 2869 | 4122 | 145.5 | 145.5 | 24 |
| normal | off | 576.9 | 8598 | 8604 | 394.5 | 450 | 16 |
| normal | permanent | 528.85 | 4888 | 4894 | 380.5 | 469 | 16 |
| normal | progressive | 513.8 | 4888 | 8604 | 359 | 359 | 39 |

- permanent：long 首行 -3.6%、DOM -30.2%；normal 首行 -8.3%、DOM -43.1%，但 settled LT +19 ms。
- progressive：long/normal drain 128.6–187.5 ms / 790.7–903.3 ms（7/22 chunks），最终 DOM 与 off 一致，commits 24/39。

### 5.2 四预设（standard completion all，n=6；verbose n=3）

来源：`bench/.s4-out/matrix-{standard,compact,detailed,verbose}-completion-all-{long,normal}/summary.json`；表中 permanent 即 matrix 的 lazy 模式。

| preset | fixture | off 首行 | lazy 首行 | off DOM 首/稳 | lazy DOM 首/稳 | off LT 首/稳 | lazy LT 首/稳 |
|---|---|---:|---:|---|---|---|---|
| standard | long | 265.85 | 236.95 | 4114/4122 | 2869/2877 | 142.5/142.5 | 118.5/181.5 |
| compact | long | 263.05 | 230.8 | 4114/4122 | 2869/2877 | 141/141 | 113/132.5 |
| detailed | long | 268.6 | 248.35 | 4114/4122 | 2869/2877 | 135/135 | 122/183.5 |
| verbose | long | 285 | 313.3 | 4112/4120 | 4112/4120 | 195/195 | 173/173 |
| standard | normal | 481.6 | 428.55 | 8598/8604 | 4888/4894 | 325/403.5 | 285.5/380 |
| compact | normal | 474.1 | 421.25 | 8598/8604 | 4888/4894 | 320/397.5 | 269/350 |
| detailed | normal | 494.6 | 448.75 | 8598/8604 | 4888/4894 | 343.5/408 | 284/392.5 |
| verbose | normal | 641.8 | 623.3 | 8588/8594 | 8588/8594 | 522/539 | 547/605 |

- standard/compact/detailed 三档收益稳定；verbose 无占位可折（lazy=0），差异是噪声，不应算收益。
- long 的 settled LT 方向不一致（standard +39、compact -8.5、detailed +48.5 ms），说明 long 第二个 Long Task 仍受负载/fixture 影响。

### 5.3 stock vs opt-in permanent（standard，n=6）

| fixture | click 首行 | DOM 首/稳 | LT 首/稳 | commits |
|---|---|---|---|---|
| long stock/off | 325.35 | 4114/4122 | 162/194.5 | 16 |
| long permanent | 313.55（-3.6%） | 2869/2877（-30.2%） | 146.5/184.5 | 16 |
| normal stock/off | 576.9 | 8598/8604 | 394.5/450 | 16 |
| normal permanent | 528.85（-8.3%） | 4888/4894（-43.1%） | 380.5/469（+19 ms） | 16 |

插件默认 `lazy-groups` 关闭，默认路径本来就是 stock；上表是 opt-in permanent 与 stock 的同轮 A/B。

## 6. 对 D1 的修改建议

把 `docs/research/stage4-revisit.md` D1 从"未证明"改为"**显示揭示 PASS，查找语义 FAIL**"：

- 删除"CDP 没有 FindInPage 域"：page session 支持 `FindInPage.findFirst/findNext/findPrev/stop`；旧结论来自 browser-level session 的 `-32601`。
- 保留但限定"window.find 不触发 beforematch"：成立，但真实 FindInPage 会触发。
- 替换"真实浏览器 find 未验证"：本轮已验证命中、beforematch、hidden 移除、高亮（含 data URL 校准中的滚动）；未观测的是查找栏 UI 的计数/重搜。
- 旧 90.7% 不能证明查找兼容；新报告给出 47.62%/17.86%（严格口径）与 56.66%/37.44%（修正口径）。

建议替换文字：

> 真实 `FindInPage` 已通过 CDP 验证：占位文本可被命中并触发 `beforematch`，原生 group 展开后占位被换回原生，DOM 与 off 一致（lazy 28→0、DOM 2877→4122、aria-expanded=true）。但查找语义不等价：仅占位 token 误报、仅原生 token 漏报、覆盖率不足、活动匹配/高亮在替换时丢失。因此 permanent 只能作为默认关闭的性能实验，不能作为 Ctrl+F 兼容方案。

## 7. GO / NO-GO

| 方案 | 结论 | 理由 |
|---|---|---|
| permanent 默认开启 | **NO-GO** | 查找语义 FAIL；normal settled LT +19 ms；long settled LT 方向不稳定 |
| permanent 默认关闭的 opt-in 实验 | **有条件 GO** | 首行/DOM 收益真实；必须标注"查找不等价"——查找交互有可见缺陷，只能作为性能实验，不能作为查找方案 |
| permanent 作为 Ctrl+F 兼容方案 | **NO-GO** | 误报/漏报/活动匹配丢失是结构性的 |
| progressive | **NO-GO** | 12.9 s / 93 个 Long Task 后台退化 + drain 窗口查找缺口 |
| 阶段 4 默认行为 | **保持默认关闭** | 不改默认、不发布 |

## 8. 剩余风险

1. CDP `FindInPage` 是 `WebContents::Find`，没有浏览器查找栏的 1/N 计数、上下箭头、DOM 替换后的自动重搜；真实 UI 可能显示 0/0，只会更差。
2. findNext/findPrev 在 permanent 替换后的行为只测了一个 token/fixture；data URL 对照只证明命令本身可用。
3. 覆盖率只算 long fixture；normal 85 组未逐 token 重算，raw 数据比例不同可能误报更多。
4. progressive 的 keydown rescue 是 CDP 合成按键；菜单/系统级 find 未验证。
5. 性能 n 小、负载敏感；verbose n=3；long settled LT 方向不一致，不能把 +39 ms 当普适常数。

## 9. 复现与数据

```bash
node bench/run-s4-find-verify.mjs   # host 11033 / CDP 9364
node bench/proto-real-find-vis.mjs  # 11034 / 9365，可见 token 高亮对照
```

- 结果：`bench/.s4-out/find-verify2/result.json`、`off-baseline.json`、`perm-baseline.json`、`*.png`
- 脚本：`bench/run-s4-find-verify.mjs`、`bench/proto-real-find-vis.mjs`
- 旧报告：`docs/research/stage4-revisit.md`（D1 第 115–138 行；真实 find-in-page 结果与边界第 300–330 行）

## 10. 踩坑与反思

- 旧结论把 browser-level session 的 `-32601` 当成"没有 FindInPage 域"；实际 page session 支持，协议能力要看 session 层级。
- token 口径反复：`[data-chat-node-key]` → `document.documentElement.textContent`（含 style/script）→ 最大 flow；分母/正则不固定，覆盖率数字就不可比。
- "有文本"≠"可查找"：占位在 DOM 里可索引，但替换会销毁匹配；progressive 空占位甚至没有可命中的文本。
- `beforematch` 是异步的：0 ms 采样常常还没触发，50–150 ms 才是有效窗口。
- `FindInPage.stop` 结束 session；导航测试必须紧跟 `findFirst`，或重新 `findFirst`。
- headless 页面在后台时 `requestIdleCallback` 不跑；必须 `Page.bringToFront` 才能测自然 drain。
