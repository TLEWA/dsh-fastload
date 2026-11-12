# dsh-fastload 阶段 8 最终集成、回归、性能对照与发布准备报告

> 状态：**本地集成完成，待发布评审**。日期：2026-11-12（Asia/Shanghai）。
> 仓库：`C:/Users/TLEWA/Desktop/DSHs/dsh-plugins/dsh-fastload`，独立 git 仓，基线 `main` =
> `04723c8`。工作树：`libs/.worktrees/stage8-release`。分支：`feat/optimization-final`。
> 范围：只改插件仓；未改 DSH 上游或 `app.asar`；未改会话原始日志；未 push、未打 tag、
> 未改版本号、未发布。所有侵入性优化仍默认关闭。
> 关联：`plugin-optimization-baseline.md`（阶段 0）、`css-content-visibility-experiment.md`
> （阶段 4）、`docs/design.md`（阶段 5/7/8 决策）、`AGENTS.md`（私有接口与能力检测）。

## 1. 结论摘要

1. **集成完成。** 阶段 2+3+6 集成头 `b4a9966` 依次合并阶段 5、阶段 0、阶段 4，形成
   `feat/optimization-final`；合并保留阶段 5 的 index.js 时序、阶段 3 的 cache-refresh、
   阶段 0 的 bench/docs 与阶段 4 的 CSS NO-GO 报告，工作区干净。
2. **回归通过。** 16 项矩阵中 12 项通过、0 项失败、4 项完全未执行、2 项部分覆盖；所有
   可执行项均无页面异常、无测试失败。`npm test` 112/112，`dsh-ci-gate` PASS
   （16 ok / 0 warn / 0 fail / 2 skip）。
3. **A/B 无回归、无可测收益。** 同一 fixture、同一 DSH 0.2.2-rc.1、同一 Chrome
   157.0.8103.52 下各 10 次缓存命中：normal 中位 467.7 ms（全关）对 467.2 ms（全开），
   long 234.9 ms 对 249.4 ms，差异在噪声范围内；WS 字节、records、DOM 与 React commit
   完全一致。全开组 Host 峰值 WorkingSet 高约 33.5 MiB（529 MiB / 555,114,496 B →
   563 MiB / 590,184,448 B，6.3%），需要发布评审确认是否接受。
4. **阶段 7 不实施。** 7A（客户端事件校验优化）与 7B（私有只读尾部读取器）均无硬数据
   支持；本次 A/B 中点击窗口只有 1 个 >50 ms Long Task，与 React mount 的
   snapshot→首行同量级，没有校验/尾部读取归因证据。重访条件见第 4 节。
5. **发布建议：有条件进入发布评审，不直接发布。** 条件：人工确认 defer 开关保留策略、
   桌面 GUI 回归、PR/CI/review 与版本决策；这些不在本分支权限内。

## 2. 实施结果

### 2.1 分支与合并提交

| 项 | 值 |
|---|---|
| 基线 | `main` `04723c8` |
| 集成分支 | `feat/optimization-final`（`libs/.worktrees/stage8-release`） |
| 起点 | `feat/optimization-integration` `b4a9966`（阶段 2+3+6） |
| merge 阶段 5 | `3443135`，来源 `feat/defer-live-build` `2de7618` |
| merge 阶段 0 | `cae8fe2`，来源 `perf/optimization-baseline` `1a0349f` |
| merge 阶段 4 | `af323bc`，来源 `feat/css-content-visibility` `bcc73f9` |
| 合并方式 | 三次 `git merge --no-ff`；冲突按“保留全部功能”解决 |
| 工作区 | 文档随本分支提交；提交后工作区干净，未 push |

合并后的功能保留核对：

- 阶段 5：`src/defer-live-build.js`、`index.js` 中缓存帧发送与真实 follow 之间的
  可取消延后、`serve.log` 的 `timing` 行；默认关闭。
- 阶段 3：`src/cache-refresh.js` 与 `src/page-cache.js` 的 idle refresh 路径；
  `DSH_FASTLOAD_IDLE_CACHE_REFRESH` 默认 `0`。
