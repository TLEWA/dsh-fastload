# Changelog

All notable changes are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

[简体中文](CHANGELOG.md) · [English](CHANGELOG.en.md)

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
