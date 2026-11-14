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
  // Stage 5 shipped the deferred live build off; stage 8 enables it by default.
  assert.equal(config.deferLiveBuild, true);
});

test('parses DSH_FASTLOAD_DEFER_LIVE_BUILD with the shared boolean rules', () => {
  assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: '1' }).deferLiveBuild, true);
  assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: 'on' }).deferLiveBuild, true);
  for (const value of ['0', 'false', 'FALSE', 'off', 'no']) {
    assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: value }).deferLiveBuild, false, value);
  }
  // An empty value means "unset", so the new default (on) applies.
  assert.equal(readConfig({ DSH_FASTLOAD_DEFER_LIVE_BUILD: '' }).deferLiveBuild, true);
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

test('keeps the whole page when the recovered turn is the first one', () => {
  // The rewind extension can pull the only visible turn in front of a hidden
  // tail, making that turn record 0. Index 0 is a legal protection point.
  const opening = page(8, 2000);
  const result = planTrim(opening, {
    maxBytes: 3000,
    hardCapBytes: 8 * 1024 * 1024,
    minTurns: 2,
    protectSeq: opening.records[0].event.seq,
  });

  assert.equal(result.info, null, 'cutting at index 0 would empty the transcript');
  assert.equal(result.opening, opening);
  assert.equal(result.opening.records[0].event.seq, 1);
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

function longTurn(groups = 30, textSize = 4000) {
  const records = [
    rec(1, 'turn/start', { turnId: 'turn-0' }),
    rec(2, 'user/message', { message: { content: 'q' } }),
  ];
  let seq = 3;
  for (let i = 0; i < groups; i += 1) {
    records.push(
      rec(seq++, 'assistant/message', {
        message: { content: 'a'.repeat(textSize) },
        sourceEventSeqs: [seq - 1],
      })
    );
    records.push(rec(seq++, 'tool/call', { call: { name: 'read', input: 'x'.repeat(textSize) } }));
    records.push(rec(seq++, 'tool/result', { result: { content: 'y'.repeat(textSize) } }));
  }
  return { type: 'snapshot', records, hasMore: true };
}

function bytesOf(records) {
  return records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0);
}

test('message-aligned trim cuts a single-turn page the Host pager cannot window', () => {
  const opening = longTurn();
  const result = planTrim(opening, {
    maxBytes: 64 * 1024,
    hardCapBytes: 8 * 1024 * 1024,
    minMessages: 4,
    cutAtMessages: true,
  });

  assert.notEqual(result.info, null, 'a one-turn page must still be windowed');
  assert.equal(result.info.cutAt, 'message');
  assert.ok(result.info.afterRecords < result.info.beforeRecords);
  assert.ok(bytesOf(result.opening.records) <= 64 * 1024, 'the kept tail fits the budget');
  assert.equal(result.opening.hasMore, true);
  assert.equal(result.opening.records[0].event.type, 'assistant/message', 'cut at a message start');
  const kept = result.opening.records.filter((record) => record.event.type === 'assistant/message');
  assert.ok(kept.length >= 4, 'the newest minMessages message groups stay');
});

test('message-aligned trim keeps the newest messages when they alone exceed the budget', () => {
  const opening = longTurn(10, 4000);
  const result = planTrim(opening, {
    maxBytes: 1000,
    hardCapBytes: 10 * 1024 * 1024,
    minMessages: 3,
    cutAtMessages: true,
  });

  assert.notEqual(result.info, null);
  assert.equal(result.info.cutAt, 'message');
  const kept = result.opening.records.filter((record) => record.event.type === 'assistant/message');
  assert.equal(kept.length, 3, 'the protected tail wins over the soft budget');
});

test('message-aligned trim leaves the page alone below the budget', () => {
  const opening = page(4, 100);
  const result = planTrim(opening, {
    maxBytes: 10 * 1024 * 1024,
    minMessages: 4,
    cutAtMessages: true,
  });
  assert.equal(result.info, null);
  assert.equal(result.opening, opening);
});

test('message-aligned trim keeps a rewind-recovered message', () => {
  const opening = longTurn(20, 4000);
  const target = opening.records.find(
    (record, index) => index > 10 && record.event.type === 'assistant/message'
  );
  const result = planTrim(opening, {
    maxBytes: 32 * 1024,
    hardCapBytes: 8 * 1024 * 1024,
    minMessages: 2,
    cutAtMessages: true,
    protectSeq: target.event.seq,
  });

  assert.notEqual(result.info, null);
  assert.ok(result.opening.records[0].event.seq <= target.event.seq);
  const kept = result.opening.records.some(
    (record) => record.event.type === 'assistant/message' && record.event.seq === target.event.seq
  );
  assert.equal(kept, true);
});

test('message-aligned trim keeps the whole page when message 0 is protected', () => {
  const records = [rec(1, 'assistant/message', { message: { content: 'only visible' } })];
  let seq = 2;
  for (let i = 0; i < 40; i += 1) {
    records.push(
      rec(seq++, 'assistant/message', { message: { content: 'h'.repeat(4000) } })
    );
  }
  const opening = { type: 'snapshot', records, hasMore: true };
  const result = planTrim(opening, {
    maxBytes: 16 * 1024,
    hardCapBytes: 8 * 1024 * 1024,
    minMessages: 2,
    cutAtMessages: true,
    protectSeq: 1,
  });

  assert.equal(result.info, null, 'the protected first message must survive the cut');
  assert.equal(result.opening, opening);
  assert.equal(result.opening.records[0].event.seq, 1);
});

test('message-aligned cut still honours the hard cap for the protected tail', () => {
  const opening = longTurn(10, 4000);
  const result = planTrim(opening, {
    maxBytes: 1000,
    hardCapBytes: 2000,
    minMessages: 3,
    cutAtMessages: true,
  });

  assert.equal(result.info, null, 'a tail that cannot fit the hard cap is left untouched');
  assert.equal(result.opening, opening);
});

test('running byte budget defaults are parsed and clamped', () => {
  const config = readConfig({});
  assert.equal(config.runningMaxBytes, 256 * 1024);
  assert.equal(config.runningMinMessages, 4);
  // A nonzero budget below the floor is raised to 32 KiB; 0 disables the cut.
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_MAX_BYTES: '1024' }).runningMaxBytes, 32 * 1024);
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_MAX_BYTES: '0' }).runningMaxBytes, 0);
  assert.equal(
    readConfig({ DSH_FASTLOAD_RUNNING_MAX_BYTES: 'nope' }).runningMaxBytes,
    256 * 1024
  );
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_MIN_MESSAGES: '2' }).runningMinMessages, 2);
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_MIN_MESSAGES: '0' }).runningMinMessages, 4);
});