- 阶段 0：`bench/` 工具、`docs/research/plugin-optimization-baseline.md`。
- 阶段 4：`docs/research/css-content-visibility-experiment.md`（NO-GO，仅文档）。
- 阶段 2+3+6：P6 悬停/启动预热、页缓存、首屏瘦身、自愈与补页仍由 `b4a9966` 提供。

### 2.2 改动文件统计

集成分支相对 `main` 的代码、bench 与既有文档改动（本次阶段 8 文档提交前）为
**34 个文件，+6280 / −81 行**；文档提交另触及 8 个文件（新增本报告 + 修改 7 份
配套文档），最终 diff 为 35 个文件、+6799 / −81 行。主要文件：

| 类别 | 文件 |
|---|---|
| 运行时 | `index.js`、`client.js`、`src/config.js`、`src/page-cache.js`、`src/cache-refresh.js`、`src/defer-live-build.js` |
| 测试 | `test/plugin.test.js`、`test/trim.test.js`、`test/package.test.js`、`test/cache-refresh.test.js`、`test/defer-live-build.test.js` |
| 基准工具 | `bench/run.mjs`、`bench/report.mjs`、`bench/lib/*.mjs`、`bench/lib/host-sampler.ps1`、`bench/README.md` |
| 文档 | `README.md`、`README.en.md`、`CHANGELOG.md`、`CHANGELOG.en.md`、`AGENTS.md`、`docs/design.md`、`docs/research/*` |

本阶段新增/修改的文档（随本分支提交）：

- `README.md` / `README.en.md`：新增“卸载、禁用与回退”，逐项说明 disposer 还原
  `follow`、停止计时器/监听/在飞构建、取消延后、flush 页缓存；缓存目录可手删；
  不改会话日志/选择/Session Store；补充 final report 链接。
- `CHANGELOG.md` / `CHANGELOG.en.md`：`Unreleased` 顶部新增双语阶段 8 条目。
- `AGENTS.md`：新增“私有接口与能力检测（阶段 8）”，列出版本检测、未知版本退化与测试要求。
- `docs/design.md`：新增阶段 4 NO-GO、阶段 5 结论引用、阶段 7 决策、阶段 8 集成四节。
- `bench/README.md` / `bench/lib/measure.mjs`：支持 `BENCH_DOC_START_JS` 在 document-start
  注入客户端开关，供同 fixture 的客户端 A/B 使用。

### 2.3 开关与默认值（逐项核对）

Host 端环境变量：

| 开关 | 默认 | 行为 | 本阶段验证 |
|---|---:|---|---|
| `DSH_FASTLOAD_ENABLED` | `1` | 总开关；`0` 关闭 Host 首屏改写与裁剪 | 既有行为，未改 |
| `DSH_FASTLOAD_PAGE_CACHE` | `1` | 页缓存；损坏时回退 live | 矩阵 cache-corrupt 通过 |
| `DSH_FASTLOAD_SCAN_CACHE` | `1` | 会话头索引/TTL memo | 既有行为，未改 |
| `DSH_FASTLOAD_STRIP_STREAM` | `1` | 首帧剥离 replay 用 `data.stream` | 既有行为，未改 |
| `DSH_FASTLOAD_REWIND_AWARE` | `1` | 初始页被 `/rewind` 全隐藏时向前扩一页 | 单测覆盖；真机未执行（无夹具） |
| `DSH_FASTLOAD_IDLE_CACHE_REFRESH` | `0` | 空闲只读 follow 预热页缓存 | A/B 全开组开启；默认关已核对 |
| `DSH_FASTLOAD_DEFER_LIVE_BUILD` | `0` | 缓存帧后最多延后真实 follow 16 ms | A/B 全开组开启；实测未触发（见 5.3） |
| `DSH_FASTLOAD_SERVE_LOG` | `1` | 写 `serve.log`（512 KiB 轮转） | 矩阵/A-B 均读取成功 |
| `DSH_FASTLOAD_DEBUG` | `0` | 每次裁切写一条日志 | 未作为发布开关 |
| `DSH_FASTLOAD_CACHE_DIR` | 空 | 缓存目录；空 = `$DSH_HOME/cache/dsh-fastload` | 隔离 home 验证 |

