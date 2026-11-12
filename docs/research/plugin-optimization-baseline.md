# dsh-fastload 首次打开性能基线（阶段 0，DSH 0.2.2-rc.1）

本报告是 dsh-fastload 阶段 0 的可复现首次打开性能基线。所有数值来自真实运行；未执行或无法可靠采集的项目明确写明，没有估算。

English summary: a reproducible first-open benchmark of the dsh-fastload plugin, covering cold/warm host, cold session, page-cache hit and forced page-cache invalidation, each with a normal session and a tool-step-heavy long session. The report separates renderer scheduling (click to session/follow), host plus WebSocket (follow to snapshot), and renderer rendering (snapshot to the first visible transcript block). The desktop Electron runtime was not measured.

## 1. 环境与版本

| 项 | 值 |
| --- | --- |
| 采集时间 | 2026-11-12T04:01:50.664Z – 2026-11-12T04:07:30.118Z |
| 操作系统 | win32 10.0.26200 / x64 |
| CPU / 内存 | AMD Ryzen 9 9955HX3D 16-Core Processor          / 31.2 GiB |
| Node.js | v24.22.1 |
| Chrome | Chrome/157.0.8103.50（headless=new，1280×900，device scale 1） |
| DSH CLI（实际被测） | 0.2.2-rc.1 |
| 桌面 runtime（未测） | 0.2.2-rc.1（同版本包，Electron 外壳未测） |
| 插件 | dsh-fastload@0.3.1 |
| git | 04723c8a7c31（perf/optimization-baseline） |
| 工作树 | 有未提交文件（采集时仅 bench/ 工具，插件运行时代码未改） |
| 端口 | host 3597 / CDP 9337 |
| 样本量 | cold-host 5/样本；warm-host、cache-hit、cache-miss 10/样本 |

CLI 与桌面的区别：本次基线用 DSH <code>0.2.2-rc.1</code> 的 npm 包（<code>@deepseek-ai/dsh</code>，隔离前缀安装）启动 <code>node .../@deepseek-ai/dsh/lib/bin.js web --no-open --port ...</code>，并由独立的 headless Chrome 渲染；桌面 runtime 也是 0.2.2-rc.1 的同一版本包，但桌面是 Electron 外壳，宿主与渲染进程走桌面自己的打包路径。本次只测 CLI + Web SPA + headless Chrome，未启动桌面 GUI，也没有做 A/B。因此中位数不能直接外推到桌面 GUI。两者都满足插件声明的 <code>engines.dsh >= 0.2.0-rc.1</code>；本次只验证了 CLI 0.2.2-rc.1 能加载并命中插件缓存，不是桌面兼容性证明。

本机全局 CLI 仍是 0.2.1-rc.5；为与桌面 runtime 对齐，本报告没有使用它，而是用隔离前缀安装的 0.2.2-rc.1。本报告的数值全部来自 0.2.2-rc.1 的采集；早先 0.2.1-rc.5 的探索数据已作废，不作为本报告的基线或附录结论。

## 2. 样本

| key | 类型 | sessionId（打码） | 压缩日志 | 解压后 | 行数 | 首屏 records | messages | turns | tools | 首屏快照 | 页面缓存 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| normal | normal | session-f03b9395-**** | 716.0 KiB | 2.43 MiB | 902 | 883 | 101 | 5 | 85 | 1.49 MiB | 234.3 KiB |
| long | long | session-262d33b1-**** | 5865.6 KiB | 21.22 MiB | 7960 | 329 | 40 | 2 | 34 | 0.72 MiB | 105.5 KiB |

普通会话有 5 个 turn、101 条 message、85 个 tool/call（约 17 个/turn）；长会话解压日志约 22 MiB，首屏只保留最新 2 个 turn、40 条 message、34 个 tool/call（同样约 17 个/turn）。两者首屏都被插件压到 <code>maxMessages=100</code> 以内，所以长会话首屏 records 反而更少（329 对 883），但单条 message 更大。

## 3. 冷热与场景定义

- Cold Host + Cold Session：每次先停 host，删除隔离 DSH_HOME 下整个 <code>cache/dsh-fastload</code>（含 <code>scan-headers.json</code>、<code>pages/</code>、<code>serve.log</code>），再启动新 host；目标会话没有页面缓存。
- Warm Host + Cold Session：host 已启动且 scan cache 已预热；每次删除 <code>cache/dsh-fastload/pages/</code>，目标会话没有页面缓存条目。
- Page Cache Hit：先用一次普通打开生成目标会话页面缓存，之后每次新建页面直接打开，缓存条目保留。
- Page Cache Miss（强制失效）：先 prime 页面缓存，再把该样本自己的缓存文件截断到 50%，然后打开；宿主读失败后回退 live 并重写缓存。它覆盖“条目存在但不可用”，与“没有条目”的 Warm Host + Cold Session 不同。

