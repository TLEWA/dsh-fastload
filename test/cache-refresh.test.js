import assert from 'node:assert/strict';
import test from 'node:test';

import { REFRESH_DEFAULTS, REFRESH_VERSION, createCacheRefresh } from '../src/cache-refresh.js';

// The page variant a real client open resolves to: 100 messages, 40/2 turn
// window, assistant stream on, no byte trim, 8 MiB hard cap, 2 minTurns.
const VARIANT = JSON.stringify([100, 40, 2, true, 0, 8 * 1024 * 1024, 2, true]);

function record(seq, type) {
  return { type: 'event', event: { seq, type } };
}

function frame(overrides = {}) {
  return {
    type: 'snapshot',
    cursor: 2,
    hasMore: true,
    assistantStream: { revision: 0 },
    records: [record(1, 'turn/start'), record(2, 'assistant/message')],
    ...overrides,
  };
}

function fakeCache(options = {}) {
  const script = Array.isArray(options.revisions) ? options.revisions.slice() : null;
  const state = {
    revision: options.revision === undefined ? 'rev-1' : options.revision,
    hit: options.hit || null,
    version: options.version === undefined ? 1 : options.version,
    enabled: options.enabled === undefined ? true : options.enabled,
    calls: { lookup: 0, store: 0, flush: 0 },
    stored: [],
  };
  const cache = {
    enabled: state.enabled,
    version: state.version,
    async lookup(sessionId, variant) {
      state.calls.lookup += 1;
      state.lastLookup = { sessionId, variant };
      if (script) state.revision = script.length > 1 ? script.shift() : script[0];
      if (state.hit) {
        return { hit: true, revision: state.revision, key: 'key-' + state.revision, opening: state.hit };
      }
      return { hit: false, revision: state.revision, key: 'key-' + state.revision };
    },
    store(sessionId, revision, key, opening) {
      state.calls.store += 1;
      state.stored.push({ sessionId, revision, key, opening });
    },
    async flush() {
      state.calls.flush += 1;
    },
  };
  return { cache, state };
}

// The last script entry repeats once the script is exhausted.
function fakePersistence(script = ['rev-1']) {
  const calls = [];
  const service = {
    async stat(sessionId) {
      calls.push(sessionId);
      const value = script.length > 1 ? script.shift() : script[0];
      if (value instanceof Error) throw value;
      if (value === null || value === undefined) return null;
      return { revision: value };
    },
  };
  return { service, calls };
}

// Deterministic timers: tests decide when the quiet window elapses. Every
// timer callback is followed by a macrotask so the async build pipeline drains.
function manualTimers() {
  let seq = 0;
  const pending = new Map();
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    timers: {
      setTimeout(fn, ms) {
        seq += 1;
        pending.set(seq, { fn, ms: Math.max(0, Number(ms) || 0) });
        return seq;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    pending: () => pending.size,
    async fireNext() {
      if (pending.size === 0) return false;
      const [id, item] = [...pending.entries()].sort(
        (a, b) => a[1].ms - b[1].ms || a[0] - b[0]
      )[0];
      pending.delete(id);
      item.fn();
      await settle();
      return true;
    },
    async run(limit = 40) {
      let fired = 0;
      while (fired < limit && (await this.fireNext())) fired += 1;
      await settle();
      return fired;
    },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'condition not met within ' + timeoutMs + 'ms');
}

function make(options = {}) {
  const clock = manualTimers();
  const { cache, state } = fakeCache(options.cache);
  const persistence = fakePersistence(options.revisions);
  const follows = [];
  const logs = [];
  const follow = options.follow || (async function* (request, signal) {
    follows.push({ request, signal });
    if (typeof options.beforeYield === 'function') options.beforeYield();
    yield frame();
  });
  const refresh = createCacheRefresh({
    cache,
    persistence: persistence.service,
    variant: options.variant || VARIANT,
    follow,
    tag: options.tag,
    log: { write: (line) => logs.push(line) },
    timings: {
      idleMs: 5,
      settleMs: 0,
      minGapMs: 0,
      busyRetryMs: 5,
      buildTimeoutMs: 5000,
      ...(options.timings || {}),
    },
    timers: clock.timers,
    probeLoad: options.probeLoad || (async () => 0),
    now: () => 0,
  });
  return { refresh, cache, state, persistence, follows, logs, clock };
}

test('captures the opening page and stores it under the revision it was built from', async () => {
  const t = make();
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();

    assert.equal(t.state.calls.store, 1);
    assert.equal(t.state.stored[0].sessionId, 'session-a');
    assert.equal(t.state.stored[0].revision, 'rev-1');
    assert.equal(t.state.stored[0].key, 'key-rev-1');
    assert.deepEqual(t.state.stored[0].opening.records, frame().records);
    assert.equal(t.state.calls.flush, 1, 'a published page is durable before it counts');
    assert.equal(t.refresh.report.stored, 1);
    assert.equal(t.refresh.report.active, true);
    assert.equal(t.refresh.report.lastStore.sessionId, 'session-a');
    assert.equal(t.refresh.report.lastStore.records, 2);
    assert.match(t.logs.join('\n'), /refresh-store sid=session-a rev=rev-1/);
    assert.equal(t.persistence.calls.length, 2, 'revision read before and after the build');
  } finally {
    t.refresh.dispose();
  }
});

