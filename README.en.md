# dsh-fastload

[简体中文](README.md) · **English**

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

Since 0.4 the host half also carries three optimizations: a session-header index
that reuses the already-decoded zstd first line for files that did not change, a
persisted opening page validated against the persistence revision, and stripping
of the replay-only `assistant/message.data.stream` from the first frame. Each
has its own switch and falls back silently to the original path on any error;
the log files themselves are never modified.

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
- Blank self-heal: when the web client sees a page, a "Load older" button and
  zero rows while the window contains `/rewind` commands, it pages backwards
  with the built-in button (anchor preserved, at most 4 times, ≥700 ms apart)
  instead of rebuilding the view; a rebuild cannot un-hide rewound content.
- Background fill: after the first paint, the web client waits for a short idle
  window. If the transcript does not scroll (`scrollHeight <= clientHeight`),
  it presses the built-in "Load older" button once. That runs
  `ChatNavigation.loadEarlier()`, so the viewport anchor is preserved and the
  tail context becomes the same as stock 500/50/2. If the first page already
  scrolls, it does nothing: the newest content is already at the bottom.
- Rewind-aware first page: when the initial page contains a complete `/rewind`
  pair and every message in it is hidden by the rewind plugin's cut ranges, one
  more page is prepended (at most once) so the very first dispatch already
  carries visible content. Sessions without rewinds pay nothing.
- Predictive prewarm: hovering or focusing a sidebar session row for 150 ms makes
  the web client issue a passive `session/follow` (`activate: false`) that builds
  the opening page and stores it in the page cache — no Agent activation, no
  session mutation. A real click then hits the cache. The queue holds at most 4
  serialized jobs, one prewarm per session per 10 minutes; moving the pointer
  within the 150 ms delay cancels it, while a prewarm already running is left to
  finish (read-only, no activation). `localStorage['dsh-fastload.prewarm'] = '0'`
  or `window.__DSH_FASTLOAD_PREWARM__ = false` turns it off.
- Startup prewarm: on page load the client reads
  `localStorage['dsh.sessions.current']` and, while the workspace/session lists are
  still loading, builds the saved session's opening page with the same passive
  `activate: false` follow. Invalid JSON, an empty selection, a subagent address,
  a missing or blank session, or a missing UI selection signal all skip silently.
  It never waits for the lists, writes the selection or localStorage, navigates,
  or creates a session. When the native restore starts opening the same session
  (or the user picks another one), a still-waiting warm is cancelled; only this
  plugin's own read stream is aborted, never the officially opened one. A
  successful warm is not repeated within 60 s in the same tab. It shares the
  hover queue and 10-minute TTL but is **off by default**: one extra opening-page
  read on every load is only worth it when explicitly enabled.
- Diagnostics layering: Fiber sampling, assembler/Builder probes, deep
  conversation/session snapshots, console wrapping and the 7 delay timers used
  only for instrumentation are all off by default, and `window.__DSH_FASTLOAD__`
  is not mounted. Open `localStorage['dsh-fastload.diagnostics'] = '1'` (or
  `window.__DSH_FASTLOAD_DIAGNOSTICS__ = true`) to collect evidence; the
  prototype patching probe also needs `dsh-fastload.debug`. Turning diagnostics
  off does not change the fill, blank healing, error recovery or either prewarm
  path.
- Header index: `session/list` reuses the previously decoded header for session
  files whose size and mtime did not change, and coalesces repeated list requests
  within one boot. The index is written with a 1.5 s debounce and an atomic
  replace; a changed file simply misses.
- Opening-page cache: an initial page is stored (zstd) under "session revision +
  page window + trim config". On a hit the cached page is sent first while the
  real `follow` still builds in the background; events after the cached cursor
  are forwarded. If the cursors disagree the cache is dropped and a second
  snapshot is never emitted. Only settled pages are cached: a first frame whose
  assistant baseline still has an active attempt is not stored, because the next
  chunk already makes that snapshot stale.
- Running-session window: while the Agent is streaming (`running`), the initial
  page shrinks to `DSH_FASTLOAD_RUNNING_MAX_MESSAGES` (24) messages and the page
  cache is skipped by default (`DSH_FASTLOAD_RUNNING_PAGE_CACHE=0`). A
  tool-heavy turn of 100 messages can be 900+ events and several megabytes; while
  the model streams, the user only reads the tail, and older history comes back
  through the built-in "Load older" with unchanged semantics. The next open after
  the turn settles returns to the 100-message window.