## 4. 测量方法

- 每次新建 Chrome target，在 document-start 注入探针，把 <code>localStorage["dsh.sessions.current"]</code> 指向空白会话，避免自动恢复目标会话。
- 用 JS 对侧栏 <code>[data-row-key="session:<id>"]</code> 执行 scrollIntoView + click。这不是受信任用户点击；CDP 的 mouseMoved 会触发 P6 hover 预热（activate=false 的 session/follow），污染冷会话测量。探针只接受一次目标行 click。
- “首个 transcript 可见行”取 transcript flow（<code>data-slot="conversation.chat.flow"</code>）的直接子节点中，第一个与滚动容器视口相交、非零尺寸、未隐藏的节点。它是消息/步骤**块**，不是单行文本；报告同时保留 index、kind、height。
- click→follow 是页面 performance.now() 中 click capture 到目标 session/follow 发送；follow→snapshot 是发送到收到目标 snapshot；snapshot→首行是收到 snapshot 到首次检测到可见 flow 子节点。三段和等于 click→首行（四舍五入除外）。
- 首屏字节取 CDP Network.webSocketFrameReceived 的 payloadData UTF-8 bytes；records/messages/turns/tools 在 Node 侧解析同一个 snapshot。页面探针不解析大帧，避免污染渲染主线程。messages=user/message+assistant/message，turns=turn/start，tools=tool/call。
- Host 侧：<code>serve.log</code> 的 open/hit/live 和带 <code>DSH_FASTLOAD_DEBUG=1</code> 的 stderr。open→hit 是页面缓存读取/解码，open→live 是 miss 取历史，first frame 是首帧日志时间；serve.log 只有毫秒分辨率。
- Host CPU/内存：PowerShell 采样器每 50 ms 读 host 进程 CPU、WorkingSet64、PeakWorkingSet64；窗口从 click 前到首行后约 900 ms。只覆盖 host 进程，不含 Chrome renderer。
- React commit：document-start 注入最小 React DevTools hook；页面不调用 hook 时报告“未采集”，不估算。FCP/Long Task 用 PerformanceObserver；Long Task 只统计点击窗口内大于 50 ms 的任务。
- 每次重复前清空 Chrome HTTP cache；FCP/page load 不是浏览器缓存热值。

## 5. 统计

每组给出 n、median、min–max；raw.json/summary.json 还保留 p25/p75。cold-host 每组 5 次，因为每次要重启 host 并重建 533 个会话的 scan cache；其余三组每组 10 次。5 次不足以给可信 P95，所以报告不展示 P95。没有剔除任何样本。

## 6. 结果

### 6.1 时延拆分

| 场景 / 样本 | n（成功） | click→首行 ms | click→follow ms | follow→snapshot ms | snapshot→首行 ms | page load ms |
| --- | --- | --- | --- | --- | --- | --- |
| Cold Host + Cold Session / normal | 5（5） | 552.7 [528.8–761.4] | 69.7 [65.6–101.0] | 157.3 [152.0–192.7] | 327.6 [311.2–467.7] | 1098.0 [844.0–1249.0] |
| Cold Host + Cold Session / long | 5（5） | 470.2 [456.1–548.7] | 71.7 [67.6–86.9] | 266.0 [256.9–309.9] | 133.6 [130.6–153.6] | 1070.0 [982.0–1129.0] |
| Warm Host + Cold Session / normal | 10（10） | 549.6 [483.6–618.9] | 88.2 [75.5–100.4] | 70.7 [56.5–81.0] | 393.8 [351.6–444.7] | 1022.0 [974.0–1212.0] |
| Warm Host + Cold Session / long | 10（10） | 289.2 [262.6–315.8] | 87.3 [72.1–96.2] | 47.8 [40.9–52.7] | 152.6 [143.3–172.5] | 1024.0 [960.0–1094.0] |
| Page Cache Hit / normal | 10（10） | 418.3 [398.5–581.5] | 67.8 [63.5–100.5] | 53.7 [50.0–65.4] | 296.4 [280.5–421.7] | 823.5 [719.0–1049.0] |
| Page Cache Hit / long | 10（10） | 298.1 [214.2–338.1] | 92.7 [68.6–107.2] | 43.5 [35.5–68.2] | 160.8 [110.1–172.1] | 1046.0 [825.0–1132.0] |
| Page Cache Miss (forced invalid) / normal | 10（10） | 566.5 [537.4–627.9] | 87.2 [83.7–105.8] | 70.1 [65.1–90.7] | 406.4 [383.3–450.5] | 1074.5 [983.0–1122.0] |
| Page Cache Miss (forced invalid) / long | 10（10） | 282.9 [268.3–321.6] | 89.3 [84.0–103.2] | 44.5 [40.8–54.1] | 146.2 [141.8–164.3] | 1024.5 [995.0–1121.0] |

