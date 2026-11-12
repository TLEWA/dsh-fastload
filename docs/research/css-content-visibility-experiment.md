# 阶段 4 备选：纯 CSS content-visibility 懒渲染实验（NO-GO）

> 状态：**NO-GO（初步测量完成，完整 A/B 待补）**。本分支只新增本文档，不提交运行时开关或客户端模块。
> 日期：2026-11-12（Asia/Shanghai）。
> 工作区：`libs/.worktrees/stage4-css`，分支 `feat/css-content-visibility`，基线 `04723c8`（已含 P6 预加载）。
> 范围：只读测量 + 页面内临时注入；未修改 DSH 安装目录 `D:/DSH/resources/app.asar`、上游源码或会话日志。
> 关联：`libs/research/slot-lazy-mount-feasibility.md` 的候选 E；Slot 替换本身已因 children 声明互斥、原生 seat 未导出、卸载破坏 `hidden=until-found` 查找而判定 NO-GO。

## English abstract

A pure-CSS `content-visibility: auto` experiment was run on a long DSH transcript (2,150 anchor rows, 917 chat-node seats, 39,186 DOM nodes, 23,068 px scroll height). The hypothesis was that skipping offscreen rendered rows would reduce scroll/layout cost. The fixture shows the hypothesis has almost no surface: **2,084 of the 2,150 anchor rows already live inside `hidden="until-found"` process groups and are not rendered by the browser at all**; only 66 top-level rows are rendered, and 64 of them are offscreen. Applying measured `contain-intrinsic-size` to those 64 rows kept the scroll height and scroll position exactly stable (0 px drift), but produced **no measurable scroll improvement**: 0 long tasks and the same frame-time distribution with CV on and off. A synthetic offscreen-layout microbenchmark shows an ~18–20% reduction, and a forced-layout probe shows a 6.9 ms → 5.3 ms median, but neither maps to the user-visible first-open/scroll path. The first open and "load older" layout cannot benefit because the module must measure real heights before writing `contain-intrinsic-size`, which happens after those layouts. Combined with stale-size risk on width/zoom changes, the recommendation is **NO-GO**: do not ship a runtime toggle for this technique. Full 5×A/B, CPU-throttled and resize tests are listed as not executed.

---

## 1. 结论先行

1. **目标场景没有被覆盖。** 首次打开与“加载更早”的成本发生在 React 挂载和第一次 layout；本方案要求先测量真实高度再写 `contain-intrinsic-size`，只能在 layout 之后生效，因此对这两个场景是零收益。用估计高度提前套用被任务书明确禁止，也会带来 thumb 跳动。
2. **稳态也没有可测收益。** 折叠组已经由 `hidden="until-found"` 跳过渲染：2150 个 anchor 行中 2084 个在隐藏组内，真正渲染的顶层行只有 66 个。对剩余 64 个离屏行套 CV 后，静止 `scrollHeight` 与 `scrollTop` 完全不变，滚动期间 0 个 long task，帧间隔分布与关闭时相同。
3. **微基准的改善不构成上线理由。** 合成的 300 行离屏布局约快 18–20%（含 DOM 构建），强制 layout 探针中位数 6.9 ms → 5.3 ms（范围重叠，绝对差约 1.6 ms）；这些都不是用户路径上的可感知收益。
4. **风险/复杂度大于收益。** `contain-intrinsic-size: auto <h>` 缓存的是旧宽度下的高度；窗口 resize、缩放、字体变化后，离屏行会保持过期高度，直到被滚入才更新，造成 `scrollHeight` 偏差和 thumb 跳动。要做对必须监听尺寸变化并重新全量测量，等于把省下的 layout 又做一遍。
5. **实现位置与计划稿不一致。** 浏览器端 chunk 必须位于 `client.js` 同目录且匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`；计划中的 `src/client-css-lazy.js` 不会被宿主 chunk 路由加载。若未来重试，浏览器入口应命名为根目录 `client.css-lazy.js`，纯函数放 `src/` 供 Node 单测。

**建议：** 本阶段不落地运行时开关；保留本报告作为测量记录。若未来在“全部展开的 500-turn 会话 + 4–6× CPU 节流”下能复现稳定的滚动 long task，再重新评估，并同时给出 resize/zoom 的高度失效方案。

---

## 2. 环境与 fixture

| 项 | 值 |
|---|---|
| DSH Web GUI | 本机 `http://127.0.0.1:10802` |
| 浏览器 | agent 浏览器（UA 报告 `X11; Linux x86_64`，Chrome/152.0.0.0） |
| 视口 | 778 × 491；transcript 滚动容器 `clientHeight` 409 |
| 会话 | `session-262d33b1-bf51-49f2-bf29-7016ed1216a8` |
| 加载方式 | 侧边栏打开后连续点击“加载更早”5 次 |
| DOM | 2,150 个 `[data-chat-anchor-key]`，917 个 `[data-slot="conversation.chat.node"]`，19 个 `[data-step-process]`，39,186 个元素 |
| 滚动 | `scrollHeight` 23,068；`scrollTop` 22,181（底部） |
| 渲染面 | 83 个顶层 anchor 行；66 个有高度；64 个完全离屏；2,084 个 anchor 行位于 `hidden="until-found"` 子树内 |

