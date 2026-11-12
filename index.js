/**
 * dsh-fastload — host half.
 *
 * Long DSH sessions often open with hundreds of transcript rows because the
 * initial history page is bounded by message count and turn count, not by
 * what the user can actually see. This plugin narrows the *initial* page to
 * two complete turns (100 messages max, 40 min). Optional byte trimming cuts
 * older whole turns from the response without ever cutting into the newest
 * two turns.
 *
 * Scope: only requests without beforeSeq/throughSeq are touched. "Load
 * older", jump-to-message and live updates keep their original semantics.
 */

import os from 'node:os';
import path from 'node:path';
import { readConfig } from './src/config.js';
import { isInitialPage } from './src/page.js';
import { planTrim } from './src/trim.js';
import { planCompact } from './src/compact.js';
import { installScanCache } from './src/scan-cache.js';
import { createPageCache } from './src/page-cache.js';
import { createCacheRefresh } from './src/cache-refresh.js';
import { createLiveBuildDefer, DEFER_DEFAULTS } from './src/defer-live-build.js';
import { createServeLog } from './src/serve-log.js';
import { findRewindCuts, earliestCut, firstSeqOf, hiddenByCuts } from './src/rewind.js';

export const name = 'dsh-fastload';

// Exported for the page-cache replay tests: the wrapper is a pure function of
// (live result, cache, variant) and is easier to exercise directly than
// through a stubbed session controller.
export { wrapPageCache };
export const inject = ['sessionController'];

/**
 * Marks the requests the idle refresher issues through the plugin's own wrapper.
 * The wrapper refuses to serve them from the page cache: a refresh build must
 * capture the live page, and a cache hit on that path would both skip the build
 * and inflate the hit counters with reads no user made.
 */
const REFRESH_REQUEST = Symbol.for('dsh-fastload.refresh-request');

/** Cache directory shared by the session-header index and the page cache. */
function resolveCacheDir(config) {
  if (config.cacheDir) return config.cacheDir;
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'cache', 'dsh-fastload');
}

/**
 * Everything that changes the bytes of the opening page. A cached page is only
 * valid for the same window and trim configuration; the persistence revision
 * (part of the cache key) covers changes to the Session itself.
 */
function pageVariant(request, config) {
  return JSON.stringify([
    request.maxMessages ?? null,
    request.turnWindow?.minMessages ?? null,
    request.turnWindow?.minTurns ?? null,
    request.assistantStream === true,
    config.maxBytes,
    config.hardCapBytes,
    config.minTurns,
    config.stripStream === true,
  ]);
}

function sessionIdOf(request) {
  const address = request && request.address;
  if (address && address.kind === 'session' && typeof address.sessionId === 'string') return address.sessionId;
  if (request && typeof request.sessionId === 'string') return request.sessionId;
  return null;
}

/** Debug-only: report when the host produces the opening frame. */
function observeFirstFrame(result, startedAt) {
  if (!result || typeof result[Symbol.asyncIterator] !== 'function') return result;
  let first = true;
  return (async function* () {
    for await (const frame of result) {
      if (first) {
        first = false;
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        process.stderr.write(
          '[fl] first frame ' + ms.toFixed(1) + 'ms records=' +
            (frame && frame.records ? frame.records.length : -1) + '\n'
        );
      }
      yield frame;
    }
  })();
}

/**
 * Debug-only event-loop probe. The gap between two consecutive setImmediate
 * turns is `0.1ms`-ish on an idle loop and grows by exactly the synchronous
 * work it had to wait for, so "max gap minus the smallest observed gap" is the
 * stall the loop could not avoid. Only used when timing is on.
 */
function createLagProbe() {
  let last = performance.now();
  let max = 0;
  let min = Infinity;
  let slices = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const at = performance.now();
    const gap = at - last;
    last = at;
    if (slices > 0) {
      if (gap > max) max = gap;
      if (gap < min) min = gap;
    }
    slices += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop() {
      stopped = true;
      return {
        maxMs: max,
        minMs: min === Infinity ? 0 : min,
        slices,
        stallMs: max === 0 ? 0 : Math.max(0, max - (min === Infinity ? 0 : min)),
      };
    },
  };
}