客户端开关（不进环境变量）：

| 开关 | 默认 | 行为 | 本阶段结论 |
|---|---:|---|---|
| 悬停预测预热 `localStorage['dsh-fastload.prewarm']` / `window.__DSH_FASTLOAD_PREWARM__` | **开** | 悬停会话行时预取首页 | 0.3.1 已发布行为，本阶段未改极性；没有 `DSH_FASTLOAD_PREWARM` 环境变量 |
| 启动预热 `localStorage['dsh-fastload.restore-prewarm']` / `window.__DSH_FASTLOAD_RESTORE_PREWARM__` | `0`（关） | 启动后预热上次选中会话 | 只有 `'1'` / `true` 才开；A/B 全开组显式开 |
| 诊断 `localStorage['dsh-fastload.diagnostics']` / `window.__DSH_FASTLOAD_DIAGNOSTICS__` | `0`（关） | Fiber 取证、error 收集、额外轮询 | 默认关已核对；关闭时不增加监听/计时器 |

说明：任务清单中的“`DSH_FASTLOAD_PREWARM`（若存在）”经代码检索**不存在**为 Host
环境变量；存在的只有客户端键 `window.__DSH_FASTLOAD_PREWARM__`（以及同名
localStorage 键），其默认值沿用 0.3.1 的“开”。本阶段新增的侵入项
（restore-prewarm、idle refresh、defer live build、diagnostics）全部默认关。

## 3. 阶段 7 决策（不实现 7A/7B）

计划只在有硬数据时实施阶段 7。本阶段结论：**数据不支持，7A 与 7B 均不实施**，
不新增任何客户端校验流水线或私有尾部读取器。依据：

- **7A 客户端事件校验：** 阶段 8 的 20 次缓存命中打开中，点击窗口只有 1 个
  `>50 ms` Long Task，normal 中位 303 ms、long 中位 120.5 ms；它与
  `snapshot→首行`（normal 319.7 ms、long 129.1 ms）几乎同宽，且发生在快照到达后、
  首次可见行前，归因于 React 挂载/渲染，而不是逐事件校验。若校验是瓶颈，应看到
  多个与事件数量成比例的 task；实测没有。
- **7B 私有尾部读取器：** 它只对冷构建或缓存未命中有效。阶段 5 测得暖缓存命中的
  真实 follow 构建仅 4–5 ms，warm live open 约 24 ms；冷 Host 构建 112–239 ms。
  本阶段首行成本主要由 renderer 的 `snapshot→首行`（normal 319.7 ms、long
  129.1 ms）决定，Host 构建不在关键路径。7B 还要读取私有日志字节/布局，收益低于
  噪声而兼容风险高。
- **阶段 5 直接证据：** 缓存帧发出后 11–20 ms 到达 live frame；首行在缓存帧后约
  170 ms、在 live frame 后约 155 ms 出现；延后 3.7–8 ms 不可能影响首绘。
- **重访条件：** 真实 profile 把 `>50 ms` task 归因到校验/尾部读取；或
  first-row-after-live-frame 降到 30 ms 以下且 Host 构建仍 `>100 ms`。达到任一条件
  再开阶段 7，不提前实现。

本阶段未发现相反证据；唯一的大 Long Task 已按 React mount 解释，且与 7A/7B 无关联。

## 4. 正确性：16 项回归矩阵

### 4.1 环境与命令

- 隔离 `DSH_HOME`：`libs/.worktrees/stage8-release/bench/.home`（从
  `libs/bench/home` 复制的 533 会话夹具）。
- DSH：`bench/.tools/dsh022` 的 `@deepseek-ai/dsh@0.2.2-rc.1` CLI（
  `node .../lib/bin.js web --no-open`）。
- 浏览器：headless Chrome 157.0.8103.52，CDP 9513；host 4213（避开 10802、
  10921、9341、9337）。
- 矩阵脚本：`libs/bench/stage8/matrix.mjs`（bench 工具目录 gitignore，不随仓库发布）。
- 自动化命令：

