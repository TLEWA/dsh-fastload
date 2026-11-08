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

function makeContext() {
  const calls = [];
  const sc = {
    calls,
    async *follow(request) {
      calls.push(request);
      yield snapshot();
    },
  };
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['sessionController']);
      callback({ get: (name) => (name === 'sessionController' ? sc : undefined) });
    },
    logger: { info() {} },
  };
  return { ctx, sc };
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