/**
 * Positive evidence that a Session is quiet, or 'unknown'.
 *
 * A deferral is only allowed on 'idle'. A missing Agent service, a thrown
 * lookup or an unrecognised status all report 'unknown', which keeps the
 * original timing: "there is a cache hit" is not evidence that no Agent is
 * about to write to the same Session.
 */
function agentStatusReader(ctx, c) {
  const find = () => {
    try {
      if (typeof c.get === 'function') {
        const service = c.get('agents');
        if (service && typeof service.get === 'function') return service;
      }
    } catch {}
    for (const holder of [ctx, c]) {
      try {
        const service = holder && holder.agents;
        if (service && typeof service.get === 'function') return service;
      } catch {}
    }
    return null;
  };
  const service = find();
  if (!service) return () => 'unknown';
  return (sessionId) => {
    let agent;
    try {
      agent = service.get(sessionId);
    } catch {
      return 'unknown';
    }
    // No Agent instance exists for this Session, so nothing is running for it.
    if (agent === undefined || agent === null) return 'idle';
    let status;
    try {
      status = agent.status;
    } catch {
      return 'unknown';
    }
    if (status === 'running') return 'running';
    if (status === 'idle') return 'idle';
    return 'unknown';
  };
}

/**
 * Serve a stored opening page before the live history build finishes.
 *
 * The live `follow` stream is still started immediately, so activation and the
 * event queue behave exactly as before; its opening frame is dropped when it
 * agrees with the cached page and replayed as ordinary events when it is a
 * couple of records ahead. Any disagreement falls back to the cached page and
 * ends the stream rather than emitting a second opening frame.
 */
