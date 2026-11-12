import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';

function rec(seq, type, extra = {}) {
  return { type: 'event', event: { seq, type, ...extra } };
}

function snapshot(turnCount = 4, textSize = 4000) {
  const records = [];
  let seq = 1;
  for (let turn = 0; turn < turnCount; turn += 1) {
    records.push(rec(seq++, 'turn/start', { turnId: 'turn-' + turn }));
    records.push(rec(seq++, 'user/message', { message: { content: 'user ' + turn } }));
    records.push(
      rec(seq++, 'assistant/message', {
        message: { content: 'a'.repeat(textSize) },
        sourceEventSeqs: [seq - 1],
      })
    );
  }
  return { type: 'snapshot', records, hasMore: true };
}

// The variant a real client open resolves to after the wrapper normalises it.
const CANONICAL_VARIANT = JSON.stringify([100, 40, 2, true, 0, 8 * 1024 * 1024, 2, true]);

function makeContext(options = {}) {
  const calls = [];
  const disposers = [];
  const listeners = new Map();
  const registrations = [];
  const follow = async function* (request) {
    calls.push(request);
    yield snapshot();
  };
  const sc = options.inherit ? Object.create({ follow }) : { follow };
  sc.calls = calls;
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['sessionController']);
      callback({ get: (name) => (name === 'sessionController' ? sc : options.services && options.services[name]) });
    },
    effect(execute) {
      const dispose = execute();
      disposers.push(dispose);
      return dispose;
    },
    on(name, listener, listenOptions) {
      if (options.onThrows) throw new Error(options.onThrows);
      const entry = { name, listener, options: listenOptions };
      registrations.push(entry);
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(entry);
      return () => {
        listeners.get(name)?.delete(entry);
        const index = registrations.indexOf(entry);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    logger: { info() {} },
  };
  return {
    ctx,
    sc,
    calls,
    registrations,
    emit(name, ...args) {
      for (const entry of [...(listeners.get(name) || [])]) entry.listener(...args);
    },
    listenerCount(name) {
      return listeners.get(name)?.size || 0;
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
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

// Page-cache writes are zstd-compressed off the main path, so a teardown that
// removes the cache directory immediately after `dispose()` can race the last
// write (ENOTEMPTY on Windows). Retry the removal briefly instead of failing.
async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await fsp.rm(dir, { recursive: true, force: true });
}

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('rewrites the initial follow request and is idempotent', async () => {
  await withEnv(
    {
      DSH_FASTLOAD_ENABLED: '1',
      DSH_FASTLOAD_MAX_BYTES: '0',
      DSH_FASTLOAD_FORCE: '0',
    },
    async () => {
      const { ctx, sc } = makeContext();
      apply(ctx);
      apply(ctx);
      assert.equal(sc.__dshFastload, true);

      const frame = await sc.follow({ maxMessages: 500 }).next();
      assert.equal(sc.calls.length, 1);
      assert.equal(sc.calls[0].maxMessages, 100);
      assert.deepEqual(sc.calls[0].turnWindow, { minMessages: 40, minTurns: 2 });
      assert.equal(frame.value.type, 'snapshot');
    }
  );
});

test('does not touch load-older, jump, or explicit small pages', async () => {
  await withEnv(
    {
      DSH_FASTLOAD_ENABLED: '1',
      DSH_FASTLOAD_MAX_BYTES: '0',
      DSH_FASTLOAD_FORCE: '0',
    },
    async () => {
      const { ctx, sc } = makeContext();
      apply(ctx);

      await sc.follow({ maxMessages: 500, beforeSeq: 42 }).next();
      await sc.follow({ maxMessages: 500, throughSeq: 42 }).next();
      await sc.follow({ maxMessages: 100 }).next();

      assert.equal(sc.calls[0].maxMessages, 500);
      assert.equal(sc.calls[0].turnWindow, undefined);
      assert.equal(sc.calls[1].maxMessages, 500);
      assert.equal(sc.calls[1].turnWindow, undefined);
      assert.equal(sc.calls[2].maxMessages, 100);
      assert.equal(sc.calls[2].turnWindow, undefined);
    }
  );
});

test('byte trim runs on the first snapshot only', async () => {
  await withEnv(
    {
      DSH_FASTLOAD_ENABLED: '1',
      DSH_FASTLOAD_MAX_BYTES: '70000',
      DSH_FASTLOAD_MIN_TURNS: '2',
      DSH_FASTLOAD_DEBUG: '0',
    },
    async () => {
      const { ctx, sc } = makeContext();
      sc.follow = async function* (request) {
        this.calls.push(request);
        yield snapshot(4, 30000);
      };
      apply(ctx);

      const frame = await sc.follow({ maxMessages: 500 }).next();
      assert.equal(frame.value.records.filter((r) => r.event.type === 'turn/start').length, 2);
      assert.equal(frame.value.hasMore, true);
      assert.ok(globalThis.__DSH_FASTLOAD__.trims >= 1);
      assert.ok(globalThis.__DSH_FASTLOAD__.lastTrim.afterBytes < globalThis.__DSH_FASTLOAD__.lastTrim.beforeBytes);
    }
  );
});

test('disabled plugin leaves follow untouched', async () => {
  await withEnv(
    {
      DSH_FASTLOAD_ENABLED: '0',
      DSH_FASTLOAD_MAX_BYTES: '0',
    },
    async () => {
      const { ctx, sc } = makeContext();
      apply(ctx);
      assert.notEqual(sc.__dshFastload, true);
      await sc.follow({ maxMessages: 500 }).next();
      assert.equal(sc.calls[0].maxMessages, 500);
    }
  );
});

test('dispose restores an inherited follow and clears the marker', async () => {
  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0' }, async () => {
    const { ctx, sc, dispose } = makeContext({ inherit: true });
    const inherited = Object.getPrototypeOf(sc).follow;
    apply(ctx);
    assert.equal(Object.hasOwn(sc, 'follow'), true);
    assert.notEqual(sc.follow, inherited);
    assert.equal(sc.__dshFastload, true);

    dispose();

    assert.equal(Object.hasOwn(sc, 'follow'), false);
    assert.equal(sc.follow, inherited);
    assert.equal(sc.__dshFastload, undefined);
  });
});

