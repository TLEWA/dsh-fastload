# Research archive

These documents are the measurement trail behind the defaults, moved here from
the exploratory workspace on 2026-11-09.

- `dsh-long-session-open-lag.md` — general long-session open lag analysis.
- `dsh-long-session-first-open.md` — first-open costs, tail-frame prototype,
  and the corrected two-turn recommendation.
- `dsh-cdp-benchmark-results.md` — CDP A/B matrix, including the 100/40/1
  blank-page counterexample and the maxBytes rich-tail/empty-tail comparison.
- `dsh-long-session-open-lag.patch.md` — draft patch notes, not applied to the
  installed DSH build.
- `plugin-optimization-baseline.md` — stage 0 reproducible first-open baseline:
  cold/warm host, cold session, page-cache hit and forced invalidation, with
  renderer/host timing split and per-run raw samples.
- `css-content-visibility-experiment.md` — stage-4 candidate E: pure-CSS
  `content-visibility` lazy rendering; NO-GO (redundant with `hidden="until-found"`,
  no measurable steady-state gain, stale-size risk on resize/zoom).
- `plugin-optimization-final-report.md` — stage 8 final integration, 16-item
  regression matrix, all-off/all-on performance comparison, stage 7 decision,
  private-API risks and the unexecuted-test list.

The documents contain machine-specific absolute paths from the test machine;
they are retained for reproducibility, not as install instructions.