test('issues the same request shape a client open uses, marked for the wrapper', async () => {
  const t = make({ tag: (request) => { request.marked = true; } });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();

    assert.equal(t.follows.length, 1);
    const { request, signal } = t.follows[0];
    assert.deepEqual(request.address, { kind: 'session', sessionId: 'session-a' });
    assert.equal(request.activate, false, 'a refresh must never activate an Agent');
    assert.equal(request.assistantStream, true);
    assert.equal(request.marked, true, 'the wrapper needs the tag to skip its page cache');
    assert.equal(signal instanceof AbortSignal, true);
  } finally {
    t.refresh.dispose();
  }
});

test('debounces per session so one turn produces one build', async () => {
  const t = make({ timings: { idleMs: 10 } });
  try {
    t.refresh.noteActivity('session-a');
    t.refresh.noteActivity('session-a');
    t.refresh.noteActivity('session-a');
    assert.equal(t.refresh.report.scheduled, 3);
    assert.equal(t.clock.pending(), 1, 'one timer per session');

    await t.clock.run();
    assert.equal(t.state.calls.store, 1);
    assert.equal(t.follows.length, 1);
  } finally {
    t.refresh.dispose();
  }
});

test('tracks sessions independently but builds them one at a time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let running = 0;
  let maxRunning = 0;
  const stored = [];
  const t = make({
    follow: async function* () {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        await gate;
        yield frame();
      } finally {
        running -= 1;
      }
    },
  });
  t.state.stored = stored;
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.fireNext();
    await waitFor(() => running === 1);

    t.refresh.noteActivity('session-b');
    await t.clock.fireNext();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(running, 1, 'the second build waits for the single build slot');

    release();
    await waitFor(() => t.state.calls.store === 2);
    assert.equal(maxRunning, 1);
    assert.deepEqual(stored.map((entry) => entry.sessionId).sort(), ['session-a', 'session-b']);
  } finally {
    release();
    t.refresh.dispose();
  }
});

test('does not build a cancelled queue head after the load probe', async () => {
  let releaseProbe;
  let probeCalls = 0;
  const t = make({
    probeLoad: () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        return new Promise((resolve) => {
          releaseProbe = resolve;
        });
      }
      return Promise.resolve(0);
    },
  });
  try {
    t.refresh.noteActivity('session-a');
    t.refresh.noteActivity('session-b');
    await t.clock.fireNext(); // idle timer for A; pump blocks in the probe
    await waitFor(() => probeCalls === 1);
    await t.clock.fireNext(); // idle timer for B while the probe is pending
    assert.equal(t.refresh.report.queued, 2);

    t.refresh.noteDisposed('session-a');
    assert.equal(t.refresh.report.queued, 1, 'the disposed head is dropped from the queue');

    releaseProbe(0);
    await waitFor(
      () => t.follows.length === 1 && t.refresh.report.inFlight === null && t.refresh.report.queued === 0
    );

    assert.deepEqual(
      t.follows.map((entry) => entry.request.address.sessionId),
      ['session-b'],
      'the stale head is not followed'
    );
    assert.equal(t.state.stored.length, 1);
    assert.equal(t.state.stored[0].sessionId, 'session-b');
    assert.equal(t.refresh.report.built, 1);
  } finally {
    if (releaseProbe) releaseProbe(0);
    t.refresh.dispose();
  }
});