```bash
cd C:/Users/TLEWA/Desktop/DSHs/dsh-plugins
node libs/bench/stage8/matrix.mjs \
  --repo C:/Users/TLEWA/Desktop/DSHs/dsh-plugins/libs/.worktrees/stage8-release \
  --home .../bench/.home --workspace C:/Users/TLEWA/Desktop/DSHs/dsh-plugins \
  --host-port 4213 --cdp-port 9513 \
  --out .../bench/results/stage8-matrix-final
# 未执行项单独留证：
node libs/bench/stage8/matrix.mjs ... --cases live,rewind,approval,multiwrap,hotreload,release \
  --out .../bench/results/stage8-matrix-unexec
```

矩阵结果文件：`bench/results/stage8-matrix-final/{matrix.json,summary.json,matrix.log}`
与 `bench/results/stage8-matrix-unexec/`。汇总：13 个已执行记录中 12 通过、0 失败、
1 未执行（子代理）；未执行项补跑留证 5 条（全部 `ok:null`）+ 资源释放 1 条通过。

### 4.2 逐项结果

| # | 场景 | 方式 | 结果 | 证据 / 复现 |
|---|---|---|---|---|
| 1 | 普通短会话 | 侧栏打开 16 msg / 1 turn / 10 tools | **通过** | hit=1、live=1；flow 子节点 7、可见 5；snapshot 272 records；无页面异常 |
| 2 | 普通长会话 | 侧栏打开 106 msg / 6 turns / 85 tools | **通过** | live=1、store=1；flow 27/21；snapshot 883 records；无异常 |
| 3 | 单 turn 大量工具调用 | 侧栏打开 76 msg / 1 turn / 70 tools | **通过** | live=1、store=1；flow 7/5；snapshot 658 records |
| 4 | 两个超大 turn | 侧栏打开 749 msg / 2 turns / 730 tools | **通过** | live=1、store=1；flow 8/8；snapshot 562 records；无异常 |
| 5 | 空白会话 | 新建零事件 draft，再打开 | **通过** | 页面正常挂载、flow 为空、无插件错误；hit=1、live=1；不触发多余 view load |
| 6 | 含 `/rewind` | 真机 | **未执行** | 533 个夹具会话均无 rewind 记录；`rewindAware`/protectSeq 由 `test/plugin.test.js` 单测覆盖，不能替代真机 |
| 7 | 连续写入中 | 真机 | **未执行** | 需要真实运行中的 agent 持续写日志；只读夹具无法在不产生副作用的前提下模拟 |
| 8 | 待审批与未闭合回合 | 真机 | **未执行** | 所有夹具 turn 均已 `turn/end`，无待审批/未闭合样本；需真实 agent 交互 |
| 9 | 子代理会话 | 真机打开 | **未执行** | 夹具 `260e9263` 的 origin=subagent、不归属 workspace，侧栏列表不可达；父会话中的 subagent 卡片渲染已由 normal/long 覆盖 |
| 10 | 历史翻页与跳转 | 点击页面自有“加载更早”按钮 4 次 | **通过** | 每次翻页后 flow 保持在 10 个子节点/8 可见；hit/live 正常；无异常 |
| 11 | WS 断开重连 | CDP 断网/恢复，统计重连前后帧 | **通过** | 重连前后均有 snapshot；hit=2、live=2；flow 10/8；无异常 |
| 12 | 页缓存损坏 | 将缓存文件截断 50% 后打开 | **通过** | 插件回退 live，store 重新写入；flow 10/8；无页面异常 |
| 13 | 插件禁用/卸载/热重载 | 从 profile bundles 移除并重载页面；热重载另测 | **部分通过** | 禁用/卸载：客户端层消失（client=false），flow 仍 17/13，页面可用；热重载**未执行**：Host 未提供不改上游的模块热重载入口 |
| 14 | 多插件包装同一 Host 方法 | 真实第二插件 + 单测 | **部分覆盖** | 运行中只有 `dsh-rewind-plugin`，它包装 Chat builder 而非 `sessionController.follow`，没有第二插件可测；`test/plugin.test.js` 覆盖 `__dshFastload` 幂等守卫与 dispose 还原 |
| 15 | 切换会话时预热取消 | 预热排队时切换会话 | **通过** | prewarm 队列被取消/跳过，目标会话正常 live；无异常页面错误 |
| 16 | 页面关闭与 Host 停止资源释放 | 关闭 target 后停 host | **通过** | stop 223 ms，无残留 listener；host PID 已退出；serve.log 大小稳定 |

