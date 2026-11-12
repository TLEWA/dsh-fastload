# Changelog

All notable changes are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

[简体中文](CHANGELOG.md) · [English](CHANGELOG.en.md)

## [Unreleased]

### Added

- **Deferred live build is now on by default (stage 8 follow-up, not released).**
  `DSH_FASTLOAD_DEFER_LIVE_BUILD` now defaults to `1`; `0`/`off`/`no` still turn it off. A real click in DSH 0.2.2-rc.1 opens with `activate=true`, so the click path
  never defers and shows no measurable benefit; only passive `activate:false` requests such
  as prewarm or restore wait for at most 16 ms. Set `DSH_FASTLOAD_DEFER_LIVE_BUILD=0` to
  restore the stage-3 ordering.
- **Stage 4 revisit PoC: lazy folded groups (experimental, web, off by default).** Adds
  `DSH_FASTLOAD_LAZY_GROUPS` (`localStorage['dsh-fastload.lazy-groups']='1'` or
  `window.__DSH_FASTLOAD_LAZY_GROUPS__=true`). Only tool-call nodes inside finished collapsed
  process groups become a plain-text placeholder; the group shell and anchors stay native.
  Assistant steps, running groups, interleaved input, approvals and errors always use the
  native `renderSlot`. The implementation reads the private
  `ctx.slots.entries('conversation.chat.flow')` entry and temporarily replaces
  `entry.component`; it falls back to stock when a capability is missing and restores the
  original only while the entry still holds this plugin's wrapper. Warm-host alternating A/B
  (n=6): standard normal click-to-first-row 481.6 to 428.6 ms (-11.0%), DOM 8598 to 4888;
  long 265.9 to 237.0 ms (-10.9%), DOM 4114 to 2869; long first-row long task 142.5 to
  118.5 ms, but a second ~39 ms Long Task appears after the first row (settled 142.5 to
  181.5 ms), so total long-task time may increase. Per-preset matrix, pixel parity, anchor
  and paging regressions are in `docs/research/stage4-revisit.md`; real `FindInPage`
  was exercised: the structural reveal passes, but the active match/highlight/scroll are
  lost and false positives/negatives exist. Node-local state preservation was not verified.
  Off by default; a performance experiment only, not a Ctrl+F-compatible path.
- **Stage 4 revisit control: progressive hydration (experimental, web, off by default, NO-GO
  this round).** Adds `DSH_FASTLOAD_LAZY_PROGRESSIVE`
  (`localStorage['dsh-fastload.lazy-progressive']='1'` or
  `window.__DSH_FASTLOAD_LAZY_PROGRESSIVE__=true`); progressive wins when both are on. The
  first frame uses placeholders, then after two `requestAnimationFrame` callbacks it hydrates
  native nodes in `requestIdleCallback` slices; a capture-phase Ctrl/Cmd+F handler uses
  `flushSync` to hydrate everything first. First-open gain matches permanent (normal 576.9 to
  513.8 ms, long 325.4 to 318.9 ms, n=6) and final DOM/text/scroll match stock; normal drains
  in about 0.79-0.90 s, long in 0.13-0.19 s, with the longest first-open slice at 19.9 ms. On a
  turn-rail jump into unloaded history, however, it drained for 12.9 s and produced 93 long
  tasks of 69-110 ms versus stock's single 781 ms task. Under the background-long-task rule it
  is **NO-GO**, kept only as a control.

