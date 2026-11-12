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
  // Stage 5: the deferred live build is opt-in; a stock install never delays it.
  assert.equal(config.deferLiveBuild, false);
});

test('parses DSH_FASTLOAD_DEFER_LIVE_BUILD with the shared boolean rules', () => {
  assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: '1' }).deferLiveBuild, true);
  assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: 'on' }).deferLiveBuild, true);
  for (const value of ['0', 'false', 'FALSE', 'off', 'no']) {
    assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: value }).deferLiveBuild, false, value);
  }
  // An empty value means "unset", so the default (off) applies.
  assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: '' }).deferLiveBuild, false);
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
test('keeps a rewind-recovered turn that the byte budget would cut away', () => {
  // A tail-only page whose newest turns are hidden by a /rewind cut; the
  // extension put one older visible turn in front of them. Trimming must not
  // hand that turn back to the hidden side.
  const opening = page(8, 2000);
  const protectedSeq = opening.records[10].event.seq; // user/message of turn 3
  const result = planTrim({ ...opening, cuts: true }, {
    maxBytes: 3000,
    hardCapBytes: 10 * 1024 * 1024,
    minTurns: 2,
    protectSeq: protectedSeq,
  });

  assert.notEqual(result.info, null);
  const first = result.opening.records[0].event;
  assert.equal(first.type, 'turn/start');
  assert.ok(first.seq <= protectedSeq);
  const kept = result.opening.records.some(
    (record) => record.event.type === 'user/message' && record.event.seq === protectedSeq
  );
  assert.equal(kept, true);
  assert.ok(result.info.cutIndex <= result.info.protectedIndex);
});

test('leaves the page alone when the recovered turn cannot fit the hard cap', () => {
  const opening = page(8, 2000);
  const protectedSeq = opening.records[10].event.seq;
  const result = planTrim(opening, {
    maxBytes: 3000,
    hardCapBytes: 8000,
    minTurns: 2,
    protectSeq: protectedSeq,
  });

  assert.equal(result.info, null);
  assert.equal(result.opening, opening);
});

test('ignores a protectSeq that is not in the page', () => {
  const opening = page(8, 2000);
  const result = planTrim(opening, {
    maxBytes: 3000,
    minTurns: 2,
    protectSeq: 999999,
  });
  assert.notEqual(result.info, null);
});