### 6.2 首屏负载、DOM 与渲染

| 场景 / 样本 | 快照 MiB | records | messages | turns | tools | DOM@首行 | DOM settled | FCP ms | LT>50ms 数量 | LT>50ms 总耗时 ms | 点击窗口 WS 入站 MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cold Host + Cold Session / normal | 1.49 | 883 [883–883] | 101 [101–101] | 5 [5–5] | 85 [85–85] | 8671 [8671–8678] | 8684 [8684–8684] | 120.0 [88.0–220.0] | 1 [1–1] | 313.0 [295.0–449.0] | 1.49 |
| Cold Host + Cold Session / long | 0.72 | 329 [329–329] | 40 [40–40] | 2 [2–2] | 34 [34–34] | 4098 [4098–4098] | 4113 [4113–4113] | 200.0 [120.0–224.0] | 1 [1–1] | 124.0 [121.0–143.0] | 0.72 |
| Warm Host + Cold Session / normal | 1.49 | 883 [883–883] | 101 [101–101] | 5 [5–5] | 85 [85–85] | 8678 [8678–8678] | 8684 [8684–8684] | 208.0 [92.0–224.0] | 1 [1–2] | 374.5 [335.0–446.0] | 1.49 |
| Warm Host + Cold Session / long | 0.72 | 329 [329–329] | 40 [40–40] | 2 [2–2] | 34 [34–34] | 4105 [4105–4105] | 4113 [4113–4113] | 92.0 [84.0–224.0] | 1 [1–1] | 139.0 [132.0–156.0] | 0.72 |
| Page Cache Hit / normal | 1.49 | 883 [883–883] | 101 [101–101] | 5 [5–5] | 85 [85–85] | 8678 [8678–8678] | 8684 [8684–8684] | 76.0 [68.0–212.0] | 1 [1–1] | 281.0 [266.0–403.0] | 1.49 |
| Page Cache Hit / long | 0.72 | 329 [329–329] | 40 [40–40] | 2 [2–2] | 34 [34–34] | 4105 [4105–4105] | 4113 [4113–4113] | 150.0 [72.0–232.0] | 1 [1–1] | 147.5 [101.0–156.0] | 0.72 |
| Page Cache Miss (forced invalid) / normal | 1.49 | 883 [883–883] | 101 [101–101] | 5 [5–5] | 85 [85–85] | 8678 [8678–8678] | 8684 [8684–8684] | 96.0 [88.0–256.0] | 1 [1–1] | 384.5 [363.0–428.0] | 1.49 |
| Page Cache Miss (forced invalid) / long | 0.72 | 329 [329–329] | 40 [40–40] | 2 [2–2] | 34 [34–34] | 4105 [4105–4105] | 4113 [4113–4113] | 144.0 [88.0–232.0] | 1 [1–1] | 133.0 [130.0–155.0] | 0.72 |

### 6.3 Host 与页面缓存