- **Stage 8 final integration, regression and release preparation (local branch, not
  released).** Merged the stage 2+3+6 integration head with the stage 5 deferred live build,
  the stage 0 baseline and the stage 4 CSS NO-GO report as `feat/optimization-final`. Of the
  13 executable regression scenarios, 12 passed, 0 failed and 1 was not executed (a
  subagent-origin session has no workspace row, so the sidebar cannot reach it). The
  cache-hit path ran 10 opens per sample on the same isolated fixture with DSH 0.2.2-rc.1,
  comparing "all switches off" and "all switches on" against the stage 0 stock numbers.
  Stage 7's 7A client-validation work and 7B private tail reader are **not implemented**
  because no hard data supports them. Other experimental switches still default to off
  (defer is the exception, see above); disabling or uninstalling restores `follow` through
  the disposer, while hot reload depends
  on the host calling the disposer and was not verified on a real host in this stage. Full
  tables, limits and
  unexecuted tests are in `docs/research/plugin-optimization-final-report.md`.
- **Core/diagnostics split in the web client (stage 6).** The default path no longer
  walks React fibers for sampling, keeps no error/rejection/flush/build log arrays,
  does not wrap `console.error`, does not mount `window.__DSH_FASTLOAD__`, and
  registers none of the 7 instrumentation-only timers. On first navigation the
  measured registrations drop from 8 `setTimeout`s to 1 and from 9 listeners to 7
  (only the 7 document listeners used by P6 and the input-idle check remain). The
  fill, Load older anchor compensation, `/rewind` blank healing, error recovery,
  P6 and startup prewarm keep their behaviour and rhythm constants
  (900/700/8/1500 ms). Diagnostics are opt-in and **off by default** via
  `localStorage['dsh-fastload.diagnostics'] = '1'` or
  `window.__DSH_FASTLOAD_DIAGNOSTICS__ = true`; the prototype patching probe also
  needs `dsh-fastload.debug`. `client.js` grows from 1916 to 1962 lines and from
  94,098 to 96,408 bytes, all of it switch scaffolding, comments and the DOM-first
  check in `watchEmpty`; runtime registrations shrink. Script execution time for
  the first navigation was not measured in a real browser.
- **Idle page-cache refresh (stage 3, host half, off by default).** About 4 seconds
  after a session goes quiet, the host runs the existing build/trim flow through a
  read-only `session.follow({ activate: false })` and publishes the opening page
  into the P5 page cache. It reads `sessionPersistence.stat` before and after the
  build and drops the page when the revision moved, so an old page is never stored
  under a new revision. One job per session and one build globally; work is
  deferred while the Agent is running or the Host event loop lags. Refresh requests
  carry an internal mark, bypass the page cache and do not count as hits; the flow
  never activates the Agent, writes the session store or modifies original logs.
  Enable with `DSH_FASTLOAD_IDLE_CACHE_REFRESH=1`; real first-open gains were not
  measured for this change.
- **Deferred live build (stage 5, host half, off by default).** When the page cache
  really hits, the request is an initial page, `activate !== true`, `assistantStream` has
  no active attempt and the Agent is known idle, the real `follow` build starts at most
  16 ms after the cached frame (sliced scheduling; a new request for the same session,
  an abort or the Agent turning busy cancels a pending delay). Any failed gate or unknown
  state keeps the original ordering, and an error while delaying falls back to the stage 3
  single `setImmediate`. With the switch off, ordering, bytes and logs match stage 3;
  `DSH_FASTLOAD_DEBUG=1` adds a `timing` line to `serve.log`
  (`lookup/send/resume/defer/live/build/stall`), while the default path reads no clocks.
  A/B measurement (a final block of 8 cache hits per arm, after an earlier 16-hit block):
  the real build took about 4–5 ms, the live frame arrived 11–20 ms after the cached
  frame, and the first row appeared about 170 ms after it, so no contention with the
  first-frame paint was observed. The switch stays off by default and enabling it is not
  recommended.
- **Predictive prewarm (P6, web client).** Hovering or focusing a sidebar session
  row for 150 ms issues `session/follow({ activate: false })` to build the opening
  page into the page cache; a real click then hits the cache. The passive read
  never activates the Agent and never writes to the session. At most 4 serialized
  jobs, one prewarm per session per 10 minutes; moving the pointer within the
  150 ms delay cancels it, while a prewarm already running is left to finish.
  Bench on one cold session: click-to-first-row 337 ms → 110 ms; the host log
  shows the prewarm follow with `activate=false` and the click with
  `activate=true` served from cache. Disable with
  `localStorage['dsh-fastload.prewarm'] = '0'` or
  `window.__DSH_FASTLOAD_PREWARM__ = false`.