function wrapPageCache(result, options) {
  const { cache, sessionId, variant, config, state, log, defer, signal, request } = options;
  if (!result || typeof result[Symbol.asyncIterator] !== 'function') return result;

  return (async function* () {
    // Timing is debug-only: one boolean check and no clock reads when
    // DSH_FASTLOAD_DEBUG is off, so the default path keeps its exact cost.
    const timed = config.debug === true;
    const epoch = timed ? Date.now() : 0;
    const timeStart = timed ? performance.now() : 0;
    const timings = timed
      ? { lookupMs: 0, sendMs: 0, resumeMs: 0, deferMs: 0, liveMs: 0, stallMs: 0, lagSlices: 0, wallSend: 0, wallBuild: 0 }
      : null;
    const ms = (value) => (Number.isFinite(value) ? value.toFixed(1) : '0.0');
    // Started before the cache lookup so the probe has ticks to compare by the
    // time the live build runs: a build that blocks the Host loop shows up as
    // one wide gap. Debug-only; stopped in `finally` if the stream ends early.
    let lag = null;
    let lagStats = null;
    // Idempotent: the first live frame reads the probe, and the outer
    // cleanup may run again; that cleanup also covers the cached yield,
    // where the consumer can return without ever starting the live loop.
    const stopLag = () => {
      if (lag === null || lagStats !== null) return lagStats;
      lagStats = lag.stop();
      return lagStats;
    };
    try {
      // Started before the cache lookup so the probe has ticks to compare
      // by the time the live build runs: a build that blocks the Host loop
      // shows up as one wide gap. Debug-only.
      lag = timings ? createLagProbe() : null;
      const pullAt = process.hrtime.bigint();
      let probe = { hit: false };
      try {
        probe = await cache.lookup(sessionId, variant);
      } catch {}
      if (timings) timings.lookupMs = performance.now() - timeStart;

      const cached = probe && probe.hit ? probe.opening : null;
      const cachedCursor = cached && Number.isFinite(cached.cursor) ? cached.cursor : null;
      const cachedRevision = cached && cached.assistantStream ? cached.assistantStream.revision : undefined;
      let served = false;

      if (cached) {
        served = true;
        state.pageCacheHits += 1;
        log?.write(
          'hit sid=' + sessionId + ' cursor=' + cachedCursor + ' records=' +
            (Array.isArray(cached.records) ? cached.records.length : -1) + ' hasMore=' + cached.hasMore
        );
        if (config.debug) {
          const totalMs = Number(process.hrtime.bigint() - pullAt) / 1e6;
          process.stderr.write('[fl] page cache ready ' + totalMs.toFixed(1) + 'ms\n');
        }
        if (config.debug) {
          process.stderr.write('[fl] page cache served cursor=' + cachedCursor + ' records=' + (Array.isArray(cached.records) ? cached.records.length : -1) + '\n');
        }
        if (timings) timings.sendMs = performance.now() - timeStart;
        yield cached;
      }
      // Consumer came back for the next frame: everything up to here was the
      // cache read plus handing the bytes to the transport.
      if (timings) {
        timings.resumeMs = performance.now() - timeStart;
        timings.wallSend = epoch + timings.sendMs;
      }

      // Stage 5 (opt-in): a bounded, cancellable yield between the cached page
      // and the live build. Off by default; a refused gate or any error leaves
      // the stage-3 single setImmediate below untouched.
      let deferral = null;
      if (served && defer) {
        try {
          deferral = await defer.wait({ sessionId, request, cached, signal });
        } catch {
          deferral = null;
        }
      }
      if (timings && deferral) timings.deferMs = Number(deferral.waitedMs) || 0;

      if (served && !(deferral && deferral.deferred)) {
        // Give the transport a turn to flush the cached page before the live
        // history build starts competing for the same thread.
        await new Promise((resolve) => setImmediate(resolve));
      }

      if (timings) timings.wallBuild = epoch + (performance.now() - timeStart);
      let first = true;
      const iterator = result[Symbol.asyncIterator]();
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) return;
          const frame = step.value;

          if (first) {
            first = false;
            if (timings) {
              const now = performance.now();
              timings.liveMs = now - timeStart;
              const stats = stopLag();
              timings.stallMs = stats.stallMs;
              timings.lagSlices = stats.slices;
              const line =
                'timing sid=' + sessionId + ' lookup=' + ms(timings.lookupMs) +
                  ' send=' + ms(timings.sendMs) + ' resume=' + ms(timings.resumeMs) +
                  ' defer=' + ms(timings.deferMs) + ' live=' + ms(timings.liveMs) +
                  ' stall=' + ms(timings.stallMs) + ' lagSlices=' + timings.lagSlices +
                  ' total=' + ms(now - timeStart) +
                  ' wallSend=' + Math.round(timings.wallSend) +
                  ' wallBuild=' + Math.round(timings.wallBuild) +
                  ' deferReason=' + (deferral ? deferral.reason : 'off');
              log?.write(line);
              if (config.debug) process.stderr.write('[fl] ' + line + '\n');
              state.pageCacheTiming = {
                sid: sessionId,
                lookupMs: timings.lookupMs,
                sendMs: timings.sendMs,
                resumeMs: timings.resumeMs,
                deferMs: timings.deferMs,
                liveMs: timings.liveMs,
                stallMs: timings.stallMs,
                lagSlices: timings.lagSlices,
                totalMs: now - timeStart,
                wallSend: Math.round(timings.wallSend),
                wallBuild: Math.round(timings.wallBuild),
                deferReason: deferral ? deferral.reason : 'off',
              };
            }
            if (frame && frame.type === 'snapshot') {
              log?.write(
                'live sid=' + sessionId + ' records=' +
                  (Array.isArray(frame.records) ? frame.records.length : -1) + ' cursor=' + frame.cursor +
                  ' hasMore=' + frame.hasMore + ' rev=' +
                  (frame.assistantStream ? frame.assistantStream.revision : '-')
              );
              if (served) {
                const realCursor = Number.isFinite(frame.cursor) ? frame.cursor : null;
                const realRevision = frame.assistantStream ? frame.assistantStream.revision : undefined;
                const sameBaseline = realRevision === cachedRevision;
                if (sameBaseline && realCursor !== null && cachedCursor !== null && realCursor >= cachedCursor) {
                  // The live page is windowed, so "cursor moved forward" alone does
                  // not prove the delta is complete. Only replay a delta that runs
                  // exactly from cached cursor + 1 through the live cursor.
                  let expected = cachedCursor + 1;
                  const delta = [];
                  for (const record of frame.records || []) {
                    const event = record && record.event;
                    const seq = event && event.seq;
                    if (!Number.isFinite(seq) || seq <= cachedCursor) continue;
                    if (seq !== expected) { expected = -1; break; }
                    delta.push(event);
                    expected += 1;
                  }
                  if (expected !== -1 && expected - 1 === realCursor) {
                    for (const event of delta) yield { type: 'event', event };
                    log?.write('replay sid=' + sessionId + ' events=' + delta.length + ' from=' + cachedCursor);
                    continue;
                  }
                  log?.write(
                    'drop sid=' + sessionId + ' reason=gap cached=' + cachedCursor +
                      ' live=' + realCursor + ' expected=' + expected
                  );
                  cache.evict(probe.key);
                  state.pageCacheDropped += 1;
                  throw new Error('fastload page cache is stale: the delta after cursor ' + cachedCursor + ' is incomplete');
                }
                // The live page disagrees with the cached one (or the assistant
                // stream baseline moved), and a second opening frame is not
                // allowed. Fail the stream so the client resyncs from scratch;
                // the stale file is already gone, so the retry takes the plain
                // path.
                cache.evict(probe.key);
                state.pageCacheDropped += 1;
                log?.write(
                  'drop sid=' + sessionId + ' live=' + realCursor + ' cached=' + cachedCursor +
                    ' baseline=' + realRevision + '/' + cachedRevision
                );
                if (config.debug) {
                  process.stderr.write('[fl] page cache dropped cursor=' + realCursor + ' cached=' + cachedCursor + ' baseline=' + realRevision + '/' + cachedRevision + '\n');
                }
                throw new Error('fastload page cache is stale: baseline moved ' + realRevision + '/' + cachedRevision);
              }
              if (probe && probe.revision) {
                cache.store(sessionId, probe.revision, probe.key, frame);
                log?.write(
                  'store sid=' + sessionId + ' records=' +
                    (Array.isArray(frame.records) ? frame.records.length : -1) + ' cursor=' + frame.cursor
                );
              }
            }
          }

          yield frame;
        }
      } finally {
        stopLag();
        try {
          await iterator.return?.();
        } catch {}
      }
    } finally {
      stopLag();
    }
  })();
}