test('dispose lets later initial pages through untouched', async () => {
  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0' }, async () => {
    const { ctx, sc, calls, dispose } = makeContext();
    apply(ctx);
    dispose();

    await sc.follow({ maxMessages: 500 }).next();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxMessages, 500);
    assert.equal(calls[0].turnWindow, undefined);
  });
});

test('re-enabling after dispose installs one wrapper with the new config', async () => {
  const { ctx, sc, calls, dispose } = makeContext();
  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0', DSH_FASTLOAD_MAX_MESSAGES: '100' }, async () => {
    apply(ctx);
  });
  const first = sc.follow;
  dispose();

  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0', DSH_FASTLOAD_MAX_MESSAGES: '200' }, async () => {
    apply(ctx);
  });

  assert.notEqual(sc.follow, first);
  await sc.follow({ maxMessages: 500 }).next();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxMessages, 200);
  assert.equal(calls[0].turnWindow.minTurns, 2);
});

test('state is reused across a dispose and reinstall', async () => {
  const { ctx, dispose } = makeContext();
  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0' }, async () => {
    apply(ctx);
    const state = globalThis.__DSH_FASTLOAD__;
    dispose();
    apply(ctx);
    assert.equal(globalThis.__DSH_FASTLOAD__, state);
    assert.equal(state.installed, true);
  });
});

test('repeated apply keeps a single wrapper', async () => {
  const { ctx, sc, calls } = makeContext();
  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0' }, async () => {
    apply(ctx);
    const wrapper = sc.follow;
    apply(ctx);
    assert.equal(sc.follow, wrapper);
    await sc.follow({ maxMessages: 500 }).next();
    assert.equal(calls.length, 1);
  });
});