关键结构：

- `[data-chat-flow]` 的 3 个直接子节点：older 按钮（高 24）、`display: contents` 行容器（高 0，含 83 个一级行）、textInteraction（高 0）。
- 一级行自身是 `[data-chat-anchor-key]`，父级不是 anchor / `data-step-process-content`；其高度样本为 `[4344, 33, 598, 152, 362, 33, 587, 249, 76, 33]`，最大 4,344 px。
- 折叠的 process 组是 `hidden="until-found"`，组内行高度为 0，浏览器本来就不渲染；任务书也要求不得对它们重复套用 CV。

> 说明：测量期间同机正在跑阶段 0 基线采集（headless Chrome + host 采样），下面的数字是**短跑初步值**，不应当作安静机器上的最终基准。

---

## 3. 方法

### 3.1 应用规则

只处理同时满足以下条件的节点：

1. 顶层 `[data-chat-anchor-key]` 行（父级链上没有 anchor，也不在 `[data-step-process-content]` 内）；
2. 当前有真实高度（`getBoundingClientRect().height > 0`）；
3. 完全在滚动容器视口之外（`rect.bottom <= scRect.top + 1` 或 `rect.top >= scRect.bottom - 1`）；
4. 不在 `hidden="until-found"` 子树内。

对每个节点先读 `offsetHeight`，再写内联：

```css
content-visibility: auto;
contain-intrinsic-size: auto <实测高度>px;
```

并打上 `data-cv-bench` / `data-cv-h` 以便校验与清理。关闭时逐项移除内联属性与标记。

### 3.2 校验与应用结果

| 指标 | 值 |
|---|---|
| 应用行数 | 64 |
| 应用前 `scrollHeight` | 23,068 |
| 应用后 `scrollHeight` | 23,068 |
| `scrollHeight` 差 | 0 px |
| `scrollTop` 应用前/后 | 22,181 / 22,181 |
| 高度漂移行数 / 最大漂移 | 0 / 0 px |
| 计算样式抽查 | `content-visibility: auto`，`contain-intrinsic-size: auto 4344px` |

即“先测量后写入”在该 fixture 上可以做到静止高度与滚动位置零变化。注意 `Element.checkVisibility({contentVisibilityAuto:true})` 在本环境返回 true（即使元素被跳过），不能用作是否跳过的判据；这里以计算样式、相对布局稳定性和滚动数据为准。

### 3.3 滚动 A/B

每个 pass：`scrollTop = 0`，等两帧，然后在 1.2 s 内用 rAF 线性滚到底部；同时用 `PerformanceObserver({type:'longtask'})` 记录 long task，用 rAF 间隔记录帧耗时。基线 / CV 交替各 2 个 pass。