test('running page defaults leave the idle page untouched', () => {
  const config = readConfig({});
  assert.equal(config.maxMessages, 100);
  assert.equal(config.minMessages, 40);
  assert.equal(config.runningMaxMessages, 24);
  // The running window skips the page cache: a live baseline invalidates it.
  assert.equal(config.runningPageCache, false);
});

test('parses and clamps the running page window', () => {
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_MAX_MESSAGES: '40' }).runningMaxMessages, 40);
  // An out-of-range value falls back to the default instead of an empty page.
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_MAX_MESSAGES: '0' }).runningMaxMessages, 24);
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_MAX_MESSAGES: 'nope' }).runningMaxMessages, 24);
  // A running page is a shrink, never a widen: a MAX_MESSAGES cap below the
  // running default must also cap the running window (codex P2 on PR #19).
  assert.equal(
    readConfig({ DSH_FASTLOAD_MAX_MESSAGES: '10' }).runningMaxMessages,
    10
  );
  assert.equal(
    readConfig({ DSH_FASTLOAD_MAX_MESSAGES: '10', DSH_FASTLOAD_RUNNING_MAX_MESSAGES: '40' })
      .runningMaxMessages,
    10
  );
  assert.equal(
    readConfig({ DSH_FASTLOAD_MAX_MESSAGES: '10', DSH_FASTLOAD_RUNNING_MAX_MESSAGES: '4' })
      .runningMaxMessages,
    4
  );
  assert.equal(readConfig({ DSH_FASTLOAD_RUNNING_PAGE_CACHE: '1' }).runningPageCache, true);
  for (const value of ['0', 'false', 'off', 'no']) {
    assert.equal(
      readConfig({ DSH_FASTLOAD_RUNNING_PAGE_CACHE: value }).runningPageCache,
      false,
      value
    );
  }
});