/**
 * A tail-only page can land entirely inside a `/rewind` cut, which renders as
 * an empty transcript with a "load older" button. One page further back is
 * enough: the same request without the newest window, merged in front of the
 * page we already have. Only runs when the page itself proves it is cut.
 */
async function extendRewoundPage(opening, extension) {
  const { original, thisArg, request, signal, state, log } = extension;
  if (!opening || opening.type !== 'snapshot' || !Array.isArray(opening.records) || opening.records.length === 0) {
    return opening;
  }
  const cuts = findRewindCuts(opening.records);
  const target = earliestCut(cuts);
  if (target === null) return opening;
  // The page can start before the cut and still render nothing: what matters
  // is whether any message row survives the cuts, not where the page begins.
  let visible = 0;
  for (const record of opening.records) {
    const event = record && record.event ? record.event : record;
    if (!event) continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    if (!hiddenByCuts(event.seq, cuts)) { visible += 1; if (visible > 0) break; }
  }
  if (visible > 0) return opening;
  const first = firstSeqOf(opening.records);
  const before = first === null ? 0 : first;
  if (before <= 0) return opening;
  log?.write('extend-try first=' + first + ' target=' + target + ' records=' + opening.records.length);

  let previous = null;
  try {
    const stream = original.call(thisArg, {
      ...request,
      beforeSeq: before,
      maxMessages: Number.isFinite(request.maxMessages) ? request.maxMessages : 50,
    }, signal);
    const iterator = stream[Symbol.asyncIterator]();
    const step = await iterator.next();
    previous = step && !step.done ? step.value : null;
    try {
      await iterator.return?.();
    } catch {}
  } catch (error) {
    previous = null;
    log?.write('extend-failed ' + String((error && error.message) || error));
  }

  if (!previous || previous.type !== 'snapshot' || !Array.isArray(previous.records) || previous.records.length === 0) {
    log?.write('extend-skip prev=' + (previous && previous.type ? previous.type : 'none'));
    return opening;
  }

  // The client rejects a page whose own entries are not consecutive, so the
  // join has to be exact: drop the overlap and refuse anything with a hole.
  const kept = previous.records.filter((record) => {
    const seq = record && record.event ? record.event.seq : record && record.seq;
    return !Number.isFinite(seq) || seq < first;
  });
  let previousLast = null;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const seq = kept[index] && kept[index].event ? kept[index].event.seq : null;
    if (Number.isFinite(seq)) { previousLast = seq; break; }
  }
  if (previousLast === null || previousLast + 1 !== first) {
    log?.write('extend-skip gap prevLast=' + previousLast + ' first=' + first);
    return opening;
  }
  state.rewindExtends += 1;
  log?.write(
    'extend records=' + kept.length + '+' + opening.records.length +
      ' target=' + target + ' first=' + first + ' prevLast=' + previousLast
  );
  return {
    ...opening,
    records: [...kept, ...opening.records],
    hasMore: previous.hasMore,
  };
}

