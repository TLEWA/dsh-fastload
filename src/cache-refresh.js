/**
 * dsh-fastload — idle page-cache refresh (stage 3).
 *
 * P5 stores the opening page after a client opens it, but the store is keyed on
 * the persistence revision (the JSONL file identity), so every append — every
 * turn — invalidates the entry that was just written. The next open of a
 * just-finished Session therefore misses and pays the full build again.
 *
 * This module closes that gap passively. It never writes a Session, never
 * activates an Agent and never touches the original log: it watches Session
 * activity (and the Agent status that brackets a turn), waits for the Host to
 * go quiet, re-reads the persistence revision, and only then walks the exact
 * same read path a client open takes — the plugin's own wrapped
 * sessionController.follow with assistantStream on and activate: false — so the
 * page it captures is byte-for-byte the page a real open would get. The capture
 * is handed to the existing page cache (store + flush), which owns the key
 * (PAGE_CACHE_VERSION, Session id, revision, page variant) and the file format.
 * There is no second store.
 *
 * Correctness over coverage:
 *
 * - The revision is read *before* the build, re-read after it, and the write is
 *   dropped unless both agree; the store then re-checks the same revision.
 *   Even a race can only orphan an entry — never serve a page for a revision it
 *   was not built from, because the revision is part of the cache key.
 * - A quiet window covers the Host's 200 ms live-event batch drain, so the
 *   revision we key on already contains the records the page carries.
 * - One build at a time (follow builds are CPU heavy), spaced by minGapMs, and
 *   skipped while the Host shows event-loop lag ("high load") or while an Agent
 *   is running in the Session being refreshed.
 * - tag(request) marks the refresh request for the caller's wrapper, which must
 *   skip the page-cache replay for it. That, the absence of any write, and the
 *   fact that a build is only scheduled from *observed* activity are what rule
 *   out the refresh -> follow -> activity -> refresh loop.
 * - Every failure is swallowed: a broken cache, a hung Host or a rejected
 *   follow can degrade the feature to a no-op but can never break a normal
 *   open, which still takes the untouched path.
 *
 * The module is pure orchestration: timers, clock and load probe are injectable
 * so the queue, the debounce, the cancellation and the revision guard can be
 * tested without a DSH Host.
 */

/** Bumped when the request shape or the guards below change. */
export const REFRESH_VERSION = 1;

/** Capability the page cache must expose; matched against cache.version. */
const CACHE_API_VERSION = 1;

/**
 * Upper bound for closing the opening iterator. An async generator queues
 * return() behind an outstanding next(), so a read that never settles would
 * otherwise hold the global build slot after its timeout has already fired.
 */
const READ_OPENING_CLEANUP_MS = 250;

/**
 * Timings chosen against the DSH Host, not against a benchmark:
 *
 * - idleMs has to be longer than the gaps inside one turn (tool round-trips are
 *   sub-second) and long enough that a turn that just ended has settled;
 * - settleMs has to cover the JSONL writer's 200 ms live-event batch drain, so
 *   the pre-build revision already contains every record in the page;
 * - lagBudgetMs turns "the Host is busy" into a deferral rather than a
 *   competing build;
 * - buildTimeoutMs keeps one hung read from blocking the global queue.
 */
export const REFRESH_DEFAULTS = Object.freeze({
  idleMs: 4000,
  settleMs: 600,
  lagBudgetMs: 60,
  busyRetryMs: 1500,
  minGapMs: 2000,
  maxDeferrals: 12,
  maxSessions: 256,
  maxFailures: 3,
  buildTimeoutMs: 30000,
});