test('restores through cordis.original behind a traceable proxy', async () => {
  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0' }, async () => {
    const calls = [];
    const target = {
      async *follow(request) {
        calls.push(request);
        yield snapshot();
      },
    };
    const original = target.follow;
    const asShadow = (method) =>
      function (...args) {
        return method.apply(target, args);
      };
    const sc = new Proxy(target, {
      get(object, prop) {
        if (prop === Symbol.for('cordis.original')) return object;
        if (prop === 'follow') return asShadow(object.follow);
        return Reflect.get(object, prop);
      },
      set(object, prop, value) {
        return Reflect.set(object, prop, value, object);
      },
    });
    const disposers = [];
    const ctx = {
      inject(names, callback) {
        assert.deepEqual(names, ['sessionController']);
        callback({ get: () => sc });
      },
      effect(execute) {
        const dispose = execute();
        disposers.push(dispose);
        return dispose;
      },
      logger: { info() {} },
    };

    apply(ctx);
    assert.equal(target.__dshFastload, true);
    assert.notEqual(target.follow, original);
    // A public read goes through the proxy shadow and never compares equal to
    // the installed function, so restores must use the real target.
    assert.notEqual(sc.follow, target.follow);

    for (const dispose of disposers.reverse()) dispose();
    assert.equal(target.follow, original);
    assert.equal(target.__dshFastload, undefined);

    await sc.follow({ maxMessages: 500 }).next();
    assert.equal(calls[0].maxMessages, 500);
  });
});


test('a wrapper another plugin holds is switched off instead of stacking', async () => {
  const { ctx, sc, calls, dispose } = makeContext();
  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0', DSH_FASTLOAD_MAX_MESSAGES: '100' }, async () => {
    apply(ctx);
  });

  // A plugin installed later wraps our function and keeps calling it, so the
  // teardown below cannot restore target.follow. The leftover wrapper must not
  // keep rewriting pages with the old maxMessages after the next install.
  const ours = sc.follow;
  sc.follow = async function* (request) {
    yield* ours.call(sc, request);
  };
  dispose();

  await withEnv({ DSH_FASTLOAD_ENABLED: '1', DSH_FASTLOAD_MAX_BYTES: '0', DSH_FASTLOAD_MAX_MESSAGES: '200' }, async () => {
    apply(ctx);
  });

  await sc.follow({ maxMessages: 500 }).next();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxMessages, 200, 'the re-enabled wrapper applies the new page size');
  assert.equal(calls[0].turnWindow.minTurns, 2);
});

test('strips replay streams from the opening frame only', async () => {
  await withEnv(
    {
      DSH_FASTLOAD_ENABLED: '1',
      DSH_FASTLOAD_MAX_BYTES: '0',
      DSH_FASTLOAD_FORCE: '0',
      DSH_FASTLOAD_PAGE_CACHE: '0',
      DSH_FASTLOAD_STRIP_STREAM: '1',
    },
    async () => {
      const { ctx, sc } = makeContext();
      const chunks = [{ type: 'chunk', chunk: { type: 'text-delta', text: 'x'.repeat(400) } }];
      const page = {
        type: 'snapshot',
        cursor: 2,
        hasMore: true,
        records: [
          rec(1, 'user/message', { message: { content: 'hi' } }),
          { type: 'event', event: { seq: 2, type: 'assistant/message', data: { message: { content: 'ok' }, stream: chunks, usage: { outputTokens: 1 } } } },
        ],
      };
      sc.follow = async function* () {
        yield page;
        yield { type: 'event', event: { seq: 3, type: 'assistant/message', data: { stream: chunks } } };
      };
      apply(ctx);

      const stream = sc.follow({ maxMessages: 500 });
      const first = await stream.next();
      assert.deepEqual(first.value.records[1].event.data.stream, []);
      assert.deepEqual(first.value.records[1].event.data.usage, { outputTokens: 1 });
      assert.equal(page.records[1].event.data.stream.length, 1);

      const second = await stream.next();
      assert.equal(second.value.event.data.stream.length, 1);
    }
  );
});