/**
 * The first message that survives every rewind cut in this page. A trim that
 * cuts at or before its turn would throw away the only visible content.
 */
function firstVisibleMessageSeq(records) {
  const cuts = findRewindCuts(records);
  if (cuts.length === 0) return null;
  for (const record of records) {
    const event = record && record.event ? record.event : record;
    if (!event || typeof event.seq !== 'number') continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    if (!hiddenByCuts(event.seq, cuts)) return event.seq;
  }
  return null;
}

function wrapFirstSnapshot(result, config, state, ctx, extension) {
  const trimFrame = (frame, protectSeq) => {
    const compacted = planCompact(frame, config);
    if (compacted.info) {
      state.compacts += 1;
      state.lastCompact = compacted.info;
      if (config.debug) {
        try {
          ctx.logger?.info?.(
            '[dsh-fastload] compacted initial page: dropped replay streams from ' +
              compacted.info.stripped + ' messages, -' + compacted.info.savedBytes + ' bytes'
          );
        } catch {}
      }
    }
    const trimOptions = Number.isFinite(protectSeq) ? { ...config, protectSeq } : config;
    const { opening, info } = planTrim(compacted.opening, trimOptions);
    if (!info) return opening;
    state.trims += 1;
    state.lastTrim = info;
    if (config.debug) {
      try {
        ctx.logger?.info?.(
          '[dsh-fastload] trimmed initial page ' +
            info.beforeBytes + ' -> ' + info.afterBytes + ' bytes, ' +
            info.beforeRecords + ' -> ' + info.afterRecords + ' records'
        );
      } catch {}
    }
    return opening;
  };

  const prepare = async (frame) => {
    const beforeRecords = frame && Array.isArray(frame.records) ? frame.records.length : 0;
    const extended = extension ? await extendRewoundPage(frame, extension) : frame;
    const afterRecords = extended && Array.isArray(extended.records) ? extended.records.length : 0;
    // Only a page that actually grew needs the protection: its visible turn
    // sits in front of the hidden tail, where the byte budget would cut first.
    const protectSeq = afterRecords > beforeRecords ? firstVisibleMessageSeq(extended.records) : null;
    return trimFrame(extended, protectSeq);
  };

  if (result && typeof result.then === 'function') {
    return result.then(prepare);
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    return (async function* () {
      let first = true;
      for await (const frame of result) {
        if (first) {
          first = false;
          yield await prepare(frame);
        } else {
          yield frame;
        }
      }
    })();
  }

  return result;
}

const STATE_VERSION = '0.2.1';
const CORDIS_ORIGINAL = Symbol.for('cordis.original');

/**
 * Reuse the diagnostics object for the same version so a wrapper left over from
 * an earlier install never writes into an orphaned state.
 */
function reuseState() {
  const existing = globalThis.__DSH_FASTLOAD__;
  if (existing && typeof existing === 'object' && existing.version === STATE_VERSION) {
    return existing;
  }
  const state = {
    version: STATE_VERSION,
    config: null,
    installed: false,
    trims: 0,
    lastTrim: null,
    pageCache: null,
    compacts: 0,
    lastCompact: null,
    pageCacheHits: 0,
    pageCacheDropped: 0,
    rewindExtends: 0,
    idleRefresh: null,
    error: null,
  };
  globalThis.__DSH_FASTLOAD__ = state;
  return state;
}

/**
 * Raw service behind cordis's traceable proxy. Reads through that proxy create
 * a fresh shadow for every function property, so restored functions must be
 * compared and written on the target, never on the public object.
 */
