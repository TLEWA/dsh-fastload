/**
 * Stage 5: bounded, cancellable yield between "the cached opening page was
 * sent" and "start the live history build".
 *
 * Background. On a cache hit the wrapper yields the stored opening page and
 * then resumes the live `follow` stream. Stage 3 put one `setImmediate`
 * between the two, which gives the transport a single event-loop turn. That is
 * not a paint: the browser still has to receive, decode and mount hundreds of
 * records. Whether the live build actually competes with that first paint is a
 * measurement question (see docs/design.md); this module is the opt-in answer
 * for the case where it does.
 *
 * The yield is deliberately conservative:
 *   - it only runs when the caller already proved a cache hit and an initial
 *     page, and the request is not an activation (activate !== true);
 *   - it needs positive evidence that the Session is quiet: an observable
 *     Agent service reporting something other than "running", and no active
 *     assistant attempt in the cached page. Unknown is not quiet;
 *   - it is bounded by a small budget in wall-clock time, split into
 *     setImmediate / setTimeout(0) slices;
 *   - a new request for the same Session, an aborted signal, a status that
 *     changes during the wait, or teardown all resolve it immediately.
 *
 * Nothing here throws on the build path: failures return `deferred: false` so
 * the caller can restore the original timing.
 */

export const DEFER_DEFAULTS = Object.freeze({
  /** Total wall-clock budget for the yield. Kept small: this is a paint hint, not a delay. */
  budgetMs: 16,
  /** Hard slice cap so a timer-starved loop cannot extend the budget. */
  maxSlices: 8,
});

const NOOP = () => {};

/**
 * @param {object} [options]
 * @param {number} [options.budgetMs] override for tests
 * @param {number} [options.maxSlices]
 * @param {{setTimeout:Function, clearTimeout:Function, setImmediate:Function, clearImmediate:Function}} [options.timers]
 * @param {() => number} [options.now]
 * @param {(sessionId: string) => 'idle' | 'busy' | 'unknown'} [options.statusOf]
 *   Reads the Agent status for a Session. `unknown` (missing service, missing
 *   status, thrown error) always disables the yield.
 * @param {{write: (line: string) => void}} [options.log] serve log, if enabled
 */
