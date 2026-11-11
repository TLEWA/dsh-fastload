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
- 后台补齐：首帧渲染后，Web 客户端等一个短暂的输入空闲窗口；如果 transcript
  不可滚动（`scrollHeight <= clientHeight`），就自动点一次内置“加载更早”。
  这条路径走 `ChatNavigation.loadEarlier()`，会保留视口锚点，使尾部上下文与
  stock 500/50/2 一致。如果首屏本身已经可滚动，则不动作：最新内容已经在底部。

### 不做什么

- 不减少 Host 对完整日志的解码；它减少的是 snapshot 字节、WebSocket 传输和
  renderer 挂载量。
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
| `DSH_FASTLOAD_DEBUG` | `0` | 每次裁切写一条 DSH 日志。 |

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
