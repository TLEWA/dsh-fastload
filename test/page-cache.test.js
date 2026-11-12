import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPageCache } from '../src/page-cache.js';

function fakePersistence(initial = 'rev-1') {
  let revision = initial;
  return {
    stat: async () => ({ revision }),
    open: async () => ({}),
    revise(next) { revision = next; },
  };
}

function page(records = 1, cursor = records) {
  const list = [];
  for (let seq = 1; seq <= records; seq += 1) list.push({ type: 'event', event: { seq, type: 'user/message' } });
  return { type: 'snapshot', cursor, hasMore: true, records: list, assistantStream: { revision: 0 } };
}

async function withCache(fn, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-page-'));
  try {
    const persistence = options.persistence || fakePersistence();
    const cache = createPageCache({ persistence, dir, debug: false, ...options.cache });
    await fn({ cache, persistence, dir });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('round-trips one page for the same session revision', async () => {
  await withCache(async ({ cache }) => {
    const probe = await cache.lookup('s1', 'v1');
    assert.equal(probe.hit, false);
    assert.equal(probe.revision, 'rev-1');
    assert.equal(typeof probe.key, 'string');

    const snapshot = page();
    cache.store('s1', probe.revision, probe.key, snapshot);
    await cache.flush();

    const hit = await cache.lookup('s1', 'v1');
    assert.equal(hit.hit, true);
    assert.equal(hit.key, probe.key);
    assert.deepEqual(hit.opening, snapshot);
    assert.equal(cache.stats.hits, 1);
    assert.equal(cache.stats.writes, 1);
  });
});

test('a new revision or variant misses instead of serving stale bytes', async () => {
  await withCache(async ({ cache, persistence }) => {
    const probe = await cache.lookup('s1', 'v1');
    cache.store('s1', probe.revision, probe.key, page());
    await cache.flush();

    persistence.revise('rev-2');
    const stale = await cache.lookup('s1', 'v1');
    assert.equal(stale.hit, false);
    assert.equal(stale.revision, 'rev-2');

    const other = await cache.lookup('s1', 'v2');
    assert.equal(other.hit, false);
    assert.equal(other.revision, 'rev-2');
  });
});

test('corrupt cache files are dropped and counted', async () => {
  await withCache(async ({ cache, dir }) => {
    const probe = await cache.lookup('s1', 'v1');
    const file = path.join(cache.dir, probe.key + '.json.zst');
    await fs.mkdir(cache.dir, { recursive: true });
    await fs.writeFile(file, 'not a zstd frame');
    const hit = await cache.lookup('s1', 'v1');
    assert.equal(hit.hit, false);
    assert.equal(cache.stats.invalid, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(fs.stat(file));
    void dir;
  });
});

test('an empty or misaligned opening is never served', async () => {
  await withCache(async ({ cache }) => {
    const probe = await cache.lookup('s1', 'v1');

    cache.store('s1', probe.revision, probe.key, { type: 'snapshot', cursor: 4, hasMore: true, records: [] });
    await cache.flush();
    assert.equal((await cache.lookup('s1', 'v1')).hit, false);
    assert.equal(cache.stats.invalid, 1);

    cache.store('s1', probe.revision, probe.key, page(3, 9));
    await cache.flush();
    assert.equal((await cache.lookup('s1', 'v1')).hit, false);
    assert.equal(cache.stats.invalid, 2);

    cache.store('s1', probe.revision, probe.key, { type: 'delta', cursor: 3, hasMore: true, records: page(3).records });
    await cache.flush();
    assert.equal((await cache.lookup('s1', 'v1')).hit, false);
    assert.equal(cache.stats.invalid, 3);

    cache.store('s1', probe.revision, probe.key, page(3));
    await cache.flush();
    const hit = await cache.lookup('s1', 'v1');
    assert.equal(hit.hit, true);
    assert.equal(hit.opening.records.length, 3);
  });
});

test('store is a no-op without a revision and evict counts drops', async () => {
  await withCache(async ({ cache }) => {
    cache.store('s1', undefined, 'k', page());
    cache.store('s1', '', 'k', page());
    await cache.flush();
    assert.equal(cache.stats.writes, 0);
    cache.evict('k');
    assert.equal(cache.stats.dropped, 1);
  });
});

test('stays disabled without a persistence service', async () => {
  const cache = createPageCache({ persistence: null, dir: path.join(os.tmpdir(), 'dsh-fastload-none') });
  assert.equal(cache.enabled, false);
  assert.equal((await cache.lookup('s1', 'v1')).hit, false);
});
