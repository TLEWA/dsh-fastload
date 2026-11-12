# dsh-fastload

**简体中文** · [English](README.en.md)

这是一个带宿主端和少量 Web 客户端代码的 DSH 插件。它缩小长会话**首次**打开
时的历史页，同时不改变用户实际看到的尾部内容。宿主端只改写初始
`session/follow` 请求为 **100 条消息 / 至少 40 条 / 至少 2 个 turn**，并可选
按字节预算裁掉更老的完整 turn。如果这个首屏比视口还短，Web 客户端会在后台
用内置“加载更早”把视口补齐。

默认目标保留 2 个 turn，但它不是硬下限：`maxMessages` 才是硬上限，最新一个
turn 自身超过 100 条消息时，会在该 turn 内部切。这个目标仍然有意义：只保留
1 个 turn 时，页面可能只有 267 px、102 个可见字符（最后一条是折叠的工具调用），
firstAnchor 看起来很快，实际上是一个空页。

从 0.4 开始，宿主端另外加了三层优化：会话头索引复用未变化文件的 zstd
首行、首屏快照按 persistence revision 校验后落盘、首帧剥离回放用的
`assistant/message.data.stream`。三者各有独立开关，任何异常都会静默回退到
原始路径；日志文件本身永远不被修改。

### 行为

- 首屏：`maxMessages = 100`，`turnWindow = { minMessages: 40, minTurns: 2 }`。
  turnWindow 是尽力而为；`maxMessages` 仍是硬上限，最新 turn 自身超过 100 条
  消息时会切进该 turn 内部。
- 带 `beforeSeq` / `throughSeq` 的请求（加载更早、跳转、live 续接）不改。
- 调用方显式要求更小的首屏时尊重原值；`DSH_FASTLOAD_FORCE=1` 可强制改写。
- 可选 `maxBytes` 只在 `turn/start` 边界裁切，始终保留最新 `minTurns` 个完整
  turn；如果这两个 turn 超过软预算但不超过硬上限，就保留它们，不切进 turn 内部。
- 禁用、卸载或热重载插件会还原 `sessionController.follow` 并清除 `__dshFastload`
  标记；重新启用后按当前配置重新包装，不会沿用旧配置。
- 空白自愈：Web 端发现“有页、有加载更早按钮、正文 0 行”且窗口里存在
  `/rewind` 命令时，直接用内置“加载更早”往回补一页（保留锚点，最多 4 次、
  间隔 ≥700ms），而不是重建视图；重建对 rewind 隐藏的内容无效。
- 后台补齐：首帧渲染后，Web 客户端等一个短暂的输入空闲窗口；如果 transcript
  不可滚动（`scrollHeight <= clientHeight`），就自动点一次内置“加载更早”。
  这条路径走 `ChatNavigation.loadEarlier()`，会保留视口锚点，使尾部上下文与
  stock 500/50/2 一致。如果首屏本身已经可滚动，则不动作：最新内容已经在底部。
- rewind 感知首屏：初始页里出现完整的 `/rewind` 命令对时，若该页的可见
  消息被 rewind 插件的裁剪区间全部隐藏，就把页起点向前扩一页（只补一次），
  让第一次派发就带可见内容。正常会话不触发，零额外开销。
- 预测性预加载：鼠标悬停或键盘聚焦侧栏会话行 150 ms 后，Web 端用
  `activate: false` 的被动 `session/follow` 预建首屏页并写入页缓存（不开 Agent、
  不改会话）；真正点击时直接命中缓存。队列最多 4 个、串行执行，同一会话 10 分钟内
  只预热一次；延迟窗口内移开指针会取消，已经开始的预热会跑完（只读、不激活）。
  `localStorage['dsh-fastload.prewarm'] = '0'` 或
  `window.__DSH_FASTLOAD_PREWARM__ = false` 可关闭。
- 会话头索引：`session/list` 对未变化的会话文件直接复用上次解析出的 header，
  并把一次启动内的重复列表请求合成一次；索引写入 1.5 秒防抖、原子替换，
  文件大小或 mtime 变了自然失效。
- 首屏快照缓存：初始页按“会话 revision + 页窗口 + 裁剪配置”落盘（zstd）。
  命中时先发缓存页面，真实 `follow` 仍在后台构建，用 cursor 对齐后续事件；
  对不齐就丢弃缓存，绝不下发第二个 snapshot。
- replay stream 剥离：首帧里 `assistant/message.data.stream` 被替换成 `[]`
  （不是删除键，客户端会直接迭代它）。transcript 从 `data.message` 渲染、
  用量从 `data.usage` 读，所以可见内容不变。

