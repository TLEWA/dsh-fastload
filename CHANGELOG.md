# Changelog

## 0.2.1 — 2026-11-09

### English

- Republish the 0.2.0 content under a new version. npm created a staged
  `0.0.0-stage` placeholder for the first publish and never released 0.2.0
  (npm/cli#9889); there are no runtime changes in this release.

## 0.2.0 — 2026-11-09

### English

- Add a web-client half: after the first paint, if the reduced transcript is
  shorter than the viewport, press the built-in "Load older" button once so the
  tail context matches stock 500/50/2. The click reuses
  `ChatNavigation.loadEarlier()` and its viewport anchor compensation.
- Skip the fill when the transcript already scrolls; never auto-paginate more
  than one page per mounted transcript.
- Filter out nested reasoning/tool-step `data-chat-flow` nodes and wait for a
  short input-idle window before clicking.

## 0.1.0 — 2026-11-09

### English

- Initial host plugin: rewrite the initial session history page to 100 messages / 40 minimum messages / 2 turns.
- Optional byte budget that trims only whole older turns and always keeps the newest two turns.
- Pure planning helpers and Node test coverage for page eligibility, turn-boundary trimming and hard-cap fallback.
