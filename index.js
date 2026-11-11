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

export const name = 'dsh-fastload';
export const inject = ['sessionController'];

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
 * Serve a stored opening page before the live history build finishes.
 *
 * The live `follow` stream is still started immediately, so activation and the
 * event queue behave exactly as before; its opening frame is dropped when it
 * agrees with the cached page and replayed as ordinary events when it is a
 * couple of records ahead. Any disagreement falls back to the cached page and
 * ends the stream rather than emitting a second opening frame.
 */
function wrapPageCache(result, options) {
  const { cache, sessionId, variant, config, state } = options;
  if (!result || typeof result[Symbol.asyncIterator] !== 'function') return result;

  return (async function* () {
    const pullAt = process.hrtime.bigint();
    let probe = { hit: false };
    try {
      probe = await cache.lookup(sessionId, variant);
    } catch {}

    const cached = probe && probe.hit ? probe.opening : null;
    const cachedCursor = cached && Number.isFinite(cached.cursor) ? cached.cursor : null;
    const cachedRevision = cached && cached.assistantStream ? cached.assistantStream.revision : undefined;
    let served = false;

    if (cached) {
      served = true;
      state.pageCacheHits += 1;
      if (config.debug) {
        const totalMs = Number(process.hrtime.bigint() - pullAt) / 1e6;
        process.stderr.write('[fl] page cache ready ' + totalMs.toFixed(1) + 'ms\n');
      }
      if (config.debug) {
        process.stderr.write('[fl] page cache served cursor=' + cachedCursor + ' records=' + (Array.isArray(cached.records) ? cached.records.length : -1) + '\n');
      }
      yield cached;
    }

    // Give the transport a turn to flush the cached page before the live
    // history build starts competing for the same thread.
    if (served) await new Promise((resolve) => setImmediate(resolve));

    let first = true;
    const iterator = result[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) return;
        const frame = step.value;

        if (first) {
          first = false;
          if (frame && frame.type === 'snapshot') {
            if (served) {
              const realCursor = Number.isFinite(frame.cursor) ? frame.cursor : null;
              const realRevision = frame.assistantStream ? frame.assistantStream.revision : undefined;
              const sameBaseline = realRevision === cachedRevision;
              if (sameBaseline && realCursor !== null && cachedCursor !== null && realCursor >= cachedCursor) {
                for (const record of frame.records || []) {
                  const event = record && record.event;
                  if (event && Number.isFinite(event.seq) && event.seq > cachedCursor) {
                    yield { type: 'event', event };
                  }
                }
                continue;
              }
              // The live page disagrees with the cached one (or the assistant
              // stream baseline moved). Keep the cached page and stop instead
              // of emitting a second opening frame.
              cache.evict(probe.key);
              state.pageCacheDropped += 1;
              if (config.debug) {
                process.stderr.write('[fl] page cache dropped cursor=' + realCursor + ' cached=' + cachedCursor + ' baseline=' + realRevision + '/' + cachedRevision + '\n');
              }
              return;
            }
            if (probe && probe.revision) cache.store(sessionId, probe.revision, probe.key, frame);
          }
        }

        yield frame;
      }
    } finally {
      try {
        await iterator.return?.();
      } catch {}
    }
  })();
}

function wrapFirstSnapshot(result, config, state, ctx) {
  const trimFrame = (frame) => {
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
    const { opening, info } = planTrim(compacted.opening, config);
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

  if (result && typeof result.then === 'function') {
    return result.then(trimFrame);
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    return (async function* () {
      let first = true;
      for await (const frame of result) {
        if (first) {
          first = false;
          yield trimFrame(frame);
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

export function apply(ctx) {
  const config = readConfig(process.env);
  const state = reuseState();
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
    ', replay streams=' + (config.stripStream ? 'stripped' : 'kept');
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

    // P5: persisted opening page, keyed by the persistence revision so it can
    // only ever serve the exact log it was built from.
    let pageCache = null;
    if (config.pageCache) {
      try {
        const persistence = typeof c.get === 'function' ? c.get('sessionPersistence') : undefined;
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
        const persistence = typeof c.get === 'function' ? c.get('sessionPersistence') : undefined;
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
      const wrapped = function follow(request, signal) {
        if (!active) return original.call(this, request, signal);
        const next = { ...request };
        const initial = isInitialPage(next, config);

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
        const trimmed = initial && wantTrim ? wrapFirstSnapshot(result, config, state, ctx) : result;
        const streamed = config.debug ? observeFirstFrame(trimmed, startedAt) : trimmed;
        const sessionId = initial ? sessionIdOf(next) : null;
        if (!initial || !pageCache || !sessionId) return streamed;
        return wrapPageCache(streamed, {
          cache: pageCache,
          sessionId,
          variant: pageVariant(next, config),
          config,
          state,
        });
      };

      target.follow = wrapped;
      target.__dshFastload = true;
      state.installed = true;

      return () => {
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