- Replay-stream strip: `assistant/message.data.stream` becomes `[]` in the
  first frame (not deleted, because clients iterate it). Transcripts render from
  `data.message` and usage comes from `data.usage`, so visible content is
  unchanged.

### What it does not do

- On a page-cache miss it does not reduce the Host's full log decode; on a hit
  it reads the snapshot and skips the page build. It reduces snapshot bytes,
  WebSocket transfer and renderer mount work.
- It does not change the transcript layout, Markdown rendering or scroll model.
- It does not delete history: "load older" still pages backwards with the
  original request semantics.
- The background fill is one page per mounted transcript and only when the
  viewport is short; it is not a general auto-pagination loop.

### Configuration

| Environment variable | Default | Meaning |
|---|---:|---|
| `DSH_FASTLOAD_ENABLED` | `1` | Set to `0` to disable only the Host first-page rewrite and trim; the Web client still fills one page. |
| `DSH_FASTLOAD_FORCE` | `0` | Rewrite every initial page, even an explicit smaller one. |
| `DSH_FASTLOAD_MAX_MESSAGES` | `100` | Initial page message cap. |
| `DSH_FASTLOAD_RUNNING_MAX_MESSAGES` | `24` | Initial page message cap while the Agent is streaming; initial pages only. Set it equal to `MAX_MESSAGES` to disable the running shrink. |
| `DSH_FASTLOAD_MIN_MESSAGES` | `40` | Minimum messages before the turn window may cut. |
| `DSH_FASTLOAD_MIN_TURNS` | `2` | Target complete turns at the tail; `maxMessages` still caps the page. |
| `DSH_FASTLOAD_MAX_BYTES` | `0` | Soft byte budget; `0` disables byte trimming. |
| `DSH_FASTLOAD_HARD_CAP_BYTES` | `8388608` | Never trim below the protected turns if they exceed this. |
| `DSH_FASTLOAD_SCAN_CACHE` | `1` | Session-header index and list TTL memo; `0` re-reads every header. |
| `DSH_FASTLOAD_STRIP_STREAM` | `1` | Strip replay `data.stream` from the first frame. |
| `DSH_FASTLOAD_PAGE_CACHE` | `1` | Persist the opening page. |
| `DSH_FASTLOAD_RUNNING_PAGE_CACHE` | `0` | Read and write the page cache while the Agent is streaming. Off by default: a page stored mid-stream is stale on the next chunk, and a hit is dropped and reopened in full. |
| `DSH_FASTLOAD_IDLE_CACHE_REFRESH` | `0` | Warm the page cache during idle windows with a read-only follow (`activate: false`); never writes the session store or original logs, and checks the `revision` before and after building. |
| `DSH_FASTLOAD_DEFER_LIVE_BUILD` | `1` | After a page-cache hit, delay the real follow by at most 16 ms so the cached first frame can paint first; on by default. A real click in 0.2.2-rc.1 opens with `activate=true`, so the click path does not actually defer; only passive requests with `activate:false` (prewarm/restore) are affected. Set `0` to disable (see `docs/design.md`). |
| `DSH_FASTLOAD_REWIND_AWARE` | `1` | Prepend one page when rewinds hide the whole initial page. |
| `DSH_FASTLOAD_SERVE_LOG` | `1` | Write `serve.log` in the cache directory (one line per follow, 512 KiB rotation). |
| `DSH_FASTLOAD_PAGE_CACHE_BYTES` | `100663296` | Total cache budget (96 MiB; minimum 1 MiB). |
| `DSH_FASTLOAD_PAGE_CACHE_FILES` | `400` | Maximum cached page files. |
| `DSH_FASTLOAD_CACHE_DIR` | empty | Cache directory; empty means `$DSH_HOME/cache/dsh-fastload`. |
| `DSH_FASTLOAD_DEBUG` | `0` | Log each trim through the DSH logger. |