| 场景 / 样本 | 预期/实际缓存 | open→hit ms | open→live ms | cache ready ms | first frame ms | Host CPU s | 平均核数 | 窗口 WS 峰值 MiB | 窗口增量 MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cold Host + Cold Session / normal | miss=5 | — | 112.0 [104.0–133.0] | — | 112.3 [103.8–133.3] | 0.766 [0.297–0.953] | 0.518 [0.172–0.622] | 533.5 | 15.7 |
| Cold Host + Cold Session / long | miss=5 | — | 239.0 [232.0–276.0] | — | 239.0 [231.2–276.0] | 0.984 [0.891–1.266] | 0.651 [0.629–0.911] | 566.6 | 56.8 |
| Warm Host + Cold Session / normal | miss=10 | — | 24.5 [17.0–28.0] | — | 24.3 [17.1–28.6] | 0.063 [0.047–0.313] | 0.042 [0.030–0.202] | 532.9 | 9.3 |
| Warm Host + Cold Session / long | miss=10 | — | 24.0 [20.0–27.0] | — | 23.6 [20.6–26.5] | 0.047 [0.031–0.094] | 0.039 [0.024–0.077] | 498.5 | 4.8 |
| Page Cache Hit / normal | hit=10 | 22.5 [20.0–29.0] | n/a（命中路径） | 22.4 [20.0–28.6] | 41.8 [38.3–50.9] | 0.070 [0.031–0.125] | 0.051 [0.020–0.090] | 527.4 | 9.9 |
| Page Cache Hit / long | hit=10 | 23.0 [20.0–29.0] | n/a（命中路径） | 23.0 [20.4–29.0] | 36.8 [31.2–46.3] | 0.063 [0.031–0.109] | 0.049 [0.024–0.089] | 527.9 | 3.3 |
| Page Cache Miss (forced invalid) / normal | miss=10 | — | 26.5 [23.0–32.0] | — | 26.8 [23.9–32.1] | 0.078 [0.063–0.141] | 0.051 [0.042–0.091] | 555.2 | 9.6 |
| Page Cache Miss (forced invalid) / long | miss=10 | — | 23.0 [21.0–26.0] | — | 22.4 [21.1–26.3] | 0.055 [0.031–0.094] | 0.045 [0.025–0.076] | 546.7 | 3.5 |

### 6.4 React commit

| 场景 / 样本 | 点击后 commit 数 | 首个点击后 commit ms | 首行前 commit 数 |
| --- | --- | --- | --- |
| Cold Host + Cold Session / normal | 21 [21–21] | 44.7 [43.0–66.4] | 11 [11–12] |
| Cold Host + Cold Session / long | 21 [21–22] | 46.5 [44.0–57.1] | 11 [11–12] |
| Warm Host + Cold Session / normal | 16 [16–16] | 56.0 [50.3–64.7] | 10 [10–10] |
| Warm Host + Cold Session / long | 16 [16–16] | 55.9 [46.7–63.7] | 10 [10–10] |
| Page Cache Hit / normal | 16 [16–16] | 44.0 [41.5–76.0] | 10 [10–10] |
| Page Cache Hit / long | 16 [16–16] | 59.9 [45.8–71.1] | 10 [10–10] |
| Page Cache Miss (forced invalid) / normal | 16 [16–16] | 57.2 [54.4–67.9] | 10 [10–10] |
| Page Cache Miss (forced invalid) / long | 16 [16–16] | 57.3 [54.5–67.7] | 10 [10–10] |

### 6.5 关键观察（只针对本次两个样本）

- Cold Host 明显增加 Host 等待：open→live 普通 112.0 [104.0–133.0] 对 24.5 [17.0–28.0]，长会话 239.0 [232.0–276.0] 对 24.0 [20.0–27.0]；CPU 也更高（0.766 [0.297–0.953] 对 0.063 [0.047–0.313]）。普通会话的 click→首行 反而几乎相同（552.7 [528.8–761.4] 对 549.6 [483.6–618.9]），因为 Warm 的 renderer snapshot→首行更长（393.8 [351.6–444.7] 对 327.6 [311.2–467.7]）。长会话则体现为总时延差异：470.2 [456.1–548.7] 对 289.2 [262.6–315.8]。
- Renderer 的 snapshot→首行 是 Warm/Hit/Miss 普通会话的主要耗时：约 393.8 [351.6–444.7]、296.4 [280.5–421.7]、406.4 [383.3–450.5]；长会话降到约 152.6 [143.3–172.5]，因为首屏 records 只有 329。
- Page Cache Hit 的 Host open→hit 为 22.5 [20.0–29.0]（普通）/23.0 [20.0–29.0]（长），与 Warm Host 的 open→live 24.5 [17.0–28.0]/24.0 [20.0–27.0] 接近；本次 Hit 的普通会话总时延 418.3 [398.5–581.5] 低于 Warm Host 549.6 [483.6–618.9]，但长会话 298.1 [214.2–338.1] 对 289.2 [262.6–315.8] 没有优势，差异主要落在 renderer 的 snapshot→首行，不能归因于缓存读取。页面缓存对冷 host 的价值本批次没有单独做 A/B，不能从这组数推断。
- 缓存判定：cache-hit 10/10 命中；cold-host 每个样本 5/5 miss，warm-host 每个样本 10/10 miss，cache-miss 每个样本 10/10 为截断后回退 live。所有 70 次 cacheObserved 与预期一致，页面没有异常。
- 强制失效组 Host open→live 为 26.5 [23.0–32.0]（普通）/23.0 [21.0–26.0]（长），与正常 warm miss 接近；插件回退 live 并重写缓存，但 stderr 没有明确的读取失败日志。
- React 在点击后约 44–60 ms 出现首个 commit，首行前约 10–11 个 commit；与 snapshot→首行的 146–406 ms 相比，commit 本身不是本次的主要等待段。
- 长会话首屏被压到 329 records / 0.72 MiB，普通会话是 883 records / 1.49 MiB；cold host 下长会话总时延 470.2 [456.1–548.7] 低于普通会话 552.7 [528.8–761.4]，但 Host live 239.0 [232.0–276.0] 仍高于普通会话 112.0 [104.0–133.0]。