统计口径：第 13 项按“禁用/卸载通过 + 热重载未执行”拆开；第 14 项按部分覆盖计。
因此 16 项 = **12 通过 + 0 失败 + 4 完全未执行（6/7/8/9）+ 2 部分覆盖（13 的热重载、
14）**。矩阵 JSON 中 12 个 `ok:true`、6 个 `ok:null`、0 个 `ok:false`。

### 4.3 自动化测试

| 命令 | 结果 |
|---|---|
| `npm test` | **112/112 passed**（2.36 s，Node 24.22.1） |
| `npx --yes --package=github:TLEWA/dsh-plugin-ci#v1 dsh-ci-gate` | **PASS**：16 ok / 0 warn / 0 fail / 2 skip；manifest `dsh-fastload@0.3.1`；skip 为 `artifacts.fresh`、`typecheck` |

gate 的 2 个 skip 是仓库既有的无构建产物/无 TS 配置场景，不是本阶段引入。
最终复跑时 GitHub 恰好不可达（`git ls-remote` 在 21 s 后返回 128），因此改用
npm `_npx` 缓存中同一次 `npx` 安装的 `dsh-plugin-ci@1.2.0` 直接执行
`scripts/ci-gate.mjs`；检查项与早先 `npx` 运行一致，均为 PASS。

## 5. 性能对照（全关 vs 全开）

### 5.1 方法

- fixture 与 DSH 版本同前；`bench/run.mjs --scenarios cache-hit --samples-filter
  normal,long --reps 10`；每个样本先 prime 一次页缓存，再测 10 次命中。
- OFF 组：Host 默认环境 + `BENCH_DOC_START_JS` 关闭客户端 prewarm/restore。
- ON 组：`DSH_FASTLOAD_IDLE_CACHE_REFRESH=1`、`DSH_FASTLOAD_DEFER_LIVE_BUILD=1`，
  客户端 prewarm/restore 打开。
- 同一 Chrome 157.0.8103.52 重跑 OFF（Chrome 在两组之间自动从 .50 升到 .52，首轮
  OFF 作废、不作为对照）；两组各 20 次有效运行，全部 cache hit。
- 运行期间另一子代理（桌面拖拽排查）并发，未做 CPU 隔离；结果含机器噪声，中位数
  与范围同时报告。

### 5.2 结果表（中位 [min–max]，n=10/样本）