The running window only rewrites initial pages (no `beforeSeq`/`throughSeq`) and needs the
Session's live Agent status: anything but `running` (including a throwing lookup) keeps the
100-message window. Its `turnWindow` is
`{ minMessages: min(MIN_MESSAGES, RUNNING_MAX_MESSAGES), minTurns: 1 }`, so a short turn is kept
whole and a long turn stops at 24 messages. The page cache is skipped as well, because its key
contains the persistence revision, which moves on every streamed frame, and the real first frame's
`assistantStream.revision` almost always moves too: the lookup either misses or hits and is then
dropped. Measured numbers are in `docs/research/streaming-open-latency.md`.

Deferral is on by default and applies only when the cache really hits, the request is an initial
page (no `beforeSeq`/`throughSeq`), `activate !== true`, `assistantStream` has no active attempt,
and the Agent is known to be idle. A new request for the same session, an abort or the Agent
turning busy cancels a delay that has not run yet; an error while delaying falls back to the
original ordering. A user click in 0.2.2-rc.1 opens with `activate=true`, so the click path never
defers; only passive requests such as prewarm or restore are affected, for at most 16 ms. The
stage 5 A/B measurement found no measurable contention between the real follow and the first-frame
paint; the default stays on as a conservative ordering to re-check when client timing changes, and
`DSH_FASTLOAD_DEFER_LIVE_BUILD=0` restores the stage-3 ordering, bytes and logs.

The web half has five switches that are not environment variables; the first
two have opposite polarities:

- `localStorage['dsh-fastload.prewarm'] = '0'` (or
  `window.__DSH_FASTLOAD_PREWARM__ = false`) disables hover predictive prewarm;
  it is **on by default**.
- `localStorage['dsh-fastload.restore-prewarm'] = '1'` (or
  `window.__DSH_FASTLOAD_RESTORE_PREWARM__ = true`) enables startup prewarm; it is
  **off by default**. A missing key, an empty value or any string other than
  `'1'` leaves it off.
- `localStorage['dsh-fastload.diagnostics'] = '1'` (or
  `window.__DSH_FASTLOAD_DIAGNOSTICS__ = true`) enables the web diagnostics
  layer; it is **off by default**. When off, no React Fiber traversal, no deep
  object snapshots, no retained error log array, no `console.error` wrapper and
  no diagnostics-only pollers or timers are installed. The fill, blank healing,
  error recovery, both prewarm paths and their rhythm constants are unchanged.
  The prototype `instrument` probe needs both diagnostics and
  `dsh-fastload.debug`.
- `localStorage['dsh-fastload.lazy-groups'] = '1'` (or
  `window.__DSH_FASTLOAD_LAZY_GROUPS__ = true`) enables the permanent-placeholder
  lazy folded-group experiment; **off by default**.
- `localStorage['dsh-fastload.lazy-progressive'] = '1'` (or
  `window.__DSH_FASTLOAD_LAZY_PROGRESSIVE__ = true`) enables the progressive-hydration
  control experiment; **off by default**. Progressive wins when both are on. It is a
  **NO-GO** this round because rail/unloaded-history jumps produced severe background
  long tasks; it is kept only for comparison.

### Stage 4 experiment: lazy folded groups (off by default)

Both web experiments are off by default. They only replace the `component` of the
`conversation.chat.flow` entry; they do not add a slot declaration, change session logs,
the host protocol or upstream source.

#### Permanent placeholder (conditional GO as an experiment)

Inside a **finished and collapsed** process group, `tool-call` nodes are replaced with a
plain-text placeholder so the first screen does not mount the full tool view for hidden
content. The group shell (title, stats, disclosure button, scroll anchors) is still
rendered by the native `ChatGroupSeat`.

- Switch: `localStorage['dsh-fastload.lazy-groups'] = '1'` (or
  `window.__DSH_FASTLOAD_LAZY_GROUPS__ = true`); **off by default**.
- Only nodes with `node.kind === 'tool-call'`, a foldable process whose
  `open=false`, and an `anchorSeq` between `processStartSeq` and
  `answerAnchorSeq` are replaced. Assistant steps, turn-process nodes, running
  groups, interleaved input, approvals, errors and force-opened groups always
  delegate to the native `renderSlot`.
- The placeholder text is a bounded recursive extraction from `node.data` (at
  most 4000 characters), intended to keep the folded text in the DOM. It is not
  an exact copy of the native collapsed summary: it may include raw arguments
  that the collapsed view hides and may miss wording from the summary. Real
  Real `FindInPage` was exercised: the structural reveal passes, but the active
  match/highlight/scroll are lost and false positives/negatives exist; this is not a
  Ctrl+F-equivalent path.
