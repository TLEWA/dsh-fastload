# Changelog

All notable changes are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

[简体中文](CHANGELOG.md) · [English](CHANGELOG.en.md)

## [Unreleased]

### Added

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