- **Startup prewarm (stage 2, web client, off by default).** On page load the
  client reads `localStorage['dsh.sessions.current']` and, while the
  workspace/session lists are still loading, builds the saved session's opening
  page with the same passive `activate: false` follow. It never waits for the
  lists, writes the selection, navigates, or creates a session. Invalid JSON, an
  empty value, a subagent address, a missing or blank session, or a missing UI
  selection signal all skip silently. When the native restore starts opening the
  same session (or the user picks another one), an unfinished warm is cancelled
  and only this plugin's own read stream is aborted. It shares the P6 serial
  queue and 10-minute TTL; a successful warm is not repeated within 60 s in the
  same tab. The switch has the opposite polarity from P6: only
  `localStorage['dsh-fastload.restore-prewarm'] = '1'` or
  `window.__DSH_FASTLOAD_RESTORE_PREWARM__ = true` enables it. No real-browser
  benchmark was run for this stage.

## [0.3.1] - 2026-11-12

### Added

- **Session-header index (P4).** The host wraps `sessionPersistence.readGenerationHeader` and reuses
  the decoded zstd first line per file `size + mtime`, coalescing repeated `list` calls within one
  boot. The index is stored in `<cacheDir>/scan-headers.json` (1.5 s debounce, atomic replace,
  20k entries trimmed by mtime). Building `session/list` drops from 238.7 ms to 82.0 ms (first
  indexed call) and 1.1–1.8 ms on a TTL hit.
- **Opening-page cache (P5).** An initial page is stored as zstd (gzip fallback) under
  "protocol version + sessionId + persistence revision + page window/trim config". On a hit the
  cached page is sent first while the real `follow` builds in the background and only forwards
  events with `seq > cursor`; if the cursor or `assistantStream.revision` disagrees the cache is
  dropped and a second snapshot is never emitted. A cached page reads in 16.9–17.7 ms versus a
  583.5 ms cold build in the same process.
- **Replay-stream strip on the first frame (part of P8).** `assistant/message.data.stream` becomes
  `[]`, taking the page from 2,821,398 to 1,562,989 bytes (−44.6%) with byte-identical visible text.
- New independent switches `DSH_FASTLOAD_SCAN_CACHE`, `DSH_FASTLOAD_PAGE_CACHE`,
  `DSH_FASTLOAD_PAGE_CACHE_BYTES`, `DSH_FASTLOAD_PAGE_CACHE_FILES`, `DSH_FASTLOAD_CACHE_DIR`
  and `DSH_FASTLOAD_STRIP_STREAM`; any error falls back silently to the original path.
- Add `docs/research/dsh-first-open-p1-p8-assessment.md`: the per-item P1–P8 assessment,
  measurements, reasons for items not implemented and upstream proposals.

### Fixed

- **Blank first screen in rewound sessions.** When the initial page fell
  entirely inside `dsh-rewind-plugin` cut ranges, every node was marked
  hidden and only the "Load older" pill remained. The host now detects the
  `/rewind` pairs in the initial page and, when no message is visible,
  prepends one more page before dispatch (`DSH_FASTLOAD_REWIND_AWARE`, on by
  default: a single attempt, contiguous pages only). The web client likewise
  pages backwards with the built-in button instead of rebuilding the view,
  because a rebuild cannot un-hide rewound content. Bench first row went from
  1,556/1,001/916 ms (one extra click) to 813/747/783 ms (none).