- Expanding swaps the placeholder back to the full native node; collapsing
  restores the placeholder. This unmounts the node view, so node-local state
  (scroll position inside a tool result, local expansion) is not guaranteed to
  survive.
- Measured with DSH 0.2.2-rc.1, headless Chrome 157, warm host, standard/compact/detailed,
  6 alternating A/B reps per normal/long fixture: normal click-to-first-row 481.6 to
  428.6 ms (-11.0%), DOM 8598 to 4888; long 265.9 to 237.0 ms (-10.9%), DOM 4114 to 2869.
  The long session gains a second ~39 ms Long Task after the first row (settled 142.5
  to 181.5 ms), so total Long Task time may increase. See
  `docs/research/stage4-revisit.md`.

#### Progressive hydration (NO-GO this round)

The first frame uses placeholders only for hidden tool calls. After two
`requestAnimationFrame` callbacks confirm paint, it hydrates native `renderSlot` in
`requestIdleCallback` slices (fallback `setTimeout 0`), at most 4 nodes / about 5 ms per
slice. A capture-phase Ctrl/Cmd+F handler calls `flushSync` to hydrate everything before
the browser find bar runs; `beforematch` is a fallback.

- Switch: `localStorage['dsh-fastload.lazy-progressive'] = '1'` (or
  `window.__DSH_FASTLOAD_LAZY_PROGRESSIVE__ = true`); **off by default**. Progressive
  wins when both switches are on.
- First-open gain is in the same range as permanent, and final DOM/text/scroll match
  stock. Normal drains in about 0.8-0.9 s, long in about 0.13-0.19 s; no >50 ms slice was
  observed during first-open draining.
- On a turn-rail jump into unloaded history, though, progressive took 12.9 s to drain and
  produced 93 long tasks of 69-110 ms; stock produced one 781 ms task in the same scenario.
  Under the "background long tasks clearly worse" rule this is **NO-GO**; the code and data
  are kept only for reproduction.
- The implementation depends on a private shape: it reads the
  `ctx.slots.entries('conversation.chat.flow')` entry and temporarily replaces
  `entry.component`. Installation is capability-checked and does nothing on an
  unknown shape; disposal restores the original only while `entry.component` is
  still this plugin's wrapper. That entry is not a public DSH API promise, so both
  experiments stay off by default and are not recommended as default behavior.
### Uninstall, disable and rollback

- Disabling or removing `dsh-fastload` from the profile runs the plugin disposer: it restores
  the wrapped `sessionController.follow`, removes the `__dshFastload` mark, stops idle-refresh
  timers/listeners/in-flight builds, cancels a pending deferred build and flushes the page
  cache. DSH then behaves exactly like stock.
- Page-cache files and `serve.log` stay under `$DSH_HOME/cache/dsh-fastload` (or
  `DSH_FASTLOAD_CACHE_DIR`). Stock never reads them and they can be deleted at any time. The
  plugin never modifies session logs, the session selection or the real Session Store.
- The idle-refresh, startup-prewarm, diagnostics, lazy folded-group and progressive-hydration
  switches are off by default; deferred live build is on by default but never delays an
  activating click. Invalid environment values fall back to defaults. Disabling the plugin
  needs no data migration.