function normalizeId(value) {
  return typeof value === 'string' && value !== '' && value.length <= 256 ? value : null;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function resolveTimings(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    idleMs: clampInt(source.idleMs, REFRESH_DEFAULTS.idleMs, 1, 600000),
    settleMs: clampInt(source.settleMs, REFRESH_DEFAULTS.settleMs, 0, 600000),
    lagBudgetMs: clampInt(source.lagBudgetMs, REFRESH_DEFAULTS.lagBudgetMs, 1, 10000),
    busyRetryMs: clampInt(source.busyRetryMs, REFRESH_DEFAULTS.busyRetryMs, 1, 600000),
    minGapMs: clampInt(source.minGapMs, REFRESH_DEFAULTS.minGapMs, 0, 600000),
    maxDeferrals: clampInt(source.maxDeferrals, REFRESH_DEFAULTS.maxDeferrals, 1, 1000),
    maxSessions: clampInt(source.maxSessions, REFRESH_DEFAULTS.maxSessions, 1, 10000),
    maxFailures: clampInt(source.maxFailures, REFRESH_DEFAULTS.maxFailures, 1, 1000),
    buildTimeoutMs: clampInt(source.buildTimeoutMs, REFRESH_DEFAULTS.buildTimeoutMs, 1, 600000),
  };
}

/** Real event-loop lag: how late a zero-delay timer runs. */
async function defaultLoadProbe() {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return Date.now() - started;
}