- **Byte trimming no longer undoes a rewind extension.** With
  `DSH_FASTLOAD_MAX_BYTES` enabled and the newest two turns hidden by a
  rewind cut, the visible turn pulled in by the extension used to be trimmed
  away again, leaving the first screen blank and wasting one history read.
  `trim` now accepts `protectSeq`: after an extension, the turn holding the
  first visible message is protected, and the page is left untrimmed when
  even that turn exceeds the hard cap. The extension result is subject to
  that single protected trim only.
- The opening-page cache now validates every entry (non-empty `snapshot`,
  last `seq` equal to the cursor) and drops the file otherwise, so a bad page
  can never be served.
- When a cache hit turns out to have a moved assistant baseline or a
  non-contiguous delta, the host no longer ends the stream silently (which left
  the client on a stale page with no further updates): it evicts the entry and
  fails the stream once, and the client rebuilds through `session.resync()` on
  the original path. Three regression cases cover the replay, the gap and the
  baseline mismatch.
- The web client adds blank diagnostics and self-heal: it records the installed
  window, errors and a sample timeline, and on "page + button + zero rows" it
  tries one more page before falling back to a rebuild. Automatic
  `location.reload()` is gone, so a deterministic case cannot cause a refresh
  loop. Instrumentation is off unless `localStorage['dsh-fastload.debug']='1'`.
- New `<cacheDir>/serve.log` (`DSH_FASTLOAD_SERVE_LOG`): one line per follow
  with `sid/initial/before/through/max/turns` plus cache hit, extension and
  page-write results, for offline forensics.

### Tests

- Add `test/compact.test.js`, `test/page-cache.test.js` and `test/scan-cache.test.js`, plus three
  client-stream integration cases (strip the first frame only, swallow a duplicate opening on a
  cache hit, replay events past the cached cursor). `npm test` now runs 51 tests.

## [0.3.0] - 2026-11-11

- **No more stacking when another plugin keeps our wrapper.** If `follow` was wrapped again by another
  plugin and the unload cannot restore it, the leftover wrapper now switches to a passthrough instead of
  staying active; re-enabling installs one wrapper with the new config instead of keeping the old page size.
- Adopt shared Codex PR review rules and repository-specific review guidance; preserve existing CI, human approval, and release behavior.

### Fixed

- Restore the host's `sessionController.follow` and clear the `__dshFastload`
  marker when the plugin is disabled, unloaded, or reloaded. Re-enabling now
  takes effect with the current config instead of leaving an orphaned wrapper
  that keeps rewriting first pages while the reported state says it is off.

### Docs

- The changelog now follows the other plugins' layout: `CHANGELOG.md` is the Chinese primary document and the English edition moved to `CHANGELOG.en.md`; synced the release manifest in `ci.config.json` and `package.json`.
- Correct the `DSH_FASTLOAD_ENABLED` documentation: setting it to `0` disables only the host-side first-page rewrite and trim, and the web client still fills one page. Behavior is unchanged; the text now matches the implementation.

## 0.2.1 — 2026-11-09

### Release

- Republish the 0.2.0 content under a new version. npm created a staged
  `0.0.0-stage` placeholder for the first publish and never released 0.2.0
  (npm/cli#9889); there are no runtime changes in this release.

## 0.2.0 — 2026-11-09

### Added

- Add a web-client half: after the first paint, if the reduced transcript is
  shorter than the viewport, press the built-in "Load older" button once so the
  tail context matches stock 500/50/2. The click reuses
  `ChatNavigation.loadEarlier()` and its viewport anchor compensation.
- Skip the fill when the transcript already scrolls; never auto-paginate more
  than one page per mounted transcript.
- Filter out nested reasoning/tool-step `data-chat-flow` nodes and wait for a
  short input-idle window before clicking.

## 0.1.0 — 2026-11-09

### Added

- Initial host plugin: rewrite the initial session history page to 100 messages / 40 minimum messages / 2 turns.
- Optional byte budget that trims only whole older turns and always keeps the newest two turns.
- Pure planning helpers and Node test coverage for page eligibility, turn-boundary trimming and hard-cap fallback.