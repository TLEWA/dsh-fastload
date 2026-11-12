# dsh-fastload design notes

## Problem

DSH's initial history page is bounded by message count and turn count, not by
what fits the viewport. A single user turn can contain hundreds of assistant and
tool messages, so `maxMessages: 500` may never fire while the page is still
several megabytes.

The CDP A/B on `session-cd3c83f5…` showed:

- stock 500/50/2: 3.42 MB, 555.4 ms click → first transcript, 9,946 DOM;
- 100/40/1: 283.5 ms, but only 267 px / 102 visible characters — a blank tail;
- 100/40/2: 301.3 ms, 0.87 MB, 4,601 DOM, 850 visible characters (same as stock).

The two-turn floor is therefore a correctness requirement, not a tuning knob.

## Runtime flow

```
client session open
  -> transport session/follow (maxMessages: 500)
  -> dsh-fastload wraps sessionController.follow
  -> initial request rewritten to maxMessages: 100 / minMessages: 40 / minTurns: 2
  -> optional: first snapshot records trimmed at turn/start boundaries
  -> ChatFlow mounts the smaller page
  -> web client sees a non-scrollable transcript
  -> presses the built-in "Load older" once (idle, one page per mount)
  -> ChatNavigation.loadEarlier() anchors the viewport, then sends beforeSeq;
     the plugin leaves this page untouched
```

## Safety rules

1. Only requests with no `beforeSeq` / `throughSeq` are eligible.
2. An explicit initial page smaller than 500 is respected unless `FORCE=1`.
3. Byte trimming has legal cut points only at `turn/start`.
4. At least `minTurns` complete turns are kept.
5. If protected turns exceed the soft budget but fit the hard cap, they are kept.
6. If they exceed the hard cap, the page is returned unchanged.
7. The plugin is idempotent: `sessionController.follow` is marked with
   `__dshFastload` and never wrapped twice. The marker and the wrapper live on
   the raw service behind cordis's traceable proxy and are removed through
   `ctx.effect`'s disposer when the plugin is disabled, unloaded, or reloaded;
   re-enabling installs a fresh wrapper with the current config.
8. The client fill only acts when `scrollHeight <= clientHeight` (plus a
   small slack), only on the transcript flow that owns
   `data-slot="conversation.chat.flow"`, and only once per mounted flow.

## Background fill

A reduced page can be shorter than the viewport (the 42fe session: 363 anchors,
165 px, 177 visible characters, versus stock's 780 anchors, 1,187 px, 682
characters). A page that short has a real visible-content gap, not just fewer
rows above the fold.

The client half waits about 900 ms, postpones while the user is typing or
scrolling, and then presses the transcript's own "Load older" button. That
button runs `ChatNavigation.loadEarlier()`, which calls
`viewport.beginPaging()` before `input.loadOlder()`. The resulting prepend
keeps the current row anchored; a direct `session.loadOlder()` would skip that
compensation.

Measured in the test profile: the fill took 191 ms, produced a 136 ms long
task, and restored the 42fe page to 780 anchors, 14,504 DOM nodes and
`scrollTop = 461` — the same viewport as stock. The 7c38 fat-turn session
already scrolls (3,622 px), so the client skips it and keeps the 268-anchor
first page.

## Idle page-cache refresh

A session that just went quiet is the best moment to build its opening page: the
page cache is keyed by the persistence revision, so a page built after the last
write can serve the next open, while a page built too early is simply a miss.
The host half (off by default, `DSH_FASTLOAD_IDLE_CACHE_REFRESH=1`) watches two
signals only: `session/event` for activity and `agent/status` for turn
bookkeeping. The interactive Host exposes no durable "turn written" notification
— the JSONL writer batches live events for up to 200 ms — so the refresher
debounces activity by `idleMs` (4 s default) and, once queued, waits `settleMs`
(600 ms) after the cache probe before reading the revision.

It then runs the same `follow({ activate: false })` a client open would use,
through the plugin's own wrapper, with the canonical page variant. Two
`sessionPersistence.stat` revision reads bracket the build; the page is stored
only when the revision is unchanged before and after the build, and it is stored
under the `key` the cache lookup returned for that revision. A refresh request
is tagged with an internal symbol, so the page-cache wrapper never serves it and
it never counts as a cache hit. The refresher never activates the Agent, never
writes the session store, never edits original logs, and keeps at most one build
in flight globally; Agent activity aborts a build that is already running, and a
Host-reported event-loop lag defers the build instead of competing with the
interactive session.

The defaults follow from the 200 ms writer batch: the first revision read has to
land after the batch, and the second read catches appends that happened while the
page was being built. If a read fails, the API shape is unknown, or the same
session keeps failing, the refresher disables itself instead of guessing.

## What is intentionally absent

- No DOM virtualization: that is a separate, larger change; this plugin only
  reduces the initial page and fills a short viewport once.
- No general auto-pagination: one page per mounted transcript.
- No speed-up for "load older" or for a cache miss: the page cache covers only
  the initial opening, and building a page still decodes the log. The idle refresh
  moves that build off the open path; it does not shrink the Host's full decode.

## Test surface

`npm test` covers the pure planning logic and the runtime wiring: the wrapper
is exercised against a fake `sessionController` and cordis context in
`test/plugin.test.js` (initial-page rewrite, cache replay, idle-refresh listeners
and disposal), and the refresher against a fake cache and persistence service in
`test/cache-refresh.test.js` (queueing, dedup, cancellation, revision checks).
The production-shaped verification remains the CDP benchmark documented in
`docs/research/`.

## Next steps

1. Turn-aware byte trimming inside `paginate` (Host source), not just the
   response wrapper.
2. Tail-frame `readTail` to avoid the full log decode on cold Hosts.
3. Deferring agent promotion until after the opening frame.
4. Transcript virtualization for hundreds of turns.