## 7. Host 与 Renderer 拆分

click→首行可稳定拆成 Renderer 的 click→follow、Host+WS 的 follow→snapshot、Renderer 的 snapshot→首行。三段中位数相加与 click→首行中位数相差约 3 ms 内（四舍五入）。Host 内部再用 serve.log 分成 open→hit 或 open→live，以及 stderr 首帧；命中组的 open→hit 与 cache ready 接近，说明缓存读取/解码约 20–30 ms，follow→snapshot 的其余部分还包括 WS 与事件调度，不能全部归给缓存。

Host CPU 是采样窗口内的 CPU 秒数，平均核数是 CPU 秒/墙钟秒；窗口 WS 峰值是窗口内采样到的最大 WorkingSet64，增量是窗口峰值减采样开始值。raw.json 还保留 PeakWorkingSet64（进程生命周期峰值），报告表格不用它做增量，避免把历史峰值算进当前重复。Chrome renderer 的 CPU/内存未采集，所以这不是整机成本。

## 8. 噪声、限制与未采集项

- 单机、单采集窗口，没有 CPU 亲和性/实时优先级；Windows 后台任务、PowerShell 采样器、Chrome headless 生命周期都会带来噪声。采集时同机还有其它会话的 Chrome/Node 进程（其它 worktree 的测试并行运行），没有独占机器；绝对值包含共享负载噪声，场景排序只在本批次内比较。
- cold-host 每组 5 次，其余 10 次；不给 P95。中位数和 min–max 对噪声更稳健，但不足以估计长尾。
- 首个可见节点是 flow 直接子节点（消息/步骤块），不是逐行文本；长样本命中一条高度很大的 user 消息，普通样本命中 assistant-step。报告保留 index/kind/height 供复核。
- 页面探针不解析首屏大 JSON；records/messages/turns/tools 由 Node 侧 CDP 帧解析。React commit 依赖页面调用 DevTools hook；本次有记录，但不同 React 构建可能不调用。
- 强制失效组里插件没有输出明确的“缓存读取失败”日志（本批次 cacheEvents 为空）；hit/live 是由 serve.log 的 hit/live 行判定的。不能据此判断内部异常类型。
- Host 事件循环延迟未采集：本轮没有找到不侵入产品代码、低开销且稳定的采样方式；没有用请求间隔或日志时间差估算。
- 桌面 Electron 0.2.2-rc.1 未测。强制失效只覆盖“文件截断”一种损坏形态，不等于所有损坏/竞争条件。
- 首屏字节是 WS payload UTF-8 bytes，不是解压后 JS 对象大小；snapshot 的 UTF-16 字符数与 bytes 不同。每次清空 Chrome HTTP cache，FCP/page load 不代表浏览器缓存热启动。
- 没有修改产品代码；插件源码、主 checkout、用户 DSH_HOME 和用户 GUI 均未改。

## 9. 复跑

隔离 home 准备见 bench/README.md：profile 的 node_modules/dsh-fastload 必须指向本 worktree，profile <code>dsh.profile.bundles</code> 必须含 dsh-fastload。先在隔离前缀安装 0.2.2-rc.1（不影响全局 CLI）：

    npm install --prefix bench/.tools/dsh022 --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.1

采集与报告：

    node bench/run.mjs --home <bench-home> --workspace <workspace> \
      --samples bench/samples.local.json --reps 10 --cold-reps 5 \
      --out bench/results/<timestamp> --host-port 3597 --cdp-port 9337 \
      --dsh-bin bench/.tools/dsh022/node_modules/@deepseek-ai/dsh/lib/bin.js

    node bench/report.mjs --raw bench/results/<timestamp>/raw.json \
      --out docs/research/plugin-optimization-baseline.md

