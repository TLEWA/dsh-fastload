# dsh-fastload

A DSH plugin with a host half and a small web-client half. It makes the
**first** history page of a long session smaller without changing the tail the
user actually sees. The host rewrites only the initial `session/follow` request
to **100 messages / 40 minimum messages / 2 turns**, and can optionally trim
older whole turns by a byte budget. When that page is shorter than the
viewport, the web client fills it in the background with the built-in "Load
older" page.

The default two-turn window is a target, not a hard floor: `maxMessages` is
the hard cap, so a single turn with more than 100 messages is cut inside that
turn. It still matters: a one-turn page can look fast while the viewport only
contains a collapsed tool call (measured: 267 px, 102 characters of visible
text). Two turns normally keep the previous turn's readable context in view.

## English

### What it changes

- Initial page: `maxMessages = 100`, `turnWindow = { minMessages: 40, minTurns: 2 }`.
  The turn window is best effort; `maxMessages` still caps the page and can cut
  inside the newest turn when that turn alone has more than 100 messages.
- Requests with `beforeSeq` or `throughSeq` ("load older", jump, live
  continuation) are left untouched.
- An explicitly smaller initial page is respected unless `DSH_FASTLOAD_FORCE=1`.
- Optional `maxBytes` trims only at `turn/start` boundaries. It always keeps
  the newest `minTurns` complete turns; if those protected turns exceed the
  soft budget but fit the hard cap, they are kept instead of cutting into a turn.
- Background fill: after the first paint, the web client waits for a short idle
  window. If the transcript does not scroll (`scrollHeight <= clientHeight`),
  it presses the built-in "Load older" button once. That runs
  `ChatNavigation.loadEarlier()`, so the viewport anchor is preserved and the
  tail context becomes the same as stock 500/50/2. If the first page already
  scrolls, it does nothing: the newest content is already at the bottom.

### What it does not do

- It does not reduce the Host's full log decode. It reduces snapshot bytes,
  WebSocket transfer and renderer mount work.
- It does not change the transcript layout, Markdown rendering or scroll model.
- It does not delete history: "load older" still pages backwards with the
  original request semantics.
- The background fill is one page per mounted transcript and only when the
  viewport is short; it is not a general auto-pagination loop.

### Configuration

| Environment variable | Default | Meaning |
|---|---:|---|
| `DSH_FASTLOAD_ENABLED` | `1` | Set to `0` to leave the follow path untouched. |
| `DSH_FASTLOAD_FORCE` | `0` | Rewrite every initial page, even an explicit smaller one. |
| `DSH_FASTLOAD_MAX_MESSAGES` | `100` | Initial page message cap. |
| `DSH_FASTLOAD_MIN_MESSAGES` | `40` | Minimum messages before the turn window may cut. |
| `DSH_FASTLOAD_MIN_TURNS` | `2` | Target complete turns at the tail; `maxMessages` still caps the page. |
| `DSH_FASTLOAD_MAX_BYTES` | `0` | Soft byte budget; `0` disables byte trimming. |
| `DSH_FASTLOAD_HARD_CAP_BYTES` | `8388608` | Never trim below the protected turns if they exceed this. |
| `DSH_FASTLOAD_DEBUG` | `0` | Log each trim through the DSH logger. |

### Install for development

```bash
git clone <repo> dsh-fastload
cd dsh-fastload
npm test
```

Install the package into the profile's `node_modules`, then add this to the
profile patch (or pass the same YAML with `--patch`):

```yaml
- insert:
    - id: dsh-fastload
      name: 'dsh-fastload'
```

The package exports a host plugin with `inject = ['sessionController']` and a
web client entry (`./client`, declared through `dsh.client`). The client half
is what performs the background fill.

### Verification

```bash
npm test
```

The tests cover page eligibility, the two-turn floor, turn-boundary cutting
and hard-cap fallback. Real-browser measurements behind the defaults are in
`docs/research/dsh-cdp-benchmark-results.md`.

## 中文

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
| `DSH_FASTLOAD_ENABLED` | `1` | 设为 `0` 可完全关闭。 |
| `DSH_FASTLOAD_FORCE` | `0` | 强制改写所有首屏，包括显式的小页。 |
| `DSH_FASTLOAD_MAX_MESSAGES` | `100` | 首屏消息上限。 |
| `DSH_FASTLOAD_MIN_MESSAGES` | `40` | turnWindow 允许裁切前的最小消息数。 |
| `DSH_FASTLOAD_MIN_TURNS` | `2` | turnWindow 目标保留的尾部 turn 数；仍受 `maxMessages` 硬上限约束。 |
| `DSH_FASTLOAD_MAX_BYTES` | `0` | 软字节预算；`0` 表示不按字节裁。 |
| `DSH_FASTLOAD_HARD_CAP_BYTES` | `8388608` | 受保护 turn 超过该值时不再裁切。 |
| `DSH_FASTLOAD_DEBUG` | `0` | 每次裁切写一条 DSH 日志。 |

### 安装到 profile

把包安装到 profile 的 `node_modules`，然后在 profile patch（或用 `--patch`
传入）中加入：

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

## Evidence / 实测依据

On `session-cd3c83f5…` (cold Host, clean profile, same visible text of 850
characters):

| Metric | stock 500/50/2 | fastload 100/40/2 |
|---|---:|---:|
| wire bytes | 3,424,190 | 872,394 |
| click → first transcript | 555.4 ms | 301.3 ms |
| DOM nodes | 9,946 | 4,601 |
| transcript anchors | 486 | 168 |
| long-task total | 310 ms | 161 ms |

The earlier 100/40/1 result (283.5 ms) is deliberately **not** used as a
headline: it rendered a 267 px page with only 102 visible characters. See
`docs/research/dsh-long-session-first-open.md` and
`docs/research/dsh-cdp-benchmark-results.md` for the full matrix, including
why a byte cap is only a fallback.

## License

MIT.
