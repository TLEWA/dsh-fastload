import assert from 'node:assert/strict';
import test from 'node:test';

import { readConfig } from '../src/config.js';
import { isInitialPage } from '../src/page.js';
import { planTrim } from '../src/trim.js';

function rec(seq, type, extra = {}) {
  return { type: 'event', event: { seq, type, ...extra } };
}

function page(turnCount = 4, textSize = 2000) {
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

test('config defaults are the tested safe page', () => {
  const config = readConfig({});
  assert.equal(config.maxMessages, 100);
  assert.equal(config.minMessages, 40);
  assert.equal(config.minTurns, 2);
  assert.equal(config.maxBytes, 0);
  assert.equal(config.enabled, true);
});

test('config clamps minMessages and byte floor', () => {
  const config = readConfig({
    DSH_FASTLOAD_MAX_MESSAGES: '50',
    DSH_FASTLOAD_MIN_MESSAGES: '80',
    DSH_FASTLOAD_MAX_BYTES: '1024',
  });
  assert.equal(config.maxMessages, 50);
  assert.equal(config.minMessages, 50);
  assert.equal(config.maxBytes, 64 * 1024);
});

test('only initial pages are eligible by default', () => {
  assert.equal(isInitialPage({ maxMessages: 500 }, {}), true);
  assert.equal(isInitialPage({}, {}), true);
  assert.equal(isInitialPage({ maxMessages: 100 }, {}), false);
  assert.equal(isInitialPage({ maxMessages: 500, beforeSeq: 42 }, {}), false);
  assert.equal(isInitialPage({ maxMessages: 500, throughSeq: 42 }, {}), false);
  assert.equal(isInitialPage({ maxMessages: 100 }, { force: true }), true);
});

test('does not trim a page that already fits', () => {
  const opening = page(4, 100);
  const result = planTrim(opening, { maxBytes: 10 * 1024 * 1024, minTurns: 2 });
  assert.equal(result.info, null);
  assert.equal(result.opening, opening);
});

test('trims only at turn/start and keeps at least two turns', () => {
  const opening = page(4, 4000);
  const result = planTrim(opening, {
    maxBytes: 9000,
    hardCapBytes: 10 * 1024 * 1024,
    minTurns: 2,
  });

  assert.ok(result.info, 'expected a trim');
  assert.ok(result.info.afterBytes < result.info.beforeBytes);
  assert.equal(result.opening.records[0].event.type, 'turn/start');
  assert.equal(
    result.opening.records.filter((record) => record.event.type === 'turn/start').length,
    2
  );
  assert.equal(result.opening.hasMore, true);
});

test('keeps protected turns when they exceed the soft budget but fit the hard cap', () => {
  const opening = page(4, 4000);
  const result = planTrim(opening, {
    maxBytes: 1000,
    hardCapBytes: 10 * 1024 * 1024,
    minTurns: 2,
  });

  assert.ok(result.info, 'expected a trim to the protected boundary');
  assert.equal(result.opening.records[0].event.type, 'turn/start');
  assert.equal(
    result.opening.records.filter((record) => record.event.type === 'turn/start').length,
    2
  );
});

test('does not trim when the protected turns exceed the hard cap', () => {
  const opening = page(4, 4000);
  const result = planTrim(opening, {
    maxBytes: 1000,
    hardCapBytes: 2000,
    minTurns: 2,
  });

  assert.equal(result.info, null);
  assert.equal(result.opening, opening);
});

test('does not trim when there are fewer than minTurns turns', () => {
  const opening = page(1, 4000);
  const result = planTrim(opening, {
    maxBytes: 1000,
    hardCapBytes: 10 * 1024 * 1024,
    minTurns: 2,
  });
  assert.equal(result.info, null);
});