- Private-API and unknown-version fallbacks are listed in `AGENTS.md` ("Private APIs and
  capability detection"); the full integration evidence is in
  `docs/research/plugin-optimization-final-report.md`.

### Install

- **DSH Desktop:** open **Plugins → Add plugin**, enter `dsh-fastload`, and
  confirm. The desktop app manages its own profile; do not use the CLI for it.
- **`dsh web` or a custom profile:** run
  `dsh plugin --profile web add dsh-fastload` and restart that host.
- **Local development:** clone the repository, run `npm test`, and add the
  checkout as a local plugin through the same Add plugin dialog (or
  `dsh plugin --profile <profile> add <local-path>`).

The package contains its own bundle patch, so no extra YAML is needed when the
plugin is installed through the profile manager. For a manual profile overlay,
install the package into the profile's `node_modules`, then add this to the
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

The tests cover page eligibility, the two-turn floor, turn-boundary cutting,
hard-cap fallback, and the client contracts (passive prewarm, plus the startup
warm's switch, cancellation and read-only rules). Real-browser measurements
behind the defaults are in
`docs/research/dsh-cdp-benchmark-results.md`.

## Evidence

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

A second A/B on 2026-11-12 used `session-0ce06eba…` (15.4 MB log, 2 turns,
84 steps per turn, 861 events). Its two turns are protected by the turn window,
so it cannot shrink by byte trimming; it measures the "page size + first-frame
handling" path instead:

| Metric | stock 500/50/2 | fastload defaults |
|---|---:|---:|
| wire bytes | 2,821,398 | 1,562,989 (−44.6%) |
| `follow` → snapshot | 325 / 330 ms | 247 / 260 ms |
| first transcript rows | 950.8 / 1,055.6 ms | 839.5 / 951.0 ms |
| visible text | 175 rows / 56,984 chars | identical |
| `session/list` build | 238.7 ms | 82.0 ms (first, indexed), 1.1–1.8 ms (TTL hit) |
| cached page read | — | 16.9–17.7 ms (cold build 583.5 ms) |

A rewind-session A/B on 2026-11-12 used `session-6e1e17af…` (9 turns, 532 events
in the initial page, the whole page inside two `/rewind` cut ranges; DSH
0.2.2-rc.1 + dsh-rewind-plugin 0.21.2, headless Chrome, a fresh page per run,
page cache cleared so the first run of each label is cold):

| Metric | rewind-aware off | default (rewind-aware) |
|---|---:|---:|
| first row | 902 / 956 / 1,237 ms | 820 / 835 / 839 / 878 ms |
| "Load earlier" clicks | 1 per run in 3/3 runs (681–1,237 ms) | none |
| content before the click | blank (pill only) | 76 visible rows |
| page-cache replay | 18.0 ms, cold first frame 144.0 ms | 19.8–28.2 ms, cold first frame 181.7 ms |

The extension merges only when the previous page ends exactly at the current
page's first `seq`, and only one page is pulled in; cache hits still verify
cursor / revision and replay the delta.

Per-item assessment, reasons for the items not implemented and the upstream
proposals are in `docs/research/dsh-first-open-p1-p8-assessment.md`.

## Other DSH projects I work on

Trimming the first history page of long sessions is only one corner of DSH. These are the other plugins I maintain — take what fits.

- **[dsh-better-choice](https://github.com/TLEWA/dsh-better-choice)** — an `ask_user_question` enhancement: right-click an option to add a note, or ask the model a side question with the same context before choosing.
- **[dsh-if](https://github.com/TLEWA/dsh-if)** — the `/if` command: let the model judge a condition from prior context, then send the instruction below it as a user message only when it holds.
- **[dsh-opencode-go-router](https://github.com/TLEWA/dsh-opencode-go-router)** — rotates OpenCode Go routing after a context fold or a system-prompt rewrite, so less of the prompt cache is lost.
- **[dsh-sidebar-organizer](https://github.com/TLEWA/dsh-sidebar-organizer)** — a layout organizer for seven regions: sidebar, sidebar footer, conversation tabs, composer, session header, right panel, and settings navigation all support long-press drag to reorder, and panels can be tucked into "More".
- **[dsh-sidebar-row-menu](https://github.com/TLEWA/dsh-sidebar-row-menu)** — right-click menus for sidebar rows: workspace rows, session rows and the conversation body each get their own menu, with "Open with" and "More actions" submenus.
- **[dsh-utf8-output](https://github.com/TLEWA/dsh-utf8-output)** — fixes GBK/CP936/GB18030 mojibake from DSH subprocess output on Windows.
- **[dsh-ptc-noargs](https://github.com/TLEWA/dsh-ptc-noargs)** — fixes rejected argument-less tool calls in PTC `run_code` by normalizing an omitted or `undefined` first argument to `{}`.

## License

MIT.

## Codex PR review

This repository adopts the v1 shared review block in AGENTS.md from [central CI](https://github.com/TLEWA/dsh-plugin-ci). Cloud Codex reviews PRs and new commits; maintainers retain final approval and merging. Review results must cover the latest commit. Review consumes subscription usage; use `@codex review` for missing results.