| 指标 | 场景 | 全关 OFF | 全开 ON | 阶段 0 基线（cache-hit） |
|---|---|---:|---:|---:|
| 点击→首个可见行 ms | normal | 467.7 [340.2–512.3] | 467.2 [450.8–543.5] | 418.3 [398.5–581.5] |
|  | long | 234.9 [190.6–278.1] | 249.4 [222.9–280.8] | 298.1 [214.2–338.1] |
| 点击→follow 请求 ms | normal | 84.0 [62.8–99.3] | 87.8 [80.2–97.2] | 67.8 [63.5–100.5] |
|  | long | 72.9 [62.0–92.1] | 77.6 [64.8–91.7] | 92.7 [68.6–107.2] |
| follow→snapshot ms | normal | 54.6 [43.9–62.4] | 55.6 [52.4–61.9] | 53.7 [50.0–65.4] |
|  | long | 33.0 [26.3–38.0] | 32.5 [29.9–40.7] | 43.5 [35.5–68.2] |
| snapshot→首行 ms（Renderer） | normal | 319.7 [231.3–361.2] | 325.5 [313.5–384.4] | 296.4 [280.5–421.7] |
|  | long | 129.1 [102.3–151.2] | 138.7 [122.1–152.4] | 160.8 [110.1–172.1] |
| 首屏 WS 入站字节（snapshot） | normal | 1,557,224（1.49 MiB） | 1,557,224（1.49 MiB） | 1,557,224（1.49 MiB） |
|  | long | 750,488 | 750,488 | 750,488 |
| 首屏 records | normal / long | 883 / 329 | 883 / 329 | 883 / 329 |
| DOM 节点（首行时） | normal / long | 8619 / 4135 | 8619 / 4135 | 8678 / 4105 |
| React commit（首行前） | normal / long | 10 / 10 | 10 / 10 | 未采集 |
| React commit（点击后首次）ms | normal | 53.5 [39.9–65.9] | 57.8 [50.7–62.5] | 未采集 |
|  | long | 48.5 [39.0–59.4] | 51.1 [41.6–61.1] | 未采集 |
| >50 ms Long Task（点击→首行） | normal | 1 个，303 [218–340] ms | 1 个，307 [293–362] ms | 1 个，281 [266–403] ms |
|  | long | 1 个，120.5 [94–140] ms | 1 个，128.5 [113–142] ms | 1 个，147.5 [101–156] ms |
| >50 ms Long Task（页面加载） | normal | 5 个，708 [417–733] ms | 5 个，710.5 [687–774] ms | 未采集 |
|  | long | 5 个，646 [426–751] ms | 5 个，673.5 [587–712] ms | 未采集 |
| Host open→hit ms（读取） | normal | 19.5 [14–25] | 19.5 [17–22] | 22.5 [20.0–29.0] |
|  | long | 15.0 [12–18] | 14.0 [13–21] | 23.0 [20.0–29.0] |
| Host open→live ms | normal | 42.0 [33–50] | 44.0 [40–48] | 未采集 |
|  | long | 28.5 [22–33] | 28.0 [26–35] | 未采集 |
| Host first frame ms | normal | 41.1 [31.9–49.0] | 42.5 [39.8–47.8] | 未采集 |
|  | long | 27.6 [21.5–32.4] | 27.5 [25.5–33.8] | 未采集 |
| Host CPU 秒（单次打开） | normal | 0.109 [0.063–0.406] | 0.094 [0.063–0.141] | 未单列（阶段 0 逐次原始值 0.063） |
|  | long | 0.070 [0.031–0.141] | 0.047 [0.031–0.359] | 未单列 |
| Host 峰值 WorkingSet（进程级，全组最大） | normal+long | 555,114,496 B（529 MiB） | 590,184,448 B（563 MiB） | 未采集 |
| Renderer JS heap 峰值 | 两者 | **未采集** | **未采集** | 未采集 |
| 缓存命中率 | 两者 | 20/20（100%） | 20/20（100%） | 阶段0 20/20 |
| 缓存读取耗时（open→hit） | 同上 | 15–19.5 ms | 14–19.5 ms | 22.5/23.0 ms |

说明：

- 首屏 WS 入站字节与 records 两组完全一致，说明开关没有改变首帧内容；DOM、React commit
  也一致。
- Renderer 内存未采集：bench 的 CDP 探针没有读取 `JSHeapUsedSize`，本阶段没有为了
  补一个指标重跑 40 次；Host 侧用 50 ms 采样 WorkingSet，作为内存峰值的可用证据。
- OFF 与 ON 的 Host 峰值 WorkingSet 均取进程采样最大值；ON 的 563 MiB 在两样本都
  出现，OFF 为 529 MiB，差距约 33.5 MiB（6.3%）。可能来自 idle refresh/预热保留的页缓存
  与额外工作集，样本量不足以做显著性结论，但应在发布评审中知悉。

### 5.3 关键发现：defer 在 0.2.2-rc.1 真实打开中不生效

ON 组 20 条 `serve.log` timing 全部 `defer=0.0`、`deferReason=activate`。原因是
`src/defer-live-build.js:135` 的门禁：

```js
if (!follow || follow.activate === true) {
  return { deferred: false, reason: 'activate', waitedMs: 0, slices: 0 };
}
```

