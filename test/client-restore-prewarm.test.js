import assert from 'node:assert/strict';
import test from 'node:test';

function storage(initial) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  };
}

test('does not prewarm when the selection subscription throws', async () => {
  const localStorage = storage({
    'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-1' }),
    'dsh-fastload.restore-prewarm': '1',
  });
  const sessionStorage = storage({});
  let factory = null;
  let followCalls = 0;
  let dispose = null;
  const window = {
    __DSH_FASTLOAD_DEBUG__: false,
    __DSH_FASTLOAD_DIAGNOSTICS__: false,
    __ModuleLoader__: {
      load(definition) {
        factory = definition.factory;
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const service = {
    selection: {
      subscribe() {
        throw new Error('subscribe failed');
      },
      getSnapshot: () => ({ sessionId: null }),
    },
    // A real, readable live reference for another Session: the capability
    // check passes, so this test still reaches the subscription failure it
    // covers.
    mainReference: { sessionId: 'sess-other' },
  };
  const ctx = {
    get(name) {
      return name === 'uiWorkspace' ? service : undefined;
    },
    effect(run) {
      dispose = run();
      return dispose;
    },
    on() {
      return () => {};
    },
    remote: {
      session: {
        follow() {
          followCalls += 1;
          throw new Error('follow must not start');
        },
      },
    },
    logger: { info() {} },
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.sessionStorage = sessionStorage;
  try {
    await import('../client.js?finding-2');
    assert.equal(typeof factory, 'function');
    const mod = factory(() => ({}));
    mod.apply(ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));

    const state = window.__DSH_FASTLOAD_CLIENT__;
    assert.equal(followCalls, 0, 'a failed subscription must not start a follow');
    assert.equal(state.restorePrewarm.stage, 'failed');
    assert.match(state.restorePrewarm.reason, /subscribe failed/);
  } finally {
    try {
      if (typeof dispose === 'function') dispose();
    } catch {}
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});

test('skips restore prewarm when uiWorkspace has no live main reference', async () => {
  const localStorage = storage({
    'dsh.sessions.current': JSON.stringify({ sessionId: 'sess-1' }),
    'dsh-fastload.restore-prewarm': '1',
  });
  const sessionStorage = storage({});
  let factory = null;
  let followCalls = 0;
  let dispose = null;
  const window = {
    __DSH_FASTLOAD_DEBUG__: false,
    __DSH_FASTLOAD_DIAGNOSTICS__: false,
    __ModuleLoader__: {
      load(definition) {
        factory = definition.factory;
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  // The event API is present, but without a live main reference the native
  // restore can never be observed and the selection signal cannot cancel the
  // prewarm, so arming it here would race the real open.
  const service = {
    selection: {
      subscribe() {
        return () => {};
      },
      getSnapshot: () => ({ sessionId: null }),
    },
  };
  const ctx = {
    get(name) {
      return name === 'uiWorkspace' ? service : undefined;
    },
    effect(run) {
      dispose = run();
      return dispose;
    },
    on() {
      return () => {};
    },
    remote: {
      session: {
        follow() {
          followCalls += 1;
          throw new Error('follow must not start');
        },
      },
    },
    logger: { info() {} },
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.sessionStorage = sessionStorage;
  try {
    await import('../client.js?main-reference');
    assert.equal(typeof factory, 'function');
    const mod = factory(() => ({}));
    mod.apply(ctx);
    const started = Date.now();
    while (Date.now() - started < 500) {
      const current = window.__DSH_FASTLOAD_CLIENT__;
      if (current && current.restorePrewarm.stage !== 'waiting') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const state = window.__DSH_FASTLOAD_CLIENT__;
    assert.equal(followCalls, 0, 'a workspace without mainReference must not start a follow');
    assert.equal(state.restorePrewarm.stage, 'skipped');
    assert.equal(state.restorePrewarm.reason, 'main-reference-unavailable');
    assert.equal(state.restorePrewarm.sid, 'sess-1');
  } finally {
    try {
      if (typeof dispose === 'function') dispose();
    } catch {}
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  }
});
