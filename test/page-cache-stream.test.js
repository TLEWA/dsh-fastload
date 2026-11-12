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