test('skips a session whose page is already cached', async () => {
  const t = make({ cache: { hit: frame() } });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.skippedCached, 1);
    assert.equal(t.state.calls.store, 0);
    assert.equal(t.follows.length, 0);
  } finally {
    t.refresh.dispose();
  }
});

test('skips a stat result that carries no revision', async () => {
  const t = make({ cache: { revision: '' } });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.skippedNoRevision, 1);
    assert.equal(t.state.calls.store, 0);
    assert.equal(t.follows.length, 0);
  } finally {
    t.refresh.dispose();
  }
});

test('never rebuilds the revision it already stored, even if the file vanished', async () => {
  const t = make();
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.state.calls.store, 1);

    // The fake cache keeps reporting a miss for the same revision, which is
    // what a pruned or evicted entry looks like.
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.skippedSameRevision, 1);
    assert.equal(t.state.calls.store, 1);
    assert.equal(t.follows.length, 1, 'no refresh -> follow -> refresh loop');
  } finally {
    t.refresh.dispose();
  }
});

test('drops the build when the revision moves during the quiet window', async () => {
  // Lookup saw rev-1 and the settled read saw rev-1; the page is dropped
  // because the read taken after the build now says rev-2. The retry has to
  // observe rev-2 on lookup, otherwise this would loop forever.
  const t = make({
    revisions: ['rev-1', 'rev-2'],
    cache: { revisions: ['rev-1', 'rev-2'] },
  });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();

    assert.equal(t.refresh.report.revisionMoved, 1);
    assert.equal(t.state.stored.length, 1);
    assert.equal(t.state.stored[0].revision, 'rev-2');
    assert.equal(t.state.stored.some((entry) => entry.revision === 'rev-1'), false);
    assert.equal(t.persistence.calls.length, 4, 'two reads per attempt');
  } finally {
    t.refresh.dispose();
  }
});

test('drops the build when the revision moves while the page is being read', async () => {
  // The writer appends during the follow itself: the opening belongs to
  // rev-1, but by the time the build finishes the file is rev-2, so the
  // opening must not be stored under rev-1.
  let t;
  t = make({
    revisions: ['rev-1', 'rev-2'],
    beforeYield: () => {
      t.state.revision = 'rev-2';
    },
  });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();

    assert.equal(t.refresh.report.revisionMoved, 1);
    assert.equal(t.state.stored.length, 1);
    assert.equal(t.state.stored[0].revision, 'rev-2');
    assert.equal(t.state.stored.some((entry) => entry.revision === 'rev-1'), false);
    assert.equal(t.follows.length, 2, 'the opening built under rev-1 was discarded');
    assert.equal(t.persistence.calls.length, 4);
  } finally {
    t.refresh.dispose();
  }
});

test('requires the assistant stream baseline the variant advertises', async () => {
  const t = make({ follow: async function* () { yield frame({ assistantStream: undefined }); } });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.skippedNoBaseline, 1);
    assert.equal(t.state.calls.store, 0);
  } finally {
    t.refresh.dispose();
  }
});

test('accepts a page without a baseline when the variant does not ask for one', async () => {
  const variant = JSON.stringify([100, 40, 2, false, 0, 8 * 1024 * 1024, 2, true]);
  const t = make({
    variant,
    follow: async function* () { yield frame({ assistantStream: undefined }); },
  });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.skippedNoBaseline, 0);
    assert.equal(t.state.calls.store, 1);
  } finally {
    t.refresh.dispose();
  }
});