raw.json 含逐次原始样本（含完整 sessionId，已 gitignore）；summary.json 含每组 n/median/min/max/p25/p75；run.log 是执行日志。

## 10. 附录：逐次原始样本

### Cold Host + Cold Session / normal（n=5）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 761.4 | 101.0 | 192.7 | 467.7 | 1557224 | 883 | live | 133.0 | 133.3 | — | 0.297 | 533.5 | — |
| 2 | 552.7 | 67.8 | 157.3 | 327.6 | 1557224 | 883 | live | 112.0 | 112.0 | — | 0.766 | 545.8 | — |
| 3 | 528.8 | 65.6 | 152.0 | 311.2 | 1557224 | 883 | live | 104.0 | 103.8 | — | 0.750 | 556.7 | — |
| 4 | 559.3 | 70.0 | 158.2 | 331.1 | 1557224 | 883 | live | 115.0 | 114.9 | — | 0.891 | 528.0 | — |
| 5 | 540.0 | 69.7 | 153.4 | 316.9 | 1557224 | 883 | live | 112.0 | 112.3 | — | 0.953 | 515.8 | — |

### Cold Host + Cold Session / long（n=5）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 548.7 | 85.2 | 309.9 | 153.6 | 750488 | 329 | live | 276.0 | 276.0 | — | 0.984 | 564.7 | — |
| 2 | 467.7 | 71.7 | 262.4 | 133.6 | 750488 | 329 | live | 239.0 | 239.0 | — | 1.266 | 553.1 | — |
| 3 | 456.1 | 67.6 | 256.9 | 131.6 | 750488 | 329 | live | 236.0 | 235.9 | — | 0.891 | 596.8 | — |
| 4 | 494.6 | 86.9 | 277.1 | 130.6 | 750488 | 329 | live | 255.0 | 254.9 | — | 0.922 | 566.6 | — |
| 5 | 470.2 | 68.4 | 266.0 | 135.8 | 750488 | 329 | live | 232.0 | 231.2 | — | 0.984 | 567.2 | — |

### Warm Host + Cold Session / normal（n=10）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 595.2 | 100.4 | 72.5 | 422.3 | 1557224 | 883 | live | 28.0 | 28.3 | — | 0.094 | 534.2 | — |
| 2 | 552.9 | 89.3 | 73.2 | 390.4 | 1557224 | 883 | live | 23.0 | 22.7 | — | 0.063 | 538.8 | — |
| 3 | 524.8 | 87.1 | 69.4 | 368.3 | 1557224 | 883 | live | 26.0 | 25.4 | — | 0.063 | 532.9 | — |
| 4 | 574.4 | 96.4 | 72.0 | 406.0 | 1557224 | 883 | live | 26.0 | 26.1 | — | 0.063 | 536.1 | — |
| 5 | 535.3 | 82.6 | 64.7 | 388.0 | 1557224 | 883 | live | 23.0 | 22.3 | — | 0.313 | 540.2 | — |
| 6 | 546.4 | 83.5 | 65.8 | 397.1 | 1557224 | 883 | live | 23.0 | 23.1 | — | 0.078 | 396.8 | — |
| 7 | 534.1 | 81.6 | 66.0 | 386.5 | 1557224 | 883 | live | 23.0 | 22.4 | — | 0.094 | 411.6 | — |
| 8 | 618.9 | 93.2 | 81.0 | 444.7 | 1557224 | 883 | live | 28.0 | 28.6 | — | 0.047 | 408.9 | — |
| 9 | 579.6 | 89.9 | 75.9 | 413.8 | 1557224 | 883 | live | 26.0 | 27.0 | — | 0.063 | 432.5 | — |
| 10 | 483.6 | 75.5 | 56.5 | 351.6 | 1557224 | 883 | live | 17.0 | 17.1 | — | 0.047 | 445.2 | — |

