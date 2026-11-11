import assert from 'node:assert/strict';
import test from 'node:test';

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

function makeContext(options = {}) {
  const calls = [];
  const disposers = [];
  const follow = async function* (request) {
    calls.push(request);
    yield snapshot();
  };
  const sc = options.inherit ? Object.create({ follow }) : { follow };
  sc.calls = calls;
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['sessionController']);
      callback({ get: (name) => (name === 'sessionController' ? sc : undefined) });
    },
    effect(execute) {
      const dispose = execute();
      disposers.push(dispose);
      return dispose;
    },
    logger: { info() {} },
  };
  return {
    ctx,
    sc,
    calls,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
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