test('stays inert when the page cache api is unknown or incomplete', async () => {
  const base = {
    cache: fakeCache().cache,
    persistence: fakePersistence().service,
    variant: VARIANT,
    follow: async function* () { yield frame(); },
  };
  const incomplete = { ...base.cache };
  delete incomplete.flush;
  const noFlush = createCacheRefresh({ ...base, cache: incomplete });
  assert.equal(noFlush.report.active, false);
  assert.match(noFlush.report.disabledReason, /page cache api unavailable/);

  const wrongVersion = createCacheRefresh({ ...base, cache: { ...base.cache, version: 2 } });
  assert.equal(wrongVersion.report.active, false);
  assert.match(wrongVersion.report.disabledReason, /unsupported page cache api v2/);

  const noStat = createCacheRefresh({ ...base, persistence: {} });
  assert.equal(noStat.report.active, false);
  assert.match(noStat.report.disabledReason, /sessionPersistence.stat unavailable/);

  const noFollow = createCacheRefresh({ ...base, follow: undefined });
  assert.equal(noFollow.report.active, false);
  assert.match(noFollow.report.disabledReason, /refresh follow or page variant missing/);

  const badVariant = createCacheRefresh({ ...base, variant: 'not json' });
  assert.equal(badVariant.report.active, false);
  assert.match(badVariant.report.disabledReason, /page variant is not parsable/);

  // An inert refresher is safe to call and never touches the cache.
  noStat.noteActivity('session-a');
  noStat.noteAgentStatus('session-a', 'running');
  noStat.noteDisposed('session-a');
  noStat.forgetAgent('session-a');
  await noStat.drain();
  noStat.dispose();
  assert.equal(base.cache.stats, undefined);
});

test('refuses to build while the Agent for that session is running', async () => {
  const t = make();
  try {
    t.refresh.noteAgentStatus('session-a', 'running');
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.state.calls.store, 0);
    assert.equal(t.follows.length, 0);

    t.refresh.noteAgentStatus('session-a', 'idle');
    await t.clock.run();
    assert.equal(t.state.calls.store, 1);
  } finally {
    t.refresh.dispose();
  }
});

test('aborts a capture that is in flight when the Agent starts a turn', async () => {
  const t = make({
    follow: async function* (request, signal) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      yield frame();
    },
  });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.fireNext();
    await waitFor(() => t.refresh.report.inFlight === 'session-a');

    t.refresh.noteAgentStatus('session-a', 'running');
    await waitFor(() => t.refresh.report.inFlight === null);
    assert.equal(t.refresh.report.aborted, 1);
    assert.equal(t.state.calls.store, 0);
  } finally {
    t.refresh.dispose();
  }
});

test('defers a build while the Host reports event-loop lag', async () => {
  let lag = 100;
  const t = make({ probeLoad: async () => lag, timings: { maxDeferrals: 2 } });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.deferred, 2);
    assert.equal(t.refresh.report.failed, 1, 'hopeless queue entries are dropped');
    assert.equal(t.state.calls.store, 0);
    assert.equal(t.follows.length, 0);

    lag = 0;
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.state.calls.store, 1);
  } finally {
    t.refresh.dispose();
  }
});

test('disables itself after repeated failures instead of retrying forever', async () => {
  const t = make({
    timings: { maxFailures: 2 },
    follow: async function* () { throw new Error('controller exploded'); },
  });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.failed, 1);
    assert.equal(t.refresh.report.active, true);

    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.refresh.report.active, false);
    assert.match(t.refresh.report.disabledReason, /repeated failures/);

    const scheduled = t.refresh.report.scheduled;
    t.refresh.noteActivity('session-a');
    assert.equal(t.refresh.report.scheduled, scheduled, 'a disabled refresher ignores activity');
    assert.equal(t.clock.pending(), 0);
  } finally {
    t.refresh.dispose();
  }
});

test('dispose cancels a pending quiet window', async () => {
  const t = make();
  t.refresh.noteActivity('session-a');
  assert.equal(t.clock.pending(), 1);
  t.refresh.dispose();
  assert.equal(t.clock.pending(), 0);
  assert.equal(t.refresh.report.active, false);
  await t.clock.run();
  assert.equal(t.state.calls.store, 0);
});