export function createLiveBuildDefer(options = {}) {
  const timers = options.timers || {
    setTimeout,
    clearTimeout,
    setImmediate,
    clearImmediate,
  };
  const now = typeof options.now === 'function' ? options.now : () => performance.now();
  const statusOf = typeof options.statusOf === 'function' ? options.statusOf : () => 'unknown';
  const log = options.log && typeof options.log.write === 'function' ? options.log : null;
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs >= 0
    ? options.budgetMs
    : DEFER_DEFAULTS.budgetMs;
  const maxSlices = Number.isInteger(options.maxSlices) && options.maxSlices >= 0
    ? options.maxSlices
    : DEFER_DEFAULTS.maxSlices;

  /** @type {Map<string, {cancel: (reason?: string) => void, wake: null | (() => void), reason: string, canceled: boolean}>} */
  const pending = new Map();
  let disposed = false;
  // Counters live on one shared object so a caller that keeps `report()` (for
  // example on plugin state) always sees current values, not a snapshot.
  const stats = {
    enabled: true,
    budgetMs,
    maxSlices,
    deferrals: 0,
    canceled: 0,
    skipped: 0,
    pending: 0,
  };

  /**
   * A new request for this Session cancels a yield that has not started the
   * live build yet: the newer request owns the live stream now, and a stale
   * timer must not keep a second one waiting.
   */
  function arrive(sessionId) {
    if (disposed || sessionId == null) return;
    const entry = pending.get(sessionId);
    if (entry) entry.cancel('superseded');
  }

  function slice(entry, useImmediate) {
    return new Promise((resolve) => {
      let handle = null;
      entry.wake = () => {
        entry.wake = null;
        try {
          if (useImmediate) timers.clearImmediate(handle);
          else timers.clearTimeout(handle);
        } catch {}
        resolve();
      };
      const done = () => {
        if (entry.wake === null) return;
        entry.wake = null;
        resolve();
      };
      try {
        handle = useImmediate ? timers.setImmediate(done) : timers.setTimeout(done, 0);
      } catch (error) {
        entry.wake = null;
        resolve();
      }
    });
  }

  /**
   * Decide, then wait. The returned promise resolves with
   * `{deferred, reason, waitedMs, slices}`; it never rejects.
   *
   * @param {object} request
   * @param {string|null} request.sessionId
   * @param {object} request.request the follow request that produced the hit
   * @param {object} request.cached the cached opening frame
   * @param {AbortSignal} [request.signal]
   */
  async function wait(request) {
    const sessionId = request && request.sessionId;
    const follow = request && request.request;
    const cached = request && request.cached;
    const signal = request && request.signal;

    if (disposed) return { deferred: false, reason: 'disposed', waitedMs: 0, slices: 0 };
    if (budgetMs <= 0 || maxSlices <= 0) return { deferred: false, reason: 'off', waitedMs: 0, slices: 0 };
    if (!sessionId) return { deferred: false, reason: 'no-session', waitedMs: 0, slices: 0 };
    if (!follow || follow.activate === true) return { deferred: false, reason: 'activate', waitedMs: 0, slices: 0 };
    if (follow.beforeSeq !== undefined || follow.throughSeq !== undefined) {
      return { deferred: false, reason: 'page-window', waitedMs: 0, slices: 0 };
    }
    if (cached && cached.assistantStream && cached.assistantStream.activeAttempt !== undefined) {
      return { deferred: false, reason: 'stream-active', waitedMs: 0, slices: 0 };
    }
    if (signal && signal.aborted) return { deferred: false, reason: 'aborted', waitedMs: 0, slices: 0 };

    let status = 'unknown';
    try {
      status = statusOf(sessionId);
    } catch {
      status = 'unknown';
    }
    if (status !== 'idle') {
      stats.skipped += 1;
      return { deferred: false, reason: 'agent-' + status, waitedMs: 0, slices: 0 };
    }

    const start = now();
    const entry = { canceled: false, reason: '', wake: null, cancel: NOOP };
    entry.cancel = (reason) => {
      if (entry.canceled) return;
      entry.canceled = true;
      entry.reason = typeof reason === 'string' && reason !== '' ? reason : 'canceled';
      const wake = entry.wake;
      entry.wake = null;
      if (wake) wake();
    };
    pending.set(sessionId, entry);
    stats.pending = pending.size;

    let onAbort = null;
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => entry.cancel('aborted');
      try {
        signal.addEventListener('abort', onAbort, { once: true });
      } catch {
        onAbort = null;
      }
    }

    let slices = 0;
    try {
      while (!entry.canceled && slices < maxSlices) {
        if (now() - start >= budgetMs) break;
        // Cheap re-check: a Session that became busy during the yield must not
        // keep waiting, and an unreadable status is a reason to stop.
        let live = 'unknown';
        try {
          live = statusOf(sessionId);
        } catch {
          live = 'unknown';
        }
        if (live !== 'idle') {
          entry.cancel('agent-' + live);
          break;
        }
        // Alternate the two macrotask kinds: setImmediate runs after I/O
        // callbacks, setTimeout(0) after timers, so together they cover both
        // halves of a browser paint handshake.
        const useImmediate = slices % 2 === 0;
        await slice(entry, useImmediate);
        slices += 1;
      }
    } catch {
      entry.cancel('error');
    } finally {
      if (onAbort && signal && typeof signal.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      }
      if (pending.get(sessionId) === entry) {
        pending.delete(sessionId);
        stats.pending = pending.size;
      }
      entry.wake = null;
    }

    const waitedMs = now() - start;
    stats.deferrals += 1;
    if (entry.canceled && entry.reason !== 'agent-idle') stats.canceled += 1;
    if (log) {
      try {
        log.write(
          'defer sid=' + sessionId + ' waited=' + waitedMs.toFixed(1) + 'ms slices=' + slices +
            ' budget=' + budgetMs + ' canceled=' + (entry.canceled ? entry.reason : '-')
        );
      } catch {}
    }
    return {
      deferred: true,
      reason: entry.canceled ? entry.reason : 'budget',
      waitedMs,
      slices,
    };
  }

  function dispose() {
    disposed = true;
    for (const entry of pending.values()) entry.cancel('disposed');
    pending.clear();
    stats.pending = 0;
  }

  /**
   * Live counters. The returned object is the same one the gate mutates, so a
   * caller may keep it on plugin state and read current numbers later.
   */
  function report() {
    return stats;
  }

  return { arrive, wait, dispose, report };
}