| pass | 帧数 | p50 (ms) | p95 (ms) | max (ms) | >33 ms | long task 数 | long task 总时长 |
|---|---|---|---|---|---|---|---|
| baseline-1 | 348 | 3.3 | 4.2 | 14 | 0 | 0 | 0 |
| baseline-2 | 335 | 3.4 | 5.6 | 10 | 0 | 0 | 0 |
| cv-1 | 346 | 3.3 | 4.2 | 14 | 0 | 0 | 0 |
| cv-2 | 345 | 3.3 | 4.6 | 12 | 0 | 0 | 0 |

重要限制：该浏览器环境的 rAF 没有按 vsync 节流（1.2 s 内约 290 帧），所以 3.3 ms 的 p50 **不是** 60 Hz 下的帧预算，只能用于基线/CV 的相对比较；本次对比的结论是“没有差异”。不能据此声称“滚动达到 290 fps”。

### 3.4 强制 layout 探针

在滚动到底部后，交替把滚动容器 `padding-top` 设为 0 / 1 px，随后读取 `document.body.offsetHeight` 强制 layout，重复 6 次：

| 模式 | 各次耗时 (ms) | 中位数 (ms) |
|---|---|---|
| 关闭 CV | 4.8, 4.3, 5.4, 9.2, 9.8, 6.9 | 6.9 |
| 开启 CV | 5.8, 5.3, 5.2, 5.1, 5.0, 5.7 | 5.3 |

中位数约低 23%，但范围重叠，绝对差约 1.6 ms；且这是整页强制 layout 的合成动作，不是用户可见路径。

### 3.5 合成离屏布局微基准

创建 300 个 40 px 行（合计 12,000 px）的离屏容器（`top: -20000px`），其中 CV 组带 `content-visibility:auto; contain-intrinsic-size:auto 12000px`，计时包含 DOM 构建、插入和一次 `offsetHeight`：

| 模式 | 各次耗时 (ms) | 高度 |
|---|---|---|
| 关闭 CV | 44.6, 39.5, 38.8 | 12,000 |
| 开启 CV | 33.0, 31.6, 32.3 | 12,000 |

约快 18–20%，说明机制本身有效；但计时包含 DOM 构建，且这是“新插入且从未布局”的离屏内容，与 transcript 的稳态滚动不是同一场景。

---

## 4. 为什么判 NO-GO

### 4.1 大头已经被 `hidden="until-found"` 跳过

2,150 个 anchor 行中 2,084 个在折叠组内，组本身是 `hidden="until-found"`，浏览器已经不渲染其子树。CV 只能跳过“已经渲染但离屏”的盒子；对已经隐藏的 2,084 行再套 CV 既无收益，也被任务书禁止。剩下可作用的对象只有 66 个渲染行中的 64 个，而它们的滚动成本已经是 0 long task、p95 4–6 ms。

### 4.2 首次打开与“加载更早”在测量之后

React 挂载 → 浏览器 layout → 我们才能读到真实高度 → 再写 `contain-intrinsic-size`。当这段代码运行时，首屏/新插入页的 layout 已经发生，CV 无法回收这次成本。若在 layout 前用估计高度，则违反“必须先测量真实高度”的硬性要求，并直接引入 thumb 跳动风险。**这是结构性矛盾，不是参数调优问题。**

### 4.3 稳态 relayout 的收益不足以抵消风险

真实会话里可能触发 relayout 的动作是窗口 resize、侧栏开合、主题/字体变化、宿主插入新页。CV 对“已布局的离屏行”的强制 layout 有小幅帮助（3.4 节），但：

- `contain-intrinsic-size: auto <h>` 记忆的是旧宽度下的高度；宽度/缩放变化后，离屏行高度过期，滚入时才更新，`scrollHeight` 与 thumb 会跳。要避免就得在 resize 时清掉 CV、重新测量全部行，等于把 layout 再做一遍。
- 需要额外处理 `focusin` / `beforematch` / 文本选择 / Ctrl+F：CV 行被查找或聚焦时可能临时展开，高度变化会改变锚点；任务书要求监听并临时移除 CV，这又引入状态机与清理复杂度。
- 每行内联样式 + 观察器的维护成本，与 0 可测收益不匹配。

### 4.4 加载器约束（若未来重试）