0.2.2-rc.1 的 session restore 对真实打开硬编码 `activate: true`，因此“延后真实
follow”对被用户点开的请求是 no-op；本 A/B 的 ON 组实际只开启了 idle refresh 与
prewarm/restore，并未测到 defer 的收益。报告不把 ON/OFF 差异归因于 defer。该结果
与阶段 5 在 0.2.1-rc.5 上的结论一致：defer 只对 `activate !== true` 的被动请求
生效；默认关闭是安全的。若未来客户端改为被动恢复，可复测；否则该开关是后续清理
候选。

### 5.4 判读

- normal 两组中位差 0.5 ms（0.1%），long 差 +14.5 ms（6.2%），但 ON 的 249.4 ms
  仍落在 OFF 的 [190.6–278.1] 范围内；没有一致的回归方向。
- 与阶段 0 基线相比，OFF normal 慢约 49 ms，long 快约 63 ms，方向相反且范围重叠，
  加上并发子代理噪声，不能声称本分支相对基线有改善或回归。
- 结论：**当前开关组合在缓存命中路径上没有可测收益，也没有可测回归**；收益证据
  不足以支持默认开启任何实验开关。

## 6. 风险

### 6.1 私有 API 依赖与降级

| 私有接口 | 用途 | 检测 / 降级 |
|---|---|---|
| `sessionController.follow` 包装 | 缓存命中时先发缓存帧、再发 live；统计 timing | 只在函数存在时包装；已包装标记 `__dshFastload` 幂等；dispose 还原原函数；缺失则完全不介入 |
| `sessionPersistence.stat` / 请求形状 | 读取 revision、判断 initial page 与 `beforeSeq/throughSeq` | 字段缺失/形状未知时按“不命中”处理，回退原 follow；不猜测 |
| `agents` 服务状态 | idle refresh / defer 判断 Agent 是否 idle | `ctx.get('agents')` 或 `service.get(sessionId)` 缺失、抛错、状态未知 → 视为 busy/unknown，拒绝预热或延后 |
| `session/event`、`agent/status`、`session/disposed` | 订阅空闲/状态变化/销毁，取消在飞与延后构建 | 事件不存在则只依赖 timer + 请求生命周期；dispose 兜底取消 |
| `uiWorkspace.mainReference` | 客户端定位当前 workspace/选中会话 | 不存在/形状不符时跳过启动预热，不影响手动打开与 hover 预热 |
| page cache lookup/store/flush | 首屏快照持久化 | 目录不可写、文件损坏、版本不符 → 当作 miss，回退 live；flush 失败只记日志 |
| `ctx.remote.session.follow` | 客户端触发预热请求 | 缺失时 hover/restore 预热关闭，普通打开仍走 Host |

总体降级策略：**任何未知版本、缺失服务、异常形状都退化为 stock 路径**，不阻断
会话打开；没有“必须成功”的私有调用。详细检测点与单测要求见 `AGENTS.md`
“私有接口与能力检测（阶段 8）”。

### 6.2 版本兼容

- 只在 Windows + DSH CLI `0.2.2-rc.1` + headless Chrome 157 上做了真机验证；
  未验证桌面 Electron 外壳、Linux/macOS、其他 DSH 版本。
- 包声明 `engines.dsh >= 0.2.0-rc.1`，但本阶段不是全版本兼容性证明。
- 0.2.2-rc.1 的 `activate:true` 使 defer 开关成为 no-op（见 5.3），这是版本相关
  行为，不是崩溃风险。

### 6.3 回退与卸载

- 所有实验开关默认关；关掉即回到阶段 2/3/6 的默认路径，不需要迁移数据。
- 禁用/卸载由 disposer 还原 `follow`、删除 `__dshFastload`、停止 idle timer/
  监听/在飞构建、取消未执行延后、flush 页缓存；矩阵 plugin-disabled 已验证页面
  仍可用。
- 页缓存与 `serve.log` 留在 `$DSH_HOME/cache/dsh-fastload`，stock 不读取，可手删；
  插件从不改会话日志/选择/Session Store。
- 未做热重载真机验证：Host 无公开热重载入口；若通过外部工具强制重载模块，
  disposer 语义仍应生效，但本阶段没有证据。

### 6.4 测量风险