### 不做什么

- 未命中页缓存时不减少 Host 对完整日志的解码；命中时直接读快照、跳过建页。
  它减少的是 snapshot 字节、WebSocket 传输和 renderer 挂载量。
- 不改 transcript 布局、Markdown 渲染或滚动模型。
- 不删除历史；“加载更早”仍按原语义向前翻页。
- 后台补齐每个挂载的 transcript 最多一次，且只在视口偏短时触发；不是通用的
  自动翻页循环。

### 配置

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `DSH_FASTLOAD_ENABLED` | `1` | 设为 `0` 只关闭 Host 端首屏改写与裁剪；Web 端一次后台补齐仍会运行。 |
| `DSH_FASTLOAD_FORCE` | `0` | 强制改写所有首屏，包括显式的小页。 |
| `DSH_FASTLOAD_MAX_MESSAGES` | `100` | 首屏消息上限。 |
| `DSH_FASTLOAD_MIN_MESSAGES` | `40` | turnWindow 允许裁切前的最小消息数。 |
| `DSH_FASTLOAD_MIN_TURNS` | `2` | turnWindow 目标保留的尾部 turn 数；仍受 `maxMessages` 硬上限约束。 |
| `DSH_FASTLOAD_MAX_BYTES` | `0` | 软字节预算；`0` 表示不按字节裁。 |
| `DSH_FASTLOAD_HARD_CAP_BYTES` | `8388608` | 受保护 turn 超过该值时不再裁切。 |
| `DSH_FASTLOAD_SCAN_CACHE` | `1` | 会话头索引与列表 TTL memo；`0` 恢复每次全量读 header。 |
| `DSH_FASTLOAD_STRIP_STREAM` | `1` | 首帧剥离回放用的 `data.stream`。 |
| `DSH_FASTLOAD_PAGE_CACHE` | `1` | 持久化首屏快照。 |
| `DSH_FASTLOAD_IDLE_CACHE_REFRESH` | `0` | 空闲时用只读 follow（`activate: false`）预热页缓存；不写 session store、不改原始日志，构建前后校验 `revision`。 |
| `DSH_FASTLOAD_REWIND_AWARE` | `1` | 初始页被 `/rewind` 全部隐藏时向前扩一页。 |
| `DSH_FASTLOAD_SERVE_LOG` | `1` | 在缓存目录写 `serve.log`（每次 follow 一行，512 KiB 轮转）。 |
| `DSH_FASTLOAD_PAGE_CACHE_BYTES` | `100663296` | 页缓存总量上限（96 MiB，下限 1 MiB）。 |
| `DSH_FASTLOAD_PAGE_CACHE_FILES` | `400` | 页缓存文件数上限。 |
| `DSH_FASTLOAD_CACHE_DIR` | 空 | 缓存目录；空表示 `$DSH_HOME/cache/dsh-fastload`。 |
| `DSH_FASTLOAD_DEBUG` | `0` | 每次裁切写一条 DSH 日志。 |

Web 端还有一个不进环境变量的开关：`localStorage['dsh-fastload.prewarm'] = '0'`
（或 `window.__DSH_FASTLOAD_PREWARM__ = false`）关闭会话预测性预加载，默认开启。

### 安装

- **DSH 桌面版：** 打开 **插件 → 添加插件**，输入 `dsh-fastload` 并确认。
  桌面版管理自己的 profile，不要用 CLI 安装到桌面 profile。
- **`dsh web` 或自定义 profile：** 运行
  `dsh plugin --profile web add dsh-fastload`，然后重启该 Host。
- **本地开发：** 克隆仓库、运行 `npm test`，再通过同一个“添加插件”对话框
  选择本地目录（或使用
  `dsh plugin --profile <profile> add <本地路径>`）。

包内自带 bundle patch，通过 profile 管理器安装时不需要额外 YAML。若要手工
写 profile overlay，把包安装到 profile 的 `node_modules`，然后在 profile
patch（或用 `--patch` 传入）中加入：

```yaml
- insert:
    - id: dsh-fastload
      name: 'dsh-fastload'
```

### 开发与验证

```bash
npm test
```

测试覆盖首屏判定、两 turn 下限、turn 边界裁切和硬上限回退。默认参数的
真实浏览器数据见 `docs/research/dsh-cdp-benchmark-results.md`。

## 实测依据

在 `session-cd3c83f5…`（冷启动 Host、干净 profile、相同可见文本 850 字符）上：