test('dispose aborts an in-flight capture and settles drain', async () => {
  let aborted = false;
  const t = make({
    follow: async function* (request, signal) {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
      yield frame();
    },
  });
  t.refresh.noteActivity('session-a');
  await t.clock.fireNext();
  await waitFor(() => t.refresh.report.inFlight === 'session-a');
  t.refresh.dispose();
  assert.equal(aborted, true);
  await t.refresh.drain();
  assert.equal(t.state.calls.store, 0);
  assert.equal(t.refresh.report.active, false);
});

test('aborts an in-flight capture when the session is disposed', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signalSeen = null;
  const t = make({
    follow: async function* (request, signal) {
      signalSeen = signal;
      await gate;
      yield frame();
    },
  });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.fireNext();
    await waitFor(() => t.refresh.report.inFlight === 'session-a');

    t.refresh.noteDisposed('session-a');
    assert.equal(signalSeen.aborted, true, 'the disposed build signal is aborted before the map entry is dropped');
    release();
    await waitFor(() => t.refresh.report.inFlight === null);

    assert.equal(t.state.calls.store, 0, 'a disposed build never publishes');
    assert.equal(t.refresh.report.built, 0);
    assert.equal(t.refresh.report.aborted, 1);
    assert.equal(t.refresh.report.queued, 0);
  } finally {
    if (release) release();
    t.refresh.dispose();
  }
});

test('forgetting a disposed session lets a re-created one build again', async () => {
  const t = make();
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.state.calls.store, 1);

    t.refresh.noteDisposed('session-a');
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    assert.equal(t.state.calls.store, 2);
    assert.equal(t.refresh.report.skippedSameRevision, 0);
  } finally {
    t.refresh.dispose();
  }
});

test('drain resolves once the queue is empty', async () => {
  const t = make();
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.run();
    await t.refresh.drain();
    assert.equal(t.refresh.report.queued, 0);
    assert.equal(t.refresh.report.inFlight, null);
    assert.equal(t.refresh.report.pending, 0);
  } finally {
    t.refresh.dispose();
  }
});

test('exposes a stable refresh version and safe timings', () => {
  assert.equal(REFRESH_VERSION, 1);
  assert.equal(Object.isFrozen(REFRESH_DEFAULTS), true);
  assert.ok(REFRESH_DEFAULTS.settleMs >= 200, 'covers the writer batch drain');
  assert.ok(REFRESH_DEFAULTS.idleMs > REFRESH_DEFAULTS.settleMs);
});


test('a timed-out opening releases the in-flight slot when return never settles', async () => {
  let follows = 0;
  const t = make({
    timings: { buildTimeoutMs: 20 },
    follow: async () => {
      follows += 1;
      if (follows === 1) {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise(() => {}),
              return: () => new Promise(() => {}),
            };
          },
        };
      }
      return (async function* () {
        yield frame();
      })();
    },
  });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.fireNext(); // idle timer: the first build starts
    t.refresh.noteActivity('session-b');
    await t.clock.run();

    assert.equal(t.refresh.report.failed, 1, 'the timeout is still counted as a failure');
    assert.equal(t.refresh.report.inFlight, null, 'the global build slot was released');
    assert.equal(follows, 2, 'the queued Session still got its build');
    assert.equal(t.state.stored.length, 1);
    assert.equal(t.state.stored[0].sessionId, 'session-b');
  } finally {
    t.refresh.dispose();
  }
});

test('re-checks Agent status after the settle wait', async () => {
  const t = make({ timings: { settleMs: 10 } });
  try {
    t.refresh.noteActivity('session-a');
    await t.clock.fireNext(); // idle timer: the build enters the settle wait
    await waitFor(() => t.refresh.report.inFlight === 'session-a');
    t.refresh.noteAgentStatus('session-a', 'running');
    await t.clock.run(6);

    assert.equal(t.follows.length, 0, 'a Session that started running during the wait is not followed');
    assert.ok(t.refresh.report.skippedRunning >= 1);
  } finally {
    t.refresh.dispose();
  }
});
