# dsh-fastload stage-0 benchmark

本目录是 dsh-fastload 阶段 0 的本地基准工具，不进入 npm 包，也不改变插件运行时行为。所有数据来自真实运行；无法可靠采集的指标写“未采集”。

This directory contains the local stage-0 benchmark tools. It is not part of the published package and does not change plugin runtime behavior.

## 组成

- run.mjs：可参数化执行器。场景 × 样本 × 重复次数 → raw.json、summary.json、run.log、host/chrome 日志。
- report.mjs：读取 raw.json，生成 docs/research/plugin-optimization-baseline.md。
- lib/probe.mjs：document-start 页面探针（WebSocket 帧、Long Task、FCP、首个可见 flow 子节点、React commit）。
- lib/host.mjs：启动/停止隔离 DSH host，读取 serve.log 与 stderr。
- lib/chrome.mjs：启动/停止独立 headless Chrome 和 CDP target。
- lib/measure.mjs：单次测量、冷热缓存处理、Host/Renderer 指标拆分。
- lib/sampler.mjs + host-sampler.ps1：50 ms 采样 host CPU/WorkingSet。
- samples.example.json：样本格式模板；samples.local.json 是本机私人样本，已 gitignore。

## 隔离环境

不要使用用户 DSH_HOME（C:/Users/<user>/.dsh）或用户 GUI。准备一个独立 home：

    cp -r <repo>/libs/bench/home <bench-home>

profile 必须满足：

- <bench-home>/profiles/web/node_modules/dsh-fastload 是指向本 worktree 的 junction/symlink。
- <bench-home>/profiles/web/package.json 的 dsh.profile.bundles 含 dsh-fastload。
- workspace 与被测会话所属 workspace 一致；host 以该目录为 cwd 启动。
- 端口选未占用的，例如 host 3597、CDP 9337；不要碰 10802。

Windows 下创建 junction（MSYS 的 cmd //c mklink 可能报“无效开关”）：

    powershell -NoProfile -Command "New-Item -ItemType Junction -Path '<bench-home>/profiles/web/node_modules/dsh-fastload' -Target '<worktree>'"

## 被测版本

2026-11-12 的基线用隔离前缀安装的 DSH 0.2.2-rc.1，避免影响全局 CLI：

    npm install --prefix bench/.tools/dsh022 --no-audit --no-fund @deepseek-ai/dsh@0.2.2-rc.1

采集时用 `--dsh-bin` 指向该前缀里的 bin.js。`bench/.tools/` 已 gitignore。桌面版也是 0.2.2-rc.1 的同一版本包，但它是 Electron 外壳；本工具测的是 CLI + Web SPA + headless Chrome，不能直接外推到桌面 GUI。

## 样本

复制 samples.example.json 为 samples.local.json，填入真实 sessionId（必须是 session-<uuid>）和 workspace。samples.local.json 不会提交。

每个样本至少应有：key、label、kind、sessionId。执行器会从隔离 home 的 sessions/ 递归查找 session.v4.jsonl.zstd，解压统计压缩/解压字节数与行数；不会修改日志。

## 采集

    node bench/run.mjs --home <bench-home> --workspace <workspace> \
      --samples bench/samples.local.json --reps 10 --cold-reps 5 \
      --out bench/results/<timestamp> --host-port 3597 --cdp-port 9337

常用参数：

- --scenarios cold-host,warm-host,cache-hit,cache-miss
- --samples-filter normal,long
- --dsh-bin <path>/@deepseek-ai/dsh/lib/bin.js
- --chrome <chrome.exe>
- --keep：排障时保留 host/Chrome；正常结束会清理，避免遗留进程和端口。

每个重复新建 Chrome target；冷 host 每个重复停 host、删除 cache/dsh-fastload、重启 host。所有 sessionId 只出现在 raw.json（已 gitignore），报告使用打码 ID。

## 场景

- cold-host：Cold Host + Cold Session；删整个 cache/dsh-fastload 并重启 host。
- warm-host：Warm Host + Cold Session；删 pages/，保留 scan cache 和 host。
- cache-hit：prime 页面缓存后反复命中。
- cache-miss：prime 后把该样本缓存文件截断 50%，强制失效并回退 live。

## 指标

- click→first visible flow child；click→session/follow；follow→snapshot；snapshot→first row。
- 首屏 WS UTF-8 bytes、records、messages、turns、tools。
- DOM 节点、FCP、>50 ms Long Task 数量/总耗时。
- host CPU 秒、平均核数、WorkingSet/PeakWorkingSet、open→hit/live、first frame、cache ready。
- React commit（最小 DevTools hook）；页面不调用 hook 时为“未采集”。

“首个可见行”是 flow 直接子节点中的消息/步骤块，不是逐行文本；报告会保留 kind/height/index。

## 报告

    node bench/report.mjs --raw bench/results/<timestamp>/raw.json \
      --out docs/research/plugin-optimization-baseline.md

## 清理

执行器正常结束会停 host 和 Chrome。若被中断，按端口找 listener PID 再 taskkill /T /F：

    netstat -ano -p tcp | grep ':3597 ' | grep LISTENING
    netstat -ano -p tcp | grep ':9337 ' | grep LISTENING

## English quick start

1. Copy libs/bench/home to an isolated DSH_HOME.
2. Point profiles/web/node_modules/dsh-fastload at this worktree and include dsh-fastload in dsh.profile.bundles.
3. Fill samples.local.json with sessionId values and the workspace path.
4. Run the run.mjs command above, then report.mjs.
5. Do not use the user's DSH_HOME, GUI port, or browser session. The executor owns ports 3597 and 9337 by default and cleans up host/Chrome on exit.

The benchmark separates renderer scheduling (click to follow), host plus WebSocket (follow to snapshot), and renderer rendering (snapshot to first visible transcript block). It does not measure the desktop Electron runtime and does not estimate missing metrics.
