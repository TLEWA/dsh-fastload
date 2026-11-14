import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapPageCache } from '../index.js';

const event = (seq) => ({ type: 'assistant/message', seq, data: {} });
const record = (seq) => ({ event: event(seq) });
const snapshot = (records, cursor, revision) => ({
  type: 'snapshot',
  cursor,
  records: records.map(record),
  hasMore: true,
  projections: {},
  assistantStream: revision === undefined ? undefined : { revision },
});

function fakeCache(opening) {
  const calls = { evicted: [], stored: [] };
  return {
    calls,
    lookup: async () => ({ hit: true, opening, key: 'key', revision: 1 }),
    evict: (key) => calls.evicted.push(key),
    store: (...args) => calls.stored.push(args),
  };
}

async function* liveOnce(frame) {
  yield frame;
}

async function collect(result) {
  const out = [];
  for await (const item of result) out.push(item);
  return out;
}

const state = () => ({ pageCacheHits: 0, pageCacheDropped: 0 });

test('a contiguous delta is replayed as individual events', async () => {
  const cache = fakeCache({ type: 'snapshot', cursor: 2, records: [record(1), record(2)], hasMore: true, assistantStream: { revision: 0 } });
  const result = wrapPageCache(liveOnce(snapshot([3, 4, 5], 5, 0)), {
    cache, sessionId: 's', variant: 'v', config: {}, state: state(),
  });
  const items = await collect(result);
  assert.equal(items.length, 4);
  assert.equal(items[0].type, 'snapshot');
  assert.deepEqual(items.slice(1).map((item) => item.event.seq), [3, 4, 5]);
  assert.deepEqual(cache.calls.evicted, []);
});

test('a hole in the delta fails the stream instead of silently dropping events', async () => {
  const cache = fakeCache({ type: 'snapshot', cursor: 2, records: [record(1), record(2)], hasMore: true, assistantStream: { revision: 0 } });
  const result = wrapPageCache(liveOnce(snapshot([4, 5], 5, 0)), {
    cache, sessionId: 's', variant: 'v', config: {}, state: state(),
  });
  await assert.rejects(collect(result), /page cache is stale/);
  assert.deepEqual(cache.calls.evicted, ['key']);
});

test('a moved assistant baseline fails the stream so the client resyncs', async () => {
  const cache = fakeCache({ type: 'snapshot', cursor: 2, records: [record(1), record(2)], hasMore: true, assistantStream: { revision: 0 } });
  const result = wrapPageCache(liveOnce(snapshot([3, 4, 5], 5, 4)), {
    cache, sessionId: 's', variant: 'v', config: {}, state: state(),
  });
  await assert.rejects(collect(result), /page cache is stale/);
  assert.deepEqual(cache.calls.evicted, ['key']);
});


test('closing after the cached frame stops the debug lag probe', async () => {
  const realSetImmediate = globalThis.setImmediate;
  let scheduled = 0;
  let frozen = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  globalThis.setImmediate = (fn, ...args) => {
    scheduled += 1;
    if (frozen) return realSetImmediate(() => {});
    return realSetImmediate(fn, ...args);
  };
  try {
    const cache = fakeCache({ type: 'snapshot', cursor: 1, records: [record(1)], hasMore: true, assistantStream: { revision: 0 } });
    const stateObj = state();
    const result = wrapPageCache(liveOnce(snapshot([2], 2, 0)), {
      cache, sessionId: 's', variant: 'v', config: { debug: true }, state: stateObj,
    });
    const iterator = result[Symbol.asyncIterator]();
    const cached = await iterator.next();
    assert.equal(cached.done, false);
    assert.equal(cached.value.type, 'snapshot');
    assert.equal(stateObj.pageCacheHits, 1);
    // A client that reads only the cached frame and closes must stop the
    // probe; otherwise the recursive setImmediate loop outlives the stream.
    await iterator.return();

    await sleep(15);
    const settled = scheduled;
    await sleep(25);
    assert.equal(scheduled, settled, 'the stopped probe must not keep scheduling setImmediate turns');
  } finally {
    frozen = true;
    globalThis.setImmediate = realSetImmediate;
  }
});

function cacheMiss() {
  const calls = { stored: [] };
  return {
    calls,
    lookup: async () => ({ hit: false, key: 'key', revision: 1 }),
    evict() {},
    store: (...args) => calls.stored.push(args),
  };
}

test('a growing assistant baseline is never written to the cache', async () => {
  const cache = cacheMiss();
  const frame = {
    type: 'snapshot',
    cursor: 5,
    records: [record(5)],
    hasMore: false,
    assistantStream: { revision: 7, activeAttempt: { attemptId: 'a', nextIndex: 3 } },
  };
  await collect(
    wrapPageCache(liveOnce(frame), { cache, sessionId: 's', variant: 'v', config: {}, state: state() })
  );
  assert.deepEqual(cache.calls.stored, []);
});

test('a settled page is still cached on a miss', async () => {
  const cache = cacheMiss();
  const frame = {
    type: 'snapshot',
    cursor: 5,
    records: [record(5)],
    hasMore: false,
    assistantStream: { revision: 7 },
  };
  await collect(
    wrapPageCache(liveOnce(frame), { cache, sessionId: 's', variant: 'v', config: {}, state: state() })
  );
  assert.equal(cache.calls.stored.length, 1);
  assert.equal(cache.calls.stored[0][0], 's');
});