/** Remember a value with a bounded map (Map keeps insertion order). */
function remember(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Report an inert refresher: same surface, no timers, no builds.
 * Used when the Host lacks the private pieces this feature depends on.
 */
function inertRefresher(reason, logger) {
  const report = {
    version: REFRESH_VERSION,
    active: false,
    disabledReason: reason,
    scheduled: 0,
    built: 0,
    stored: 0,
    skippedCached: 0,
    skippedSameRevision: 0,
    skippedRunning: 0,
    skippedEmpty: 0,
    skippedNoBaseline: 0,
    skippedNoRevision: 0,
    revisionMoved: 0,
    deferred: 0,
    failed: 0,
    aborted: 0,
    pending: 0,
    queued: 0,
    inFlight: null,
    lastStore: null,
  };
  if (reason) {
    try {
      logger?.info?.('[dsh-fastload] idle cache refresh off: ' + reason);
    } catch {}
  }
  const noop = () => {};
  return {
    report,
    noteActivity: noop,
    noteAgentStatus: noop,
    forgetAgent: noop,
    noteDisposed: noop,
    dispose: noop,
    drain: () => Promise.resolve(),
  };
}

/**
 * Create the idle refresher.
 *
 * @param {object} options
 * @param {object} options.cache page cache api from createPageCache
 * @param {{stat: Function}} options.persistence sessionPersistence service
 * @param {string} options.variant page variant a real client open would use
 * @param {Function} options.follow (request, signal) => iterable — the plugin's
 *   wrapped follow, tagged through options.tag
 * @param {Function} [options.tag] marks a request as a refresh build
 * @param {Function} [options.log] serve-log writer (write(line))
 * @param {object} [options.timings] overrides for REFRESH_DEFAULTS
 * @param {object} [options.timers] { setTimeout, clearTimeout }
 * @param {Function} [options.probeLoad] async () => event-loop lag in ms
 * @param {Function} [options.now] clock in ms
 * @returns {{report: object, noteActivity: Function, noteAgentStatus: Function,
 *   forgetAgent: Function, noteDisposed: Function, dispose: Function,
 *   drain: () => Promise<void>}}
 */
export function createCacheRefresh(options = {}) {
  const cache = options.cache;
  const persistence = options.persistence;
  const follow = options.follow;
  const variant = options.variant;
  const tag = typeof options.tag === 'function' ? options.tag : null;
  const log = options.log && typeof options.log.write === 'function' ? options.log : null;
  const logger = options.logger;
  const debug = options.debug === true;
  const timings = resolveTimings(options.timings);
  const timers = options.timers && typeof options.timers.setTimeout === 'function'
    && typeof options.timers.clearTimeout === 'function'
    ? options.timers
    : {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    };
  const probeLoad = typeof options.probeLoad === 'function' ? options.probeLoad : defaultLoadProbe;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // Capability guard: never enable against a private interface we do not know.
  // The page cache is the only store we may write through, so its read, write
  // and durability entry points must all be present and of this generation.
  if (!cache || typeof cache !== 'object'
    || typeof cache.lookup !== 'function'
    || typeof cache.store !== 'function'
    || typeof cache.flush !== 'function') {
    return inertRefresher('page cache api unavailable', logger);
  }
  if (cache.enabled === false) return inertRefresher('page cache disabled', logger);
  if (typeof cache.version === 'number' && cache.version !== CACHE_API_VERSION) {
    return inertRefresher('unsupported page cache api v' + cache.version, logger);
  }
  if (!persistence || typeof persistence.stat !== 'function') {
    return inertRefresher('sessionPersistence.stat unavailable', logger);
  }
  if (typeof follow !== 'function' || typeof variant !== 'string' || variant === '') {
    return inertRefresher('refresh follow or page variant missing', logger);
  }

  // The stored page claims an assistant-stream baseline only when the variant
  // says a client would ask for one; then the captured frame must carry it,
  // otherwise the replay wrapper would drop the entry on the first open.
  let wantsBaseline = false;
  try {
    const fields = JSON.parse(variant);
    wantsBaseline = Array.isArray(fields) && fields[3] === true;
  } catch {
    return inertRefresher('page variant is not parsable', logger);
  }

  const report = {
    version: REFRESH_VERSION,
    active: true,
    disabledReason: null,
    scheduled: 0,
    built: 0,
    stored: 0,
    skippedCached: 0,
    skippedSameRevision: 0,
    skippedRunning: 0,
    skippedEmpty: 0,
    skippedNoBaseline: 0,
    skippedNoRevision: 0,
    revisionMoved: 0,
    deferred: 0,
    failed: 0,
    aborted: 0,
    pending: 0,
    queued: 0,
    inFlight: null,
    lastStore: null,
  };

  let active = true;
  let pumping = false;
  let lastBuildAt = 0;
  let failures = 0;
  const queue = [];
  const queued = new Set();
  const debounces = new Map();
  const deferrals = new Map();
  const lastStored = new Map();
  const agentStatus = new Map();
  const waiters = new Set();
  const drainers = new Set();
  const controllers = new Set();
  // One build per Session at most: an Agent that starts working while its page
  // is being captured invalidates that page, so the build is aborted instead of
  // competing with the turn for the same thread.
  const runningBuilds = new Map();

  function writeLog(line) {
    try {
      log?.write(line);
    } catch {}
  }

  function sleep(ms) {
    if (!active || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { timer: null, resolve: null };
      waiter.resolve = () => {
        waiters.delete(waiter);
        resolve();
      };
      waiter.timer = timers.setTimeout(waiter.resolve, ms);
      waiters.add(waiter);
    });
  }

  function settleDrainers() {
    if (active && (pumping || queue.length > 0 || report.inFlight !== null)) return;
    for (const resolve of [...drainers]) {
      drainers.delete(resolve);
      resolve();
    }
  }

  function stop() {
    active = false;
    report.active = false;
    report.inFlight = null;
    report.pending = 0;
    report.queued = 0;
    for (const handle of debounces.values()) timers.clearTimeout(handle);
    debounces.clear();
    queue.length = 0;
    queued.clear();
    deferrals.clear();
    for (const waiter of [...waiters]) {
      timers.clearTimeout(waiter.timer);
      waiter.resolve();
    }
    waiters.clear();
    for (const controller of [...controllers]) {
      try {
        controller.abort();
      } catch {}
    }
    controllers.clear();
    settleDrainers();
  }

  function disable(reason) {
    if (!active) return;
    report.disabledReason = reason;
    writeLog('refresh-off ' + reason);
    if (debug) process.stderr.write('[fl] idle refresh off: ' + reason + '\n');
    stop();
  }

  function schedule(sessionId, delay) {
    if (!active) return;
    const existing = debounces.get(sessionId);
    if (existing !== undefined) timers.clearTimeout(existing);
    const handle = timers.setTimeout(() => {
      debounces.delete(sessionId);
      report.pending = debounces.size;
      enqueue(sessionId);
    }, Math.max(1, delay));
    debounces.set(sessionId, handle);
    report.pending = debounces.size;
  }

  function cancelQueued(sessionId) {
    const index = queue.indexOf(sessionId);
    if (index >= 0) queue.splice(index, 1);
    queued.delete(sessionId);
    deferrals.delete(sessionId);
    report.queued = queue.length;
  }

  function cancel(sessionId) {
    const handle = debounces.get(sessionId);
    if (handle !== undefined) {
      timers.clearTimeout(handle);
      debounces.delete(sessionId);
      report.pending = debounces.size;
    }
    cancelQueued(sessionId);
  }

  function enqueue(sessionId) {
    if (!active || queued.has(sessionId)) return;
    if (queue.length >= timings.maxSessions) return;
    queue.push(sessionId);
    queued.add(sessionId);
    report.queued = queue.length;
    void pump();
  }

  function dropHead(reason) {
    const head = queue.shift();
    if (head !== undefined) {
      queued.delete(head);
      deferrals.delete(head);
    }
    report.queued = queue.length;
    if (reason) writeLog('refresh-skip sid=' + head + ' reason=' + reason);
  }

  async function safeProbe() {
    try {
      const lag = await probeLoad();
      return Number.isFinite(lag) ? lag : 0;
    } catch {
      return 0;
    }
  }

  async function pump() {
    if (pumping || !active) return;
    pumping = true;
    try {
      while (active && queue.length > 0) {
        const head = queue[0];
        const deferredCount = deferrals.get(head) ?? 0;
        if (deferredCount >= timings.maxDeferrals) {
          report.failed += 1;
          dropHead('deferred ' + deferredCount + ' times');
          continue;
        }
        const gap = now() - lastBuildAt;
        if (gap < timings.minGapMs) {
          await sleep(timings.minGapMs - gap);
          continue;
        }
        const lag = await safeProbe();
        if (!active) break;
        // The head may be cancelled while the probe is awaited (Session
        // disposed, Agent started). Never shift a different Session and then
        // build the stale head; loop again with the current head.
        if (queue[0] !== head) continue;
        if (lag > timings.lagBudgetMs) {
          deferrals.set(head, deferredCount + 1);
          report.deferred += 1;
          await sleep(timings.busyRetryMs);
          continue;
        }
        queue.shift();
        queued.delete(head);
        deferrals.delete(head);
        report.queued = queue.length;
        await build(head);
        lastBuildAt = now();
      }
    } finally {
      pumping = false;
      settleDrainers();
      if (active && queue.length > 0) void pump();
    }
  }

  /**
   * Ask the iterator to close without waiting forever: the abort above has
   * already given up on the read, so cleanup must be bounded too. A late
   * rejection is consumed here instead of surfacing as an unhandled one.
   */
  function closeIterator(iterator) {
    return new Promise((resolve) => {
      let deadline = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (deadline !== null) {
          try {
            timers.clearTimeout(deadline);
          } catch {}
          deadline = null;
        }
        resolve();
      };
      deadline = timers.setTimeout(finish, READ_OPENING_CLEANUP_MS);
      try {
        const returned = typeof iterator.return === 'function' ? iterator.return() : undefined;
        if (returned && typeof returned.then === 'function') returned.then(finish, finish);
        else finish();
      } catch {
        finish();
      }
    });
  }

  async function readOpening(sessionId, controller) {
    const request = {
      address: { kind: 'session', sessionId },
      assistantStream: true,
      activate: false,
    };
    if (tag) {
      try {
        tag(request);
      } catch {}
    }
    // A read that never settles must not hold the single build slot forever:
    // abort the stream and fail the build through a race, so the next Session
    // in the queue can proceed.
    let timedOut = false;
    let deadline = null;
    const timeout = new Promise((_, reject) => {
      deadline = timers.setTimeout(() => {
        timedOut = true;
        controller.fastloadTimedOut = true;
        try {
          controller.abort();
        } catch {}
        const error = new Error('refresh build timed out after ' + timings.buildTimeoutMs + 'ms');
        error.code = 'REFRESH_TIMEOUT';
        reject(error);
      }, timings.buildTimeoutMs);
    });
    timeout.catch(() => {});
    try {
      const stream = await Promise.race([
        (async () => {
          let opened = follow(request, controller.signal);
          if (opened && typeof opened.then === 'function') opened = await opened;
          return opened;
        })(),
        timeout,
      ]);
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return null;
      const iterator = stream[Symbol.asyncIterator]();
      try {
        const step = await Promise.race([iterator.next(), timeout]);
        return step && !step.done ? step.value : null;
      } finally {
        await closeIterator(iterator);
      }
    } finally {
      if (deadline !== null) timers.clearTimeout(deadline);
      if (timedOut) {
        try {
          controller.abort();
        } catch {}
      }
    }
  }

  async function statRevision(sessionId) {
    try {
      const observed = await persistence.stat(sessionId);
      const revision = observed && typeof observed.revision === 'string' ? observed.revision : '';
      return revision === '' ? null : revision;
    } catch {
      return null;
    }
  }

  function noteFailure(error) {
    report.failed += 1;
    failures += 1;
    if (debug) process.stderr.write('[fl] idle refresh failed: ' + error + '\n');
    if (failures >= timings.maxFailures) disable('repeated failures: ' + error);
  }

  async function build(sessionId) {
    if (!active) return;
    report.inFlight = sessionId;
    try {
      let probe = null;
      try {
        probe = await cache.lookup(sessionId, variant);
      } catch (error) {
        noteFailure(error);
        return;
      }
      if (!active) return;
      if (!probe || probe.hit) {
        report.skippedCached += 1;
        return;
      }
      const revision = typeof probe.revision === 'string' && probe.revision !== '' ? probe.revision : null;
      // The key must be the one lookup derived for this revision; storing under
      // anything else would publish a page the next lookup can never find.
      const key = typeof probe.key === 'string' && probe.key !== '' ? probe.key : null;
      if (revision === null || key === null) {
        report.skippedNoRevision += 1;
        return;
      }
      if (lastStored.get(sessionId) === revision) {
        report.skippedSameRevision += 1;
        return;
      }
      if (agentStatus.get(sessionId) === 'running') {
        report.skippedRunning += 1;
        schedule(sessionId, timings.idleMs);
        return;
      }

      // Wait out the writer's live-event batch before trusting the revision.
      await sleep(timings.settleMs);
      if (!active) return;
      const settled = await statRevision(sessionId);
      if (!active) return;
      if (settled === null) {
        noteFailure('session persistence stat failed');
        return;
      }
      if (settled !== revision) {
        report.revisionMoved += 1;
        schedule(sessionId, timings.idleMs);
        return;
      }

      // The Agent can start during the settle wait or the stat above; the
      // earlier check predates both. Re-check before creating a controller or
      // following, because noteAgentStatus cannot find a controller until it
      // is registered and would let a running Session be followed.
      if (agentStatus.get(sessionId) === 'running') {
        report.skippedRunning += 1;
        schedule(sessionId, timings.idleMs);
        return;
      }

      const controller = new AbortController();
      controllers.add(controller);
      runningBuilds.set(sessionId, controller);
      let frame = null;
      try {
        frame = await readOpening(sessionId, controller);
      } catch (error) {
        // An abort is expected (Agent started, plugin unloaded) and counted
        // once below; a timeout is a Host problem and counts as a failure.
        if (error && error.code === 'REFRESH_TIMEOUT') noteFailure(error);
        else if (!controller.signal.aborted) noteFailure(error);
      } finally {
        controllers.delete(controller);
        if (runningBuilds.get(sessionId) === controller) runningBuilds.delete(sessionId);
      }
      if (!active) return;
      if (controller.signal.aborted) {
        if (!controller.fastloadTimedOut) report.aborted += 1;
        return;
      }
      if (!frame || frame.type !== 'snapshot' || !Array.isArray(frame.records) || frame.records.length === 0) {
        report.skippedEmpty += 1;
        return;
      }
      if (wantsBaseline && (!frame.assistantStream || typeof frame.assistantStream.revision !== 'number')) {
        report.skippedNoBaseline += 1;
        return;
      }

      // Second revision check: the page must belong to the log it is keyed on.
      const after = await statRevision(sessionId);
      if (!active) return;
      if (after === null) {
        noteFailure('session persistence stat failed after build');
        return;
      }
      if (after !== revision) {
        report.revisionMoved += 1;
        schedule(sessionId, timings.idleMs);
        return;
      }

      try {
        cache.store(sessionId, revision, key, frame);
        await cache.flush();
      } catch (error) {
        noteFailure(error);
        return;
      }
      if (!active) return;
      failures = 0;
      report.built += 1;
      report.stored += 1;
      report.lastStore = { sessionId, revision, records: frame.records.length, cursor: frame.cursor ?? null };
      remember(lastStored, sessionId, revision, timings.maxSessions);
      writeLog(
        'refresh-store sid=' + sessionId + ' rev=' + revision + ' records=' + frame.records.length +
          ' cursor=' + (frame.cursor ?? '-') + ' key=' + key
      );
      if (debug) {
        process.stderr.write(
          '[fl] idle refresh stored sid=' + sessionId + ' records=' + frame.records.length +
            ' cursor=' + (frame.cursor ?? '-') + '\n'
        );
      }
    } catch (error) {
      if (active) noteFailure(error);
    } finally {
      if (report.inFlight === sessionId) report.inFlight = null;
    }
  }

  return {
    report,
    /** A Session event was committed: restart the quiet window. */
    noteActivity(sessionId) {
      try {
        const id = normalizeId(sessionId);
        if (!active || id === null) return;
        report.scheduled += 1;
        schedule(id, timings.idleMs);
      } catch {}
    },
    /** The Agent owning this Session started or stopped working. */
    noteAgentStatus(sessionId, status) {
      try {
        const id = normalizeId(sessionId);
        if (!active || id === null) return;
        if (status === 'running') {
          remember(agentStatus, id, 'running', timings.maxSessions);
          // A turn in progress is not an idle window, whatever the event gap,
          // and a capture already under way is about to describe a stale page.
          cancel(id);
          const inflight = runningBuilds.get(id);
          if (inflight) {
            try {
              inflight.abort();
            } catch {}
          }
          return;
        }
        const wasRunning = agentStatus.get(id) === 'running';
        remember(agentStatus, id, 'idle', timings.maxSessions);
        if (wasRunning) {
          report.scheduled += 1;
          schedule(id, timings.idleMs);
        }
      } catch {}
    },
    forgetAgent(sessionId) {
      try {
        const id = normalizeId(sessionId);
        if (id !== null) agentStatus.delete(id);
      } catch {}
    },
    noteDisposed(sessionId) {
      try {
        const id = normalizeId(sessionId);
        if (id === null) return;
        cancel(id);
        runningBuilds.delete(id);
        agentStatus.delete(id);
        lastStored.delete(id);
        deferrals.delete(id);
      } catch {}
    },
    dispose() {
      if (!active) return;
      stop();
    },
    /**
     * Resolve once no debounce, queue entry or build is left (tests, and a
     * teardown that wants to know the queue is empty).
     */
    drain() {
      if (!active || (queue.length === 0 && !pumping && report.inFlight === null && debounces.size === 0)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => drainers.add(resolve));
    },
  };
}
