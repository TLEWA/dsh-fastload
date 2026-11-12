import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveBuildDefer, DEFER_DEFAULTS } from '../src/defer-live-build.js';
import { wrapPageCache } from '../index.js';

const event = (seq) => ({ type: 'assistant/message', seq, data: {} });
const record = (seq) => ({ event: event(seq) });
const snapshot = (records, cursor, revision = 0) => ({
  type: 'snapshot',
  cursor,
  records: records.map(record),
  hasMore: true,
  projections: {},
  assistantStream: { revision },
});

function fakeCache(opening) {
  return {
    lookup: async () => ({ hit: true, opening, key: 'key', revision: 1 }),
    evict() {},
    store() {},
  };
}

const state = () => ({ pageCacheHits: 0, pageCacheDropped: 0 });

/**
 * Deterministic clock for the module's timer seam. `tick` advances time and
 * runs everything due, then drains microtasks so the wait loop can continue.
 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const queue = new Map();
  const schedule = (kind, fn, delay) => {
    seq += 1;
    queue.set(seq, { kind, fn, at: now + (Number.isFinite(delay) ? delay : 0) });
    return seq;
  };
  const timers = {
    setTimeout: (fn, delay) => schedule('timeout', fn, delay),
    clearTimeout: (handle) => queue.delete(handle),
    setImmediate: (fn) => schedule('immediate', fn, 0),
    clearImmediate: (handle) => queue.delete(handle),
  };
  return {
    timers,
    now: () => now,
    pending: () => queue.size,
    async tick(delta = 1) {
      now += delta;
      const due = [...queue.entries()]
        .filter(([, item]) => item.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [handle, item] of due) {
        if (!queue.has(handle)) continue;
        queue.delete(handle);
        item.fn();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function settle(promise, clock, ticks = 40) {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      throw error;
    }
  );
  for (let index = 0; index < ticks && !settled; index += 1) {
    if (clock.pending() === 0) break;
    await clock.tick(1);
  }
  return tracked;
}

function gateOptions(clock, extra = {}) {
  return {
    timers: clock.timers,
    now: clock.now,
    statusOf: () => 'idle',
    budgetMs: 6,
    maxSlices: 8,
    ...extra,
  };
}

const follow = (extra = {}) => ({ activate: false, ...extra });

test('the default budget stays small and the slice cap bounds a starved loop', () => {
  assert.ok(DEFER_DEFAULTS.budgetMs > 0 && DEFER_DEFAULTS.budgetMs <= 32);
  assert.ok(Number.isInteger(DEFER_DEFAULTS.maxSlices) && DEFER_DEFAULTS.maxSlices > 0);
});

test('yields a few macrotasks within the budget, then reports the wait', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock));
  const result = await settle(gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) }), clock);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'budget');
  assert.ok(result.waitedMs >= 6 && result.waitedMs <= 8, 'waited ' + result.waitedMs);
  assert.ok(result.slices >= 5 && result.slices <= 8, 'slices ' + result.slices);
  assert.equal(gate.report().deferrals, 1);
});

test('never yields for an activating request', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock));
  const result = await gate.wait({ sessionId: 's1', request: follow({ activate: true }), cached: snapshot([1], 1) });
  assert.equal(result.deferred, false);
  assert.equal(result.reason, 'activate');
  assert.equal(clock.pending(), 0);
});

test('never yields for a paged request', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock));
  for (const extra of [{ beforeSeq: 10 }, { throughSeq: 10 }]) {
    const result = await gate.wait({ sessionId: 's1', request: follow(extra), cached: snapshot([1], 1) });
    assert.equal(result.deferred, false);
    assert.equal(result.reason, 'page-window');
  }
  assert.equal(clock.pending(), 0);
});

test('treats an unknown Agent status as a reason not to yield', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock, { statusOf: () => 'unknown' }));
  const result = await gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) });
  assert.equal(result.deferred, false);
  assert.equal(result.reason, 'agent-unknown');
  assert.equal(gate.report().skipped, 1);
  assert.equal(clock.pending(), 0);
});

test('treats a busy Agent and a throwing status reader as no-yield', async () => {
  const clock = fakeClock();
  const busy = createLiveBuildDefer(gateOptions(clock, { statusOf: () => 'running' }));
  const busyResult = await busy.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) });
  assert.equal(busyResult.deferred, false);
  assert.equal(busyResult.reason, 'agent-running');

  const broken = createLiveBuildDefer(gateOptions(clock, { statusOf: () => { throw new Error('no agent service'); } }));
  const brokenResult = await broken.wait({ sessionId: 's2', request: follow(), cached: snapshot([1], 1) });
  assert.equal(brokenResult.deferred, false);
  assert.equal(brokenResult.reason, 'agent-unknown');
  assert.equal(clock.pending(), 0);
});

test('does not yield while the cached page carries an open assistant stream', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock));
  const open = { ...snapshot([1], 1), assistantStream: { revision: 3, activeAttempt: { attemptId: 'a' } } };
  const result = await gate.wait({ sessionId: 's1', request: follow(), cached: open });
  assert.equal(result.deferred, false);
  assert.equal(result.reason, 'stream-active');
  assert.equal(clock.pending(), 0);
});

test('a new request for the same session cancels the pending yield', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock, { budgetMs: 500 }));
  const promise = gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) });
  assert.equal(clock.pending(), 1);
  gate.arrive('s1');
  const result = await settle(promise, clock);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'superseded');
  assert.ok(result.waitedMs <= 1, 'waited ' + result.waitedMs);
  assert.equal(clock.pending(), 0);
  assert.equal(gate.report().canceled, 1);
});

test('an aborted signal cancels the yield and stops listening', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock, { budgetMs: 500 }));
  const controller = new AbortController();
  const promise = gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1), signal: controller.signal });
  assert.equal(clock.pending(), 1);
  controller.abort();
  const result = await settle(promise, clock);
  assert.equal(result.reason, 'aborted');
  assert.equal(clock.pending(), 0);
});

test('a session that becomes busy during the wait stops yielding', async () => {
  const clock = fakeClock();
  let calls = 0;
  const gate = createLiveBuildDefer(gateOptions(clock, {
    budgetMs: 500,
    statusOf: () => {
      calls += 1;
      return calls <= 2 ? 'idle' : 'running';
    },
  }));
  const result = await settle(gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) }), clock);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'agent-running');
  // One slice ran, then the status flipped before the next one.
  assert.equal(result.slices, 1);
  assert.equal(clock.pending(), 0);
});

test('dispose resolves pending waits and refuses later ones', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock, { budgetMs: 500 }));
  const promise = gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) });
  gate.dispose();
  const pendingResult = await settle(promise, clock);
  assert.equal(pendingResult.reason, 'disposed');
  assert.equal(clock.pending(), 0);
  const after = await gate.wait({ sessionId: 's2', request: follow(), cached: snapshot([1], 1) });
  assert.equal(after.deferred, false);
  assert.equal(after.reason, 'disposed');
});

test('a zero budget turns the yield off', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer(gateOptions(clock, { budgetMs: 0 }));
  const result = await gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) });
  assert.equal(result.deferred, false);
  assert.equal(result.reason, 'off');
  assert.equal(clock.pending(), 0);
});

test('a throwing timer seam stays bounded and never rejects', async () => {
  const clock = fakeClock();
  const gate = createLiveBuildDefer({
    timers: {
      setTimeout() { throw new Error('no timers'); },
      clearTimeout() {},
      setImmediate() { throw new Error('no immediates'); },
      clearImmediate() {},
    },
    now: clock.now,
    statusOf: () => 'idle',
    budgetMs: 16,
    maxSlices: 4,
  });
  const result = await gate.wait({ sessionId: 's1', request: follow(), cached: snapshot([1], 1) });
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'budget');
  assert.equal(result.slices, 4);
});

// --- wrapper integration -------------------------------------------------

test('a deferred wrapper starts the live build only after the yield resolved', async () => {
  const steps = [];
  const defer = {
    arrive() {},
    async wait() {
      steps.push('wait');
      await new Promise((resolve) => setImmediate(resolve));
      steps.push('wait-done');
      return { deferred: true, reason: 'budget', waitedMs: 1, slices: 1 };
    },
  };
  async function* live() {
    steps.push('live');
    yield snapshot([3], 3);
  }
  const result = wrapPageCache(live(), {
    cache: fakeCache(snapshot([1, 2], 2)),
    sessionId: 's',
    variant: 'v',
    config: {},
    state: state(),
    defer,
  });
  const items = [];
  for await (const item of result) items.push(item);
  assert.deepEqual(steps, ['wait', 'wait-done', 'live']);
  assert.deepEqual(items.map((item) => item.type), ['snapshot', 'event']);
  assert.equal(items[1].event.seq, 3);
});

test('a refused yield keeps the plain path and still replays the delta', async () => {
  const steps = [];
  const defer = {
    arrive() {},
    async wait() {
      steps.push('wait');
      return { deferred: false, reason: 'activate', waitedMs: 0, slices: 0 };
    },
  };
  async function* live() {
    steps.push('live');
    yield snapshot([3], 3);
  }
  const items = [];
  const result = wrapPageCache(live(), {
    cache: fakeCache(snapshot([1, 2], 2)),
    sessionId: 's',
    variant: 'v',
    config: {},
    state: state(),
    defer,
  });
  for await (const item of result) items.push(item);
  assert.deepEqual(steps, ['wait', 'live']);
  assert.deepEqual(items.map((item) => item.type), ['snapshot', 'event']);
});

test('a throwing deferral falls back to the original ordering instead of failing', async () => {
  const defer = {
    arrive() {},
    async wait() {
      throw new Error('boom');
    },
  };
  async function* live() {
    yield snapshot([3], 3);
  }
  const items = [];
  const result = wrapPageCache(live(), {
    cache: fakeCache(snapshot([1, 2], 2)),
    sessionId: 's',
    variant: 'v',
    config: {},
    state: state(),
    defer,
  });
  for await (const item of result) items.push(item);
  assert.deepEqual(items.map((item) => item.type), ['snapshot', 'event']);
});

test('without a defer seam the cached page is still served first', async () => {
  async function* live() {
    yield snapshot([3], 3);
  }
  const items = [];
  const result = wrapPageCache(live(), {
    cache: fakeCache(snapshot([1, 2], 2)),
    sessionId: 's',
    variant: 'v',
    config: {},
    state: state(),
  });
  for await (const item of result) items.push(item);
  assert.deepEqual(items.map((item) => item.type), ['snapshot', 'event']);
});