| 指标 | stock 500/50/2 | fastload 100/40/2 |
|---|---:|---:|
| wire 字节 | 3,424,190 | 872,394 |
| 点击 → 首个 transcript | 555.4 ms | 301.3 ms |
| DOM 节点 | 9,946 | 4,601 |
| transcript 锚点 | 486 | 168 |
| 长任务总耗时 | 310 ms | 161 ms |

更早的 100/40/1 结果（283.5 ms）故意**不用**作标题数据：它只渲染出 267 px、102 个可见字符的页面。完整矩阵见
`docs/research/dsh-long-session-first-open.md` 与
`docs/research/dsh-cdp-benchmark-results.md`，其中包括为什么字节上限只是回退方案。

2026-11-12 又在 `session-0ce06eba…`（15.4 MB 日志、2 个 turn、每 turn 84 步、
861 条事件）上做了 A/B。这个会话只有 2 个 turn，turn 窗口保护使它无法按字节
再裁小，因此它衡量的正是“页体积 + 首帧处理”这条路：

| 指标 | stock 500/50/2 | fastload 默认 |
|---|---:|---:|
| wire 字节 | 2,821,398 | 1,562,989（−44.6%） |
| `follow` → snapshot | 325 / 330 ms | 247 / 260 ms |
| 首屏行出现 | 950.8 / 1,055.6 ms | 839.5 / 951.0 ms |
| 可见文本 | 175 行 / 56,984 字符 | 完全一致 |
| `session/list` 构建 | 238.7 ms | 82.0 ms（有索引首调）、1.1–1.8 ms（TTL 命中） |
| 缓存页读取 | — | 16.9–17.7 ms（冷建页 583.5 ms） |

2026-11-12 的 rewind 会话 A/B（`session-6e1e17af…`，9 turn、首屏页 532 条事件，
整段落在两次 `/rewind` 的裁剪区间内；DSH 0.2.2-rc.1 + dsh-rewind-plugin 0.21.2，
无头 Chrome、每轮新开页面、清空页缓存后首轮为冷启动）：

| 指标 | 关闭 rewind 感知 | 默认（rewind 感知） |
|---|---:|---:|
| 首行出现 | 902 / 956 / 1,237 ms | 820 / 835 / 839 / 878 ms |
| “加载更早”补页 | 3/3 轮各 1 次（681–1,237 ms） | 0 次 |
| 点击前正文 | 空白（只剩胶囊） | 76 行可见 |
| 同机页缓存回放 | 18.0 ms，冷建首帧 144.0 ms | 19.8–28.2 ms，冷建首帧 181.7 ms |

扩页只在前一页与当前页 `seq` 正好接上时合并，且只往回补一页；页缓存命中后仍按
cursor / revision 校验并补发增量。

逐项评估、未实施项的原因和上游改造方案见
`docs/research/dsh-first-open-p1-p8-assessment.md`。

## 我的其他 DSH 项目

长会话首屏瘦身只是 DSH 的一小块。下面这些插件也都由我维护，按需取用。

- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** —— `ask_user_question` 增强：右键选项补备注，选之前先拿同一份上下文旁问模型一句。
- **[dsh-if](https://github.com/TLEWA/dsh-if)** —— `/if` 命令：让模型结合上文判断条件，成立才把下面的指令作为用户消息发出。
- **[dsh-opencode-go-router](https://github.com/TLEWA/dsh-opencode-go-router)** —— 上下文折叠或系统提示被重写后轮换 OpenCode Go 路由，少丢一点提示缓存。
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** —— 七区域布局整理器：侧栏、侧栏底部、对话标签、输入框、会话头部、右侧栏、设置导航都能长按拖拽排序，面板可以收进「更多」再拖回来。
- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** —— 侧栏行右键菜单：工作区行、会话行与会话正文各有自己的右键菜单，含「打开方式」「更多操作」二级菜单。
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** —— 修复 Windows 下 DSH 子进程 GBK/CP936/GB18030 输出乱码。
- **[dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs)** —— 修复 PTC `run_code` 中无参工具调用被拒绝的问题：把省略或 `undefined` 的首参归一化为 `{}`。

## 许可证

MIT.

## Codex PR 审阅

本仓采用[中心 CI](https://github.com/TLEWA/dsh-plugin-ci)的 v1 公共审阅规则，实际规则保存在 AGENTS.md。云端 Codex 审阅 PR 及新提交，维护者最终批准并合并；审阅结论必须对应最新提交。审阅消耗订阅用量，漏触发时可用 `@codex review` 补审。