### Warm Host + Cold Session / long（n=10）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 262.6 | 72.1 | 47.1 | 143.4 | 750488 | 329 | live | 23.0 | 22.5 | — | 0.047 | 446.2 | — |
| 2 | 263.0 | 75.2 | 44.5 | 143.3 | 750488 | 329 | live | 22.0 | 22.3 | — | 0.031 | 449.2 | — |
| 3 | 291.3 | 86.4 | 48.5 | 156.4 | 750488 | 329 | live | 26.0 | 25.6 | — | 0.031 | 456.6 | — |
| 4 | 276.8 | 83.7 | 40.9 | 152.2 | 750488 | 329 | live | 20.0 | 20.6 | — | 0.094 | 463.3 | — |
| 5 | 276.8 | 85.6 | 45.2 | 146.0 | 750488 | 329 | live | 24.0 | 23.7 | — | 0.047 | 477.0 | — |
| 6 | 315.8 | 93.9 | 49.4 | 172.5 | 750488 | 329 | live | 25.0 | 25.2 | — | 0.094 | 498.5 | — |
| 7 | 313.8 | 93.1 | 52.7 | 168.0 | 750488 | 329 | live | 27.0 | 26.5 | — | 0.047 | 499.8 | — |
| 8 | 287.1 | 88.1 | 48.4 | 150.6 | 750488 | 329 | live | 24.0 | 24.0 | — | 0.063 | 503.7 | — |
| 9 | 297.6 | 96.2 | 48.4 | 153.0 | 750488 | 329 | live | 24.0 | 23.5 | — | 0.078 | 506.6 | — |
| 10 | 297.8 | 88.6 | 43.7 | 165.5 | 750488 | 329 | live | 22.0 | 22.3 | — | 0.047 | 520.8 | — |

### Page Cache Hit / normal（n=10）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 581.5 | 94.4 | 65.4 | 421.7 | 1557224 | 883 | hit | 28.0 | 50.9 | 27.6 | 0.031 | 518.5 | — |
| 2 | 446.3 | 81.9 | 59.6 | 304.8 | 1557224 | 883 | hit | 26.0 | 47.0 | 25.9 | 0.047 | 517.5 | — |
| 3 | 398.5 | 67.9 | 50.0 | 280.6 | 1557224 | 883 | hit | 20.0 | 38.4 | 20.5 | 0.094 | 526.2 | — |
| 4 | 477.2 | 100.5 | 62.4 | 314.3 | 1557224 | 883 | hit | 29.0 | 49.3 | 28.6 | 0.078 | 523.1 | — |
| 5 | 405.3 | 63.5 | 50.3 | 291.5 | 1557224 | 883 | hit | 20.0 | 38.3 | 20.1 | 0.125 | 529.3 | — |
| 6 | 399.3 | 67.5 | 51.3 | 280.5 | 1557224 | 883 | hit | 20.0 | 38.9 | 20.0 | 0.047 | 527.4 | — |
| 7 | 417.0 | 69.7 | 53.1 | 294.2 | 1557224 | 883 | hit | 22.0 | 40.1 | 21.5 | 0.109 | 534.5 | — |
| 8 | 427.5 | 67.7 | 57.7 | 302.1 | 1557224 | 883 | hit | 24.0 | 43.4 | 23.4 | 0.078 | 527.4 | — |
| 9 | 419.5 | 66.7 | 54.3 | 298.5 | 1557224 | 883 | hit | 23.0 | 42.8 | 23.0 | 0.063 | 535.9 | — |
| 10 | 399.6 | 64.3 | 52.0 | 283.3 | 1557224 | 883 | hit | 22.0 | 40.7 | 21.7 | 0.063 | 529.5 | — |

### Page Cache Hit / long（n=10）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 214.2 | 68.6 | 35.5 | 110.1 | 750488 | 329 | hit | 20.0 | 31.2 | 20.4 | 0.063 | 532.9 | — |
| 2 | 308.0 | 90.3 | 49.2 | 168.5 | 750488 | 329 | hit | 27.0 | 41.9 | 27.5 | 0.078 | 535.4 | — |
| 3 | 296.1 | 92.2 | 44.4 | 159.5 | 750488 | 329 | hit | 25.0 | 38.0 | 24.9 | 0.063 | 523.2 | — |
| 4 | 280.0 | 94.1 | 40.0 | 145.9 | 750488 | 329 | hit | 22.0 | 33.9 | 22.0 | 0.063 | 527.1 | — |
| 5 | 292.0 | 89.2 | 42.6 | 160.2 | 750488 | 329 | hit | 23.0 | 35.5 | 23.0 | 0.109 | 527.4 | — |
| 6 | 306.6 | 93.1 | 41.4 | 172.1 | 750488 | 329 | hit | 23.0 | 35.1 | 21.9 | 0.063 | 519.8 | — |
| 7 | 268.0 | 83.8 | 42.2 | 142.0 | 750488 | 329 | hit | 23.0 | 36.2 | 23.0 | 0.047 | 524.8 | — |
| 8 | 317.0 | 105.3 | 46.5 | 165.2 | 750488 | 329 | hit | 27.0 | 40.1 | 26.5 | 0.031 | 527.9 | — |
| 9 | 300.1 | 93.8 | 44.9 | 161.4 | 750488 | 329 | hit | 23.0 | 37.3 | 22.8 | 0.047 | 529.2 | — |
| 10 | 338.1 | 107.2 | 68.2 | 162.7 | 750488 | 329 | hit | 29.0 | 46.3 | 29.0 | 0.063 | 535.7 | — |