- 与另一子代理并发，未做 CPU 隔离/节流；OFF normal 的慢于基线很可能包含噪声。
- 每组 10 次、单机单 fixture；Chrome 在两组间自动升级，已用同一 .52 重跑 OFF。
- bench 用 JS `element.click()`，不触发真实鼠标 hover，因此 ON 组的 hover 预热
  未被实际触发；restore/idle 也只能部分覆盖。
- Renderer JS heap 未采集；Host WorkingSet 是进程级，不是精确的插件增量。
- 页面缓存命中率 100% 是 bench prime 后的结果，不代表冷启动或真实用户分布。

## 7. 未执行项（逐条）

1. **`/rewind` 真机回归** —— 未执行：533 个夹具无 rewind 会话；单测覆盖
   `rewindAware`/protectSeq，但未在真实 GUI 验证。
2. **连续写入中的会话打开** —— 未执行：需要运行中的 agent 持续写日志，只读夹具
   无法无副作用模拟。
3. **待审批/未闭合回合** —— 未执行：夹具所有 turn 已闭合，无 approval 样本。
4. **子代理会话真机打开** —— 未执行：子代理会话不归属 workspace，侧栏不可达。
5. **Host 模块热重载** —— 未执行：无公开、无需改上游的热重载入口；禁用/卸载已测。
6. **多插件真实包装同一 Host 方法** —— 未执行：运行环境只有包装 Chat builder 的
   `dsh-rewind-plugin`，没有第二个包装 `follow` 的插件；仅单测幂等/还原。
7. **桌面 GUI（Electron）回归** —— 未执行：本阶段只测 CLI + Web SPA + headless
   Chrome；桌面外壳需要人工真机。
8. **冷 Host / 冷缓存 A/B** —— 未执行：本阶段按任务只测缓存命中路径；阶段 0 已有
   cold-host 基线，但未用最终集成分支重跑。
9. **CPU 节流/低配设备** —— 未执行：无 4–6× throttle 测量，不能外推低端机。
10. **5× CSS A/B、resize/zoom 失效测试** —— 未执行：阶段 4 已 NO-GO，本阶段不
    重复实验。
11. **Push / PR / 远程 CI / review** —— 未执行：任务明确禁止 push；只有本地 gate。
12. **版本号、npm pack、publish、tag** —— 未执行：任务明确禁止。
13. **Renderer JS heap 峰值** —— 未采集（见 5.2 说明）。
14. **真实鼠标 hover 预热路径** —— 未执行：bench 用 JS click，不产生 hover。

## 8. 下一步与发布建议

建议顺序：

1. 人工评审本分支与最终报告，确认是否保留 `DSH_FASTLOAD_DEFER_LIVE_BUILD`
   （当前默认关且在 0.2.2-rc.1 no-op），或把它标记为移除候选。
2. 在真实桌面 GUI 做一次手工回归（普通长会话打开、禁用/启用插件、切换会话），
   补上 CLI/headless 无法覆盖的 Electron 路径。
3. 由维护者决定版本号并打 tag 前，按仓库流程 push 分支、开 PR、等 ci/review；
   本子代理未执行这些远程操作。
4. 若要发布，建议在 release notes 中明确：实验开关全部默认关；defer 在
   0.2.2-rc.1 对真实打开不生效；页缓存与最终报告的证据边界。

**是否建议进入发布：是，有条件。** 条件是上述 1–2 完成且 PR/CI/review 通过；
本阶段没有发现阻塞发布的正确性缺陷或性能回归，但也没有足够证据支持开启任何
实验优化。

## 9. 复现与证据位置

- 矩阵：`libs/bench/stage8/matrix.mjs` → `libs/.worktrees/stage8-release/bench/results/stage8-matrix-final`、`stage8-matrix-unexec`。
- A/B：`bench/results/stage8-perf-off2`（全关，Chrome .52）、`bench/results/stage8-perf-on`（全开，.52）。
- 首轮 OFF（Chrome .50）保留在 `stage8-perf-off`，只作历史，不与 ON 混用。
- 阶段 5 原始测量与结论：`docs/design.md` 的 “Stage 5: deferred live build”。
- 阶段 0 基线：`docs/research/plugin-optimization-baseline.md`。
