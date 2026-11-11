import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installScanCache } from '../src/scan-cache.js';

async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fastload-scan-'));
  try {
    const log = path.join(dir, 'session.v4.jsonl.zstd');
    await fs.writeFile(log, 'header\n');
    const calls = { headers: 0, lists: 0 };
    // The real persistence seam exposes these on a prototype; the wrapper only
    // deletes its own properties, so mirror that shape here.
    const proto = {
      async readGenerationHeader() {
        calls.headers += 1;
        return { header: { id: 'gen-' + calls.headers, version: 4 }, formatStatus: 'ok' };
      },
      async list() {
        calls.lists += 1;
        return [{ id: 'session-a', updatedAt: 1 }];
      },
    };
    const persistence = Object.create(proto);
    await fn({ dir, log, calls, persistence });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('reuses a session header until the file identity changes', async () => {
  await fixture(async ({ dir, log, calls, persistence }) => {
    const cache = installScanCache({ persistence, cacheDir: dir, state: {}, debug: false });
    assert.equal(cache.installed, true);

    const first = await persistence.readGenerationHeader({ sourcePath: log });
    const second = await persistence.readGenerationHeader({ sourcePath: log });
    assert.deepEqual(second, first);
    assert.equal(calls.headers, 1);
    assert.equal(cache.stats().hits, 1);

    await fs.writeFile(log, 'header that grew\n');
    await persistence.readGenerationHeader({ sourcePath: log });
    assert.equal(calls.headers, 2);

    cache.dispose();
  });
});

test('single-flights and memoizes list calls for a short window', async () => {
  await fixture(async ({ dir, calls, persistence }) => {
    const cache = installScanCache({ persistence, cacheDir: dir, state: {}, debug: false });
    const [a, b] = await Promise.all([persistence.list(), persistence.list()]);
    assert.equal(calls.lists, 1);
    assert.equal(a, b);

    const c = await persistence.list();
    assert.equal(c, b);
    assert.equal(calls.lists, 1);
    assert.ok(cache.stats().listHits >= 1);

    await new Promise((resolve) => setTimeout(resolve, 450));
    await persistence.list();
    assert.equal(calls.lists, 2);

    cache.dispose();
    await persistence.list();
    assert.equal(calls.lists, 3);
  });
});

test('stays inert when the persistence seam is not the expected shape', () => {
  const cache = installScanCache({ persistence: { stat() {} }, cacheDir: os.tmpdir(), state: {} });
  assert.equal(cache.installed, false);
  cache.dispose();
});