function installTarget(service) {
  return (service && service[CORDIS_ORIGINAL]) || service;
}

/**
 * @param {object} ctx cordis context
 * @param {object} [options] test seam only ({refresh: {timings, timers,
 *   probeLoad, now}}); the Host never passes a second argument.
 */
export function apply(ctx, options) {
  const config = readConfig(process.env);
  const refreshOptions = options && options.refresh ? options.refresh : null;
  const state = reuseState();
  if (state.installed !== true) state.idleRefresh = null;
  if (state.installed !== true) state.deferLiveBuild = null;
  state.config = config;
  state.installed = false;
  state.error = null;

  if (!config.enabled) return;

  const banner =
    '[dsh-fastload] active: initial page ' +
    config.maxMessages + '/' + config.minMessages + '/' + config.minTurns +
    ', maxBytes=' + config.maxBytes +
    ', client auto-fill=on, scan cache=' + (config.scanCache ? 'on' : 'off') +
    ', page cache=' + (config.pageCache ? 'on' : 'off') +
    ', rewind=' + (config.rewindAware ? 'aware' : 'plain') +
    ', replay streams=' + (config.stripStream ? 'stripped' : 'kept') +
    ', idle refresh=' + (config.idleCacheRefresh ? 'on' : 'off') +
    // Only mentioned when opted in, so the default banner is byte-identical
    // to the stage-3 branch.
    (config.deferLiveBuild ? ', deferred live build=on' : '');
  try {
    ctx.logger?.info?.(banner);
  } catch {}
  if (config.debug) process.stderr.write(banner + '\n');

  ctx.inject(['sessionController'], (c) => {
    let sc;
    try {
      sc = c.get('sessionController');
    } catch (error) {
      state.error = String((error && error.stack) || (error && error.message) || error);
      return;
    }
    if (!sc || typeof sc.follow !== 'function') {
      state.error = 'sessionController.follow is unavailable';
      return;
    }

    const target = installTarget(sc);

    // Diagnostics: one line per follow decision so an empty transcript can be
    // traced to the page that was (or was not) served for it.
    let serveLog = null;
    if (config.serveLog) {
      try {
        serveLog = createServeLog(resolveCacheDir(config));
        state.serveLog = serveLog.file;
      } catch (error) {
        if (config.debug) process.stderr.write('[fl] serve log error: ' + error + '\n');
      }
    }

    // P5: persisted opening page, keyed by the persistence revision so it can
    // only ever serve the exact log it was built from.
    // Shared by the page cache and the idle refresher: both key on the
    // persistence revision, so both need the same service handle.
    let persistence = null;
    try {
      persistence = typeof c.get === 'function' ? c.get('sessionPersistence') : undefined;
    } catch {}

    let pageCache = null;
    if (config.pageCache) {
      try {
        if (persistence && typeof persistence.stat === 'function') {
          pageCache = createPageCache({
            persistence,
            dir: resolveCacheDir(config),
            maxBytes: config.pageCacheMaxBytes,
            maxFiles: config.pageCacheMaxFiles,
            debug: config.debug,
            logger: ctx.logger,
            state,
          });
          const flush = () => {
            try {
              void pageCache.flush();
            } catch {}
          };
          if (typeof c.effect === 'function') c.effect(() => flush, 'dsh-fastload: page cache');
          else if (typeof ctx.effect === 'function') ctx.effect(() => flush, 'dsh-fastload: page cache');
        } else if (config.debug) {
          process.stderr.write('[fl] page cache skipped: no sessionPersistence\n');
        }
      } catch (error) {
        if (config.debug) process.stderr.write('[fl] page cache error: ' + error + '\n');
      }
    }
    // P4: reuse unchanged session headers instead of re-decoding every log
    // header on each list call (and across restarts via a validated index).
    if (config.scanCache) {
      try {
        if (persistence) {
          const cache = installScanCache({
            persistence,
            state,
            debug: config.debug,
            cacheDir: resolveCacheDir(config),
            logger: ctx.logger,
          });
          const disposeCache = () => {
            try {
              cache.dispose();
            } catch {}
            if (state.scanCache) state.scanCache.installed = false;
          };
          if (typeof c.effect === 'function') c.effect(() => disposeCache, 'dsh-fastload: session header index');
          else if (typeof ctx.effect === 'function') ctx.effect(() => disposeCache, 'dsh-fastload: session header index');
        }
      } catch (error) {
        if (config.debug) process.stderr.write('[fl] scan cache error: ' + error + '\n');
      }
    }

    if (target.__dshFastload) {
      state.installed = true;
      return;
    }

    const install = () => {
      const original = target.follow;
      const ownDescriptor = Object.getOwnPropertyDescriptor(target, 'follow');
      // Another plugin can wrap us and keep calling the wrapper it captured. If
      // teardown cannot restore target.follow, this flag turns the leftover
      // wrapper into a passthrough instead of leaving the old page size in the
      // chain and re-applying it after the next install.
      let active = true;
      // Stage 5: opt-in, cancellable yield before the live build. Constructed
      // per installation so its pending timers die with the wrapper.
      let liveBuildDefer = null;
      if (config.deferLiveBuild) {
        const deferOptions = options && options.defer ? options.defer : null;
        liveBuildDefer = createLiveBuildDefer({
          budgetMs: deferOptions && Number.isFinite(deferOptions.budgetMs)
            ? deferOptions.budgetMs
            : DEFER_DEFAULTS.budgetMs,
          maxSlices: deferOptions && Number.isInteger(deferOptions.maxSlices)
            ? deferOptions.maxSlices
            : undefined,
          timers: deferOptions ? deferOptions.timers : undefined,
          now: deferOptions ? deferOptions.now : undefined,
          statusOf: deferOptions && typeof deferOptions.statusOf === 'function'
            ? deferOptions.statusOf
            : agentStatusReader(ctx, c),
          log: serveLog,
        });
        state.deferLiveBuild = liveBuildDefer.report();
      }
      const wrapped = function follow(request, signal) {
        if (!active) return original.call(this, request, signal);
        const refreshing = request != null && request[REFRESH_REQUEST] === true;
        const next = { ...request };
        if (refreshing) delete next[REFRESH_REQUEST];
        const initial = isInitialPage(next, config);
        // A newer follow for the same Session owns the live stream: drop any
        // yield that has not started its build yet instead of letting a stale
        // timer delay this request. Internal refresh builds do not count.
        const requestSessionId = sessionIdOf(next);
        if (liveBuildDefer && !refreshing && requestSessionId) liveBuildDefer.arrive(requestSessionId);

        if (initial) {
          next.maxMessages = config.maxMessages;
          next.turnWindow = {
            minMessages: config.minMessages,
            minTurns: config.minTurns,
          };
        }

        const startedAt = config.debug ? process.hrtime.bigint() : 0n;
        const result = original.call(this, next, signal);
        const wantTrim = config.maxBytes > 0 || config.stripStream;
        // `next` already carries the narrowed window, so reuse the decision
        // made against the original request instead of re-testing it here.
        const wantExtend = config.rewindAware && initial;
        const extension = wantExtend
          ? { original, thisArg: this, request: next, signal, state, log: serveLog }
          : null;
        const trimmed = initial && (wantTrim || wantExtend)
          ? wrapFirstSnapshot(result, config, state, ctx, extension)
          : result;
        const streamed = config.debug ? observeFirstFrame(trimmed, startedAt) : trimmed;
        const sessionId = initial ? requestSessionId : null;
        if (serveLog) {
          try {
            serveLog.write(
              'open sid=' + (sessionIdOf(next) ?? '-') + ' initial=' + initial +
                ' before=' + (next.beforeSeq ?? '-') + ' through=' + (next.throughSeq ?? '-') +
                ' max=' + (next.maxMessages ?? '-') + ' turns=' +
                (next.turnWindow ? next.turnWindow.minMessages + '/' + next.turnWindow.minTurns : '-') +
                ' stream=' + (next.assistantStream === true ? 'on' : 'off') +
                ' activate=' + (next.activate === true ? 'true' : 'false')
            );
          } catch {}
        }
        // A refresh build must reach the live history build and its capture
        // must be the one the refresher verifies; serving it from the cache
        // here would both skip that build and count a phantom hit.
        if (!initial || !pageCache || !sessionId || refreshing) return streamed;
        return wrapPageCache(streamed, {
          cache: pageCache,
          sessionId,
          variant: pageVariant(next, config),
          config,
          state,
          log: serveLog,
          defer: liveBuildDefer,
          signal,
          // The gate re-checks the request it is deferring for: an activating
          // or paged request is never deferred.
          request: next,
        });
      };

      target.follow = wrapped;
      target.__dshFastload = true;
      state.installed = true;

      // Stage 3: while a Session is quiet, walk the same read path a client
      // open takes — this wrapper, assistantStream on, activate off — and store
      // the page under the persistence revision it was built from. Everything
      // here is additive: a missing capability or a thrown error leaves the
      // refresher inert and the open path untouched.
      let releaseRefresh = () => {};
      if (config.idleCacheRefresh) {
        try {
          const refresh = createCacheRefresh({
            cache: pageCache,
            persistence,
            variant: pageVariant(
              {
                maxMessages: config.maxMessages,
                turnWindow: { minMessages: config.minMessages, minTurns: config.minTurns },
                assistantStream: true,
              },
              config
            ),
            follow(request, signal) {
              if (!active) {
                throw new Error('dsh-fastload: sessionController.follow wrapper is retired');
              }
              return wrapped.call(target, request, signal);
            },
            tag(request) {
              request[REFRESH_REQUEST] = true;
            },
            log: serveLog,
            logger: ctx.logger,
            debug: config.debug,
            timings: refreshOptions ? refreshOptions.timings : undefined,
            timers: refreshOptions ? refreshOptions.timers : undefined,
            probeLoad: refreshOptions ? refreshOptions.probeLoad : undefined,
            now: refreshOptions ? refreshOptions.now : undefined,
          });
          state.idleRefresh = refresh.report;
          const offs = [];
          releaseRefresh = () => {
            for (const off of offs) {
              if (typeof off !== 'function') continue;
              try {
                off();
              } catch {}
            }
            refresh.dispose();
          };
          const listen = typeof ctx.on === 'function'
            ? ctx.on.bind(ctx)
            : typeof c.on === 'function' ? c.on.bind(c) : null;
          if (refresh.report.active && !listen) {
            refresh.dispose();
            state.idleRefresh = { ...refresh.report, disabledReason: 'cordis event api unavailable' };
          } else if (refresh.report.active) {
            offs.push(listen('session/event', (session) => {
              if (session && typeof session.id === 'string') refresh.noteActivity(session.id);
            }, { global: true }));
            offs.push(listen('agent/status', (payload) => {
              const agent = payload && payload.agent;
              if (!agent || typeof agent.id !== 'string') return;
              refresh.noteAgentStatus(agent.id, typeof payload.status === 'string' ? payload.status : '');
            }, { global: true }));
            offs.push(listen('session/disposed', (session) => {
              if (session && typeof session.id === 'string') refresh.noteDisposed(session.id);
            }, { global: true }));
          }
        } catch (error) {
          // A partly installed subscription must not survive the failure: an
          // orphaned listener would keep starting idle refreshes behind a
          // report that already says disabled. Release before publishing.
          try {
            releaseRefresh();
          } catch {}
          state.idleRefresh = {
            active: false,
            disabledReason: String((error && error.message) || error),
          };
          if (config.debug) process.stderr.write('[fl] idle refresh error: ' + error + '\n');
        }
      }

      return () => {
        try {
          releaseRefresh();
        } catch {}
        try {
          liveBuildDefer?.dispose();
        } catch {}
        if (target.follow === wrapped) {
          if (ownDescriptor) Object.defineProperty(target, 'follow', ownDescriptor);
          else delete target.follow;
        } else {
          active = false;
          state.error =
            'sessionController.follow was re-wrapped by another plugin; the dsh-fastload wrapper was switched off and now passes requests through';
        }
        delete target.__dshFastload;
        state.installed = false;
      };
    };

    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(install, 'dsh-fastload: sessionController.follow');
      } else {
        // Hosts without ctx.effect: keep the pre-fix install-once behavior.
        install();
      }
    } catch (error) {
      state.error = String((error && error.stack) || (error && error.message) || error);
      if (config.debug) process.stderr.write('[fl] install error: ' + state.error + '\n');
    }
  });
}