test('serves a cached opening and swallows the duplicate live opening', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-plugin-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  const env = {
    DSH_FASTLOAD_ENABLED: '1',
    DSH_FASTLOAD_MAX_BYTES: '0',
    DSH_FASTLOAD_FORCE: '0',
    DSH_FASTLOAD_PAGE_CACHE: '1',
    DSH_FASTLOAD_DEBUG: '0',
    DSH_FASTLOAD_CACHE_DIR: dir,
  };
  const page = () => ({
    type: 'snapshot',
    cursor: 3,
    hasMore: true,
    assistantStream: { revision: 0 },
    records: [rec(1, 'turn/start'), rec(2, 'user/message', { message: { content: 'q' } }), rec(3, 'assistant/message', { message: { content: 'a' } })],
  });

  try {
    await withEnv(env, async () => {
      const first = makeContext({ services: { sessionPersistence: persistence } });
      first.sc.follow = async function* (request) {
        this.calls.push(request);
        yield page();
      };
      apply(first.ctx);
      const stream = first.sc.follow({ maxMessages: 500, address: { kind: 'session', sessionId: 'session-test' } });
      await stream.next();
      const cache = globalThis.__DSH_FASTLOAD__.pageCache;
      assert.equal(cache.enabled, true);
      await cache.flush();
      assert.ok(cache.stats.writes >= 1);
      first.dispose();

      const second = makeContext({ services: { sessionPersistence: persistence } });
      let builds = 0;
      second.sc.follow = async function* (request) {
        builds += 1;
        this.calls.push(request);
        yield page();
      };
      apply(second.ctx);
      const replay = second.sc.follow({ maxMessages: 500, address: { kind: 'session', sessionId: 'session-test' } });
      const cached = await replay.next();
      assert.equal(cached.value.type, 'snapshot');
      assert.deepEqual(cached.value.records, page().records);
      const after = await replay.next();
      assert.equal(after.done, true);
      assert.equal(builds, 1);
      assert.equal(globalThis.__DSH_FASTLOAD__.pageCacheHits >= 1, true);
      second.dispose();
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('replays events appended after the cached cursor', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-plugin-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  const env = {
    DSH_FASTLOAD_ENABLED: '1',
    DSH_FASTLOAD_MAX_BYTES: '0',
    DSH_FASTLOAD_FORCE: '0',
    DSH_FASTLOAD_PAGE_CACHE: '1',
    DSH_FASTLOAD_DEBUG: '0',
    DSH_FASTLOAD_CACHE_DIR: dir,
  };
  const base = { type: 'snapshot', cursor: 2, hasMore: true, assistantStream: { revision: 0 }, records: [rec(1, 'turn/start'), rec(2, 'user/message')] };
  try {
    await withEnv(env, async () => {
      const first = makeContext({ services: { sessionPersistence: persistence } });
      first.sc.follow = async function* () { yield base; };
      apply(first.ctx);
      await first.sc.follow({ maxMessages: 500, address: { kind: 'session', sessionId: 'session-test' } }).next();
      await globalThis.__DSH_FASTLOAD__.pageCache.flush();
      first.dispose();

      const second = makeContext({ services: { sessionPersistence: persistence } });
      second.sc.follow = async function* () {
        yield { ...base, cursor: 3, records: [...base.records, rec(3, 'assistant/message')] };
      };
      apply(second.ctx);
      const stream = second.sc.follow({ maxMessages: 500, address: { kind: 'session', sessionId: 'session-test' } });
      const firstFrame = await stream.next();
      assert.equal(firstFrame.value.cursor, 2);
      const replay = await stream.next();
      assert.equal(replay.value.type, 'event');
      assert.equal(replay.value.event.seq, 3);
      second.dispose();
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('keeps idle refresh off by default and registers no listeners', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-idle-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  try {
    await withEnv(
      {
        DSH_FASTLOAD_ENABLED: '1',
        DSH_FASTLOAD_PAGE_CACHE: '1',
        DSH_FASTLOAD_IDLE_CACHE_REFRESH: '0',
        DSH_FASTLOAD_CACHE_DIR: dir,
      },
      async () => {
        const t = makeContext({ services: { sessionPersistence: persistence } });
        apply(t.ctx);
        assert.equal(t.listenerCount('session/event'), 0);
        assert.equal(t.listenerCount('agent/status'), 0);
        assert.equal(t.listenerCount('session/disposed'), 0);
        assert.equal(globalThis.__DSH_FASTLOAD__.idleRefresh, null);
        t.dispose();
      }
    );
  } finally {
    await cleanupDir(dir);
  }
});

test('idle refresh warms the canonical page and never activates the Agent', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-idle-'));
  const persistence = { stat: async () => ({ revision: 'rev-idle' }), open: async () => ({}) };
  const page = {
    type: 'snapshot',
    cursor: 3,
    hasMore: true,
    assistantStream: { revision: 0 },
    records: [
      rec(1, 'turn/start'),
      rec(2, 'user/message', { message: { content: 'q' } }),
      rec(3, 'assistant/message', { message: { content: 'a' } }),
    ],
  };
  try {
    await withEnv(
      {
        DSH_FASTLOAD_ENABLED: '1',
        DSH_FASTLOAD_MAX_BYTES: '0',
        DSH_FASTLOAD_PAGE_CACHE: '1',
        DSH_FASTLOAD_IDLE_CACHE_REFRESH: '1',
        DSH_FASTLOAD_CACHE_DIR: dir,
      },
      async () => {
        const t = makeContext({ services: { sessionPersistence: persistence } });
        t.sc.follow = async function* (request) {
          this.calls.push(request);
          yield page;
        };
        apply(t.ctx, {
          refresh: {
            timings: { idleMs: 5, settleMs: 0, minGapMs: 0, busyRetryMs: 5, buildTimeoutMs: 5000 },
            probeLoad: async () => 0,
          },
        });
        const state = globalThis.__DSH_FASTLOAD__;
        assert.equal(state.idleRefresh && state.idleRefresh.active, true);
        assert.equal(t.listenerCount('session/event'), 1);
        assert.equal(t.listenerCount('agent/status'), 1);
        assert.equal(t.listenerCount('session/disposed'), 1);
        assert.equal(t.registrations.every((entry) => entry.options && entry.options.global === true), true);

        const hitsBefore = state.pageCacheHits;
        t.emit('session/event', { id: 'session-idle' });
        await waitFor(() => state.pageCache && state.pageCache.stats.writes >= 1);
        await state.pageCache.flush();

        const probe = await state.pageCache.lookup('session-idle', CANONICAL_VARIANT);
        assert.equal(probe.hit, true);
        assert.deepEqual(probe.opening.records, page.records);
        assert.equal(state.pageCacheHits, hitsBefore, 'a refresh is not a client hit');
        assert.equal(state.idleRefresh.stored >= 1, true);

        const refreshCall = t.calls[t.calls.length - 1];
        assert.equal(refreshCall.activate, false, 'a refresh must never activate an Agent');
        assert.deepEqual(refreshCall.address, { kind: 'session', sessionId: 'session-idle' });
        assert.equal(refreshCall.assistantStream, true);
        assert.equal(refreshCall.maxMessages, 100);

        t.dispose();
        assert.equal(t.listenerCount('session/event'), 0);
        assert.equal(t.listenerCount('agent/status'), 0);
        assert.equal(t.listenerCount('session/disposed'), 0);
        assert.equal(state.installed, false);
        assert.equal(t.sc.__dshFastload, undefined);
      }
    );
  } finally {
    await cleanupDir(dir);
  }
});

test('leaves follow working when the Host cannot register event listeners', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-idle-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  try {
    await withEnv(
      {
        DSH_FASTLOAD_ENABLED: '1',
        DSH_FASTLOAD_PAGE_CACHE: '1',
        DSH_FASTLOAD_IDLE_CACHE_REFRESH: '1',
        DSH_FASTLOAD_CACHE_DIR: dir,
      },
      async () => {
        const t = makeContext({ services: { sessionPersistence: persistence }, onThrows: 'no event bus' });
        apply(t.ctx);
        const state = globalThis.__DSH_FASTLOAD__;
        assert.equal(state.idleRefresh.active, false);
        assert.match(state.idleRefresh.disabledReason, /no event bus/);
        assert.equal(t.listenerCount('session/event'), 0);

        const stream = t.sc.follow({ maxMessages: 500, address: { kind: 'session', sessionId: 's-1' } });
        const first = await stream.next();
        assert.equal(first.value.type, 'snapshot');
        assert.equal(t.calls.length, 1);
        t.dispose();
      }
    );
  } finally {
    await cleanupDir(dir);
  }
});

test('re-applying with idle refresh keeps a single refresher', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-idle-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  try {
    await withEnv(
      {
        DSH_FASTLOAD_ENABLED: '1',
        DSH_FASTLOAD_PAGE_CACHE: '1',
        DSH_FASTLOAD_IDLE_CACHE_REFRESH: '1',
        DSH_FASTLOAD_CACHE_DIR: dir,
      },
      async () => {
        const t = makeContext({ services: { sessionPersistence: persistence } });
        apply(t.ctx);
        assert.equal(t.listenerCount('session/event'), 1);
        const report = globalThis.__DSH_FASTLOAD__.idleRefresh;
        apply(t.ctx);
        assert.equal(t.listenerCount('session/event'), 1);
        assert.equal(globalThis.__DSH_FASTLOAD__.idleRefresh, report);
        t.dispose();
        assert.equal(t.listenerCount('session/event'), 0);
      }
    );
  } finally {
    await cleanupDir(dir);
  }
});

test('re-applying with deferred live build keeps one gate and its counters', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-defer-'));
  try {
    await withEnv(
      {
        DSH_FASTLOAD_ENABLED: '1',
        DSH_FASTLOAD_PAGE_CACHE: '1',
        DSH_FASTLOAD_DEFER_LIVE_BUILD: '1',
        DSH_FASTLOAD_CACHE_DIR: dir,
      },
      async () => {
        const t = makeContext();
        const options = { defer: { statusOf: () => 'idle' } };
        apply(t.ctx, options);
        const state = globalThis.__DSH_FASTLOAD__;
        assert.ok(state.deferLiveBuild);
        assert.equal(t.sc.__dshFastload, true);
        const report = state.deferLiveBuild;
        apply(t.ctx, options);
        assert.equal(t.sc.__dshFastload, true);
        assert.equal(state.deferLiveBuild, report, 're-apply must not detach the live counters');
        t.dispose();
        assert.equal(state.installed, false);
        assert.equal(t.sc.__dshFastload, undefined);
      }
    );
  } finally {
    await cleanupDir(dir);
  }
});

const cachedPage = () => ({
  type: 'snapshot',
  cursor: 3,
  hasMore: true,
  assistantStream: { revision: 0 },
  records: [rec(1, 'turn/start'), rec(2, 'user/message', { message: { content: 'q' } }), rec(3, 'assistant/message', { message: { content: 'a' } })],
});

async function warmOnePage(dir, persistence, env) {
  return withEnv(env, async () => {
    const t = makeContext({ services: { sessionPersistence: persistence } });
    t.sc.follow = async function* (request) {
      this.calls.push(request);
      yield cachedPage();
    };
    apply(t.ctx);
    const stream = t.sc.follow({ maxMessages: 500, address: { kind: 'session', sessionId: 'session-test' } });
    // Drain the stream so the wrapper observes the live frame, verifies the
    // cursor and stores the page; reading only the first frame never stores.
    for await (const _frame of stream) { /* drain */ }
    await globalThis.__DSH_FASTLOAD__.pageCache.flush();
    t.dispose();
  });
}

test('keeps deferred live build off by default and serves the cache unchanged', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-defer-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  const env = {
    DSH_FASTLOAD_ENABLED: '1',
    DSH_FASTLOAD_MAX_BYTES: '0',
    DSH_FASTLOAD_PAGE_CACHE: '1',
    DSH_FASTLOAD_CACHE_DIR: dir,
  };
  try {
    await warmOnePage(dir, persistence, env);
    await withEnv(env, async () => {
      const t = makeContext({ services: { sessionPersistence: persistence } });
      t.sc.follow = async function* () {
        yield cachedPage();
      };
      apply(t.ctx);
      assert.equal(globalThis.__DSH_FASTLOAD__.deferLiveBuild, null);
      const stream = t.sc.follow({ maxMessages: 500, activate: false, address: { kind: 'session', sessionId: 'session-test' } });
      const first = await stream.next();
      assert.equal(first.value.type, 'snapshot');
      const end = await stream.next();
      assert.equal(end.done, true);
      t.dispose();
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('defers a passive cache hit only when the Agent is known idle', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-defer-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  const env = {
    DSH_FASTLOAD_ENABLED: '1',
    DSH_FASTLOAD_MAX_BYTES: '0',
    DSH_FASTLOAD_PAGE_CACHE: '1',
    DSH_FASTLOAD_CACHE_DIR: dir,
    DSH_FASTLOAD_DEFER_LIVE_BUILD: '1',
  };
  try {
    await warmOnePage(dir, persistence, env);
    await withEnv(env, async () => {
      const t = makeContext({
        services: {
          sessionPersistence: persistence,
          agents: { get: () => ({ status: 'idle' }) },
        },
      });
      t.sc.follow = async function* () {
        yield cachedPage();
      };
      apply(t.ctx, { defer: { budgetMs: 3, maxSlices: 3 } });
      const report = globalThis.__DSH_FASTLOAD__.deferLiveBuild;
      assert.equal(report.enabled, true);
      assert.equal(report.budgetMs, 3);
      const stream = t.sc.follow({ maxMessages: 500, activate: false, address: { kind: 'session', sessionId: 'session-test' } });
      assert.equal((await stream.next()).value.type, 'snapshot');
      assert.equal((await stream.next()).done, true);
      assert.equal(globalThis.__DSH_FASTLOAD__.deferLiveBuild.deferrals, 1);
      t.dispose();
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('never defers an activating or paged follow', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-defer-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  const env = {
    DSH_FASTLOAD_ENABLED: '1',
    DSH_FASTLOAD_MAX_BYTES: '0',
    DSH_FASTLOAD_PAGE_CACHE: '1',
    DSH_FASTLOAD_CACHE_DIR: dir,
    DSH_FASTLOAD_DEFER_LIVE_BUILD: '1',
  };
  try {
    await warmOnePage(dir, persistence, env);
    await withEnv(env, async () => {
      const t = makeContext({
        services: {
          sessionPersistence: persistence,
          agents: { get: () => ({ status: 'idle' }) },
        },
      });
      t.sc.follow = async function* () {
        yield cachedPage();
      };
      apply(t.ctx, { defer: { budgetMs: 3, maxSlices: 3 } });
      const activating = t.sc.follow({ maxMessages: 500, activate: true, address: { kind: 'session', sessionId: 'session-test' } });
      assert.equal((await activating.next()).value.type, 'snapshot');
      assert.equal((await activating.next()).done, true);
      assert.equal(globalThis.__DSH_FASTLOAD__.deferLiveBuild.deferrals, 0);

      const paged = t.sc.follow({ maxMessages: 500, beforeSeq: 10, activate: false, address: { kind: 'session', sessionId: 'session-test' } });
      assert.equal((await paged.next()).value.type, 'snapshot');
      assert.equal(globalThis.__DSH_FASTLOAD__.deferLiveBuild.deferrals, 0);
      t.dispose();
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('disposing the plugin clears a pending deferral', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-defer-'));
  const persistence = { stat: async () => ({ revision: 'rev-1' }), open: async () => ({}) };
  const env = {
    DSH_FASTLOAD_ENABLED: '1',
    DSH_FASTLOAD_MAX_BYTES: '0',
    DSH_FASTLOAD_PAGE_CACHE: '1',
    DSH_FASTLOAD_CACHE_DIR: dir,
    DSH_FASTLOAD_DEFER_LIVE_BUILD: '1',
  };
  try {
    await warmOnePage(dir, persistence, env);
    await withEnv(env, async () => {
      const t = makeContext({
        services: {
          sessionPersistence: persistence,
          agents: { get: () => ({ status: 'idle' }) },
        },
      });
      t.sc.follow = async function* () {
        yield cachedPage();
      };
      apply(t.ctx, { defer: { budgetMs: 500, maxSlices: 4 } });
      const stream = t.sc.follow({ maxMessages: 500, activate: false, address: { kind: 'session', sessionId: 'session-test' } });
      assert.equal((await stream.next()).value.type, 'snapshot');
      // The deferral is pending now; tearing the plugin down must release it.
      const next = stream.next();
      t.dispose();
      const settled = await Promise.race([
        next.then((step) => step.done === true || step.value.type === 'event'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);
      assert.notEqual(settled, 'timeout');
    });
  } finally {
    await cleanupDir(dir);
  }
});