`dsh-client-modules` 的 package-local chunk 只接受与 `client.js` 同目录、且文件名匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` 的文件。计划稿里的 `src/client-css-lazy.js` 不会被 `/plugins/<id>/<fileName>?rev=...` 路由提供；正确拆分是：

- 浏览器入口：仓库根 `client.css-lazy.js`（由 `client.js` 里 `require.async('./client.css-lazy.js')` 加载，`__ModuleLoader__.load({ id, chunk: 'client.css-lazy.js', factory(require){...} })` 注册）；
- 纯逻辑（选择器、候选过滤、高度记录、清理）：`src/css-lazy.js`，供 `node --test` 直接 require；
- `client.js` 只加开关读取与一次 `require.async`，默认关闭，失败静默回退。

---

## 5. 风险清单（若强行落地）

| 风险 | 触发条件 | 影响 | 现有对策 |
|---|---|---|---|
| 过期 intrinsic size | 窗口/侧栏宽度变化、浏览器缩放、字体设置变化 | 离屏行保持旧高度；滚入时高度跳变，`scrollHeight` 偏差、thumb 跳动 | 需 resize/zoom 时清除并重新测量；本次未实现 |
| 查找/聚焦展开 | Ctrl+F、Tab 聚焦、文本选择跨 CV 行 | 行被临时渲染，高度/滚动位置变化 | 需监听 `focusin`/`beforematch` 并临时移除 CV；本次未实现 |
| 折叠组重复套用 | 对 `hidden="until-found"` 子树内的行套 CV | 无收益，且可能与浏览器查找展开冲突 | 候选项已排除隐藏子树 |
| 卸载残留 | 插件禁用/热重载 | 内联样式与观察器残留，行为不一致 | 需要完整 cleanup；本次未实现 |
| 误判“有收益” | 用未节流 rAF 帧耗时或合成 layout 探针下结论 | 上线后无可感知改善 | 本文明确区分微基准与用户路径 |

---

## 6. 未执行项

以下项目本次**未执行**，不得在后续汇报中当作已完成：

- 完整真实浏览器 A/B（on/off 各 ≥5 次、交替、取中位数与范围）：**未执行**。等待阶段 0 基线采集结束，避免同机 CPU/事件循环污染。
- 4–6× CPU 节流下的滚动 A/B：**未执行**。
- 首屏首行可见时间：**未执行（且本方案结构上不影响首屏）**。
- 窗口 resize / 浏览器缩放 / 字体变化下的 thumb 跳动实测：**未执行**（仅做静态风险分析）。
- 全部 process 组展开后的 500-turn 级 fixture：**未执行**。
- 官方 241-turn fixture 对照：**未执行**。
- 真实 Ctrl+F / 文本选择 / turn rail 跳转回归：**未执行**。
- `npm test` 与 `dsh-ci-gate`：见提交说明（文档改动后运行）。

---

## 7. 复现要点

1. 打开长会话，连续点“加载更早”直到 `scrollHeight` 稳定。
2. 在页面里定位 transcript 滚动容器（`[data-chat-flow]` 向上找 `overflow-y: auto|scroll`）。
3. 枚举顶层 anchor 行，按 3.1 的条件筛选，先读 `offsetHeight` 再写内联 CV。
4. 应用前后比较 `scrollHeight`、`scrollTop`、每行 `offsetHeight`；滚动 A/B 用 `PerformanceObserver({type:'longtask'})` + rAF 间隔。
5. 测量结束逐项移除 `content-visibility`、`contain-intrinsic-size`、`data-cv-bench`、`data-cv-h`。

> 页面注入脚本只在 agent 浏览器会话内临时存在，未写入仓库、未进入产品代码。

---

## 8. 后续建议

- **不提交** `client.css-lazy.js`、`src/css-lazy.js` 或任何运行时开关；本阶段以报告收尾。
- 若未来仍要验证 CV，先构造“全部展开 + 大量离屏已渲染行 + 4–6× CPU 节流”的场景，证明存在稳定 long task；同时给出 resize/zoom 的高度失效方案，再谈实现。
- 首次打开的真正杠杆仍是页预算、尾帧直读与挂载量（见 `dsh-long-session-first-open.md`），不是 CSS 离屏跳过。