### Page Cache Miss (forced invalid) / normal（n=10）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 538.9 | 83.7 | 67.2 | 388.0 | 1557224 | 883 | live | 26.0 | 25.8 | — | 0.078 | 556.7 | 239882→119941 |
| 2 | 537.4 | 86.4 | 67.7 | 383.3 | 1557224 | 883 | live | 26.0 | 26.3 | — | 0.094 | 561.3 | 239882→119941 |
| 3 | 627.9 | 96.1 | 81.3 | 450.5 | 1557224 | 883 | live | 32.0 | 32.0 | — | 0.125 | 568.7 | 239882→119941 |
| 4 | 572.4 | 88.1 | 85.5 | 398.8 | 1557224 | 883 | live | 28.0 | 28.1 | — | 0.094 | 574.2 | 239882→119941 |
| 5 | 563.6 | 87.8 | 69.7 | 406.1 | 1557224 | 883 | live | 26.0 | 25.8 | — | 0.078 | 546.6 | 239882→119941 |
| 6 | 566.2 | 85.5 | 69.2 | 411.5 | 1557224 | 883 | live | 26.0 | 25.5 | — | 0.141 | 549.0 | 239882→119941 |
| 7 | 558.3 | 86.6 | 65.1 | 406.6 | 1557224 | 883 | live | 23.0 | 23.9 | — | 0.078 | 555.2 | 239882→119941 |
| 8 | 618.5 | 105.8 | 90.7 | 422.0 | 1557224 | 883 | live | 32.0 | 32.1 | — | 0.078 | 546.7 | 239882→119941 |
| 9 | 566.7 | 86.2 | 70.5 | 410.0 | 1557224 | 883 | live | 27.0 | 27.3 | — | 0.063 | 550.3 | 239882→119941 |
| 10 | 577.2 | 95.4 | 83.3 | 398.5 | 1557224 | 883 | live | 29.0 | 28.6 | — | 0.078 | 555.2 | 239882→119941 |

### Page Cache Miss (forced invalid) / long（n=10）

| rep | click→首行 | click→follow | follow→snap | snap→首行 | 快照 B | records | cache | open ms | first frame ms | ready ms | CPU s | 峰值 WS MiB | corrupt B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 274.9 | 87.7 | 43.2 | 144.0 | 750488 | 329 | live | 21.0 | 21.2 | — | 0.047 | 541.4 | 108074→54037 |
| 2 | 321.6 | 103.2 | 54.1 | 164.3 | 750488 | 329 | live | 26.0 | 26.2 | — | 0.078 | 545.6 | 108074→54037 |
| 3 | 278.4 | 87.3 | 43.1 | 148.0 | 750488 | 329 | live | 23.0 | 22.3 | — | 0.063 | 544.0 | 108074→54037 |
| 4 | 287.3 | 90.9 | 53.9 | 142.5 | 750488 | 329 | live | 22.0 | 21.9 | — | 0.047 | 550.0 | 108074→54037 |
| 5 | 268.3 | 84.0 | 40.8 | 143.5 | 750488 | 329 | live | 21.0 | 21.6 | — | 0.031 | 540.4 | 108074→54037 |
| 6 | 292.9 | 92.7 | 44.3 | 155.9 | 750488 | 329 | live | 23.0 | 22.6 | — | 0.094 | 544.6 | 108074→54037 |
| 7 | 280.5 | 91.5 | 44.6 | 144.4 | 750488 | 329 | live | 23.0 | 23.4 | — | 0.094 | 546.7 | 108074→54037 |
| 8 | 285.3 | 93.8 | 42.5 | 149.0 | 750488 | 329 | live | 21.0 | 21.1 | — | 0.063 | 549.9 | 108074→54037 |
| 9 | 297.6 | 85.7 | 51.0 | 160.9 | 750488 | 329 | live | 26.0 | 26.3 | — | 0.047 | 553.2 | 108074→54037 |
| 10 | 271.4 | 84.9 | 44.7 | 141.8 | 750488 | 329 | live | 24.0 | 23.3 | — | 0.031 | 557.5 | 108074→54037 |

---

生成器：bench/report.mjs；原始数据：bench\results\2026-11-12-stage0-dsh022\raw.json
