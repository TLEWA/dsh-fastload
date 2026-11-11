import assert from 'node:assert/strict';
import test from 'node:test';

import { planCompact } from '../src/compact.js';

function rec(seq, type, data) {
  return { type: 'event', event: { seq, type, data } };
}

function opening(records) {
  return { type: 'snapshot', cursor: 9, hasMore: true, records };
}

test('strips replay streams from settled assistant messages', () => {
  const chunks = Array.from({ length: 4 }, (_, i) => ({ type: 'chunk', chunk: { type: 'text-delta', text: 'x'.repeat(200) } }));
  const records = [
    rec(1, 'user/message', { message: { content: 'hi' } }),
    rec(2, 'assistant/message', { message: { content: 'hello' }, stream: chunks, usage: { outputTokens: 3 } }),
    rec(3, 'tool/result', { output: 'kept' }),
  ];
  const page = opening(records);
  const { opening: next, info } = planCompact(page, {});

  assert.deepEqual(next.records[1].event.data.stream, []);
  assert.deepEqual(next.records[1].event.data.usage, { outputTokens: 3 });
  assert.equal(next.records[1].event.data.message.content, 'hello');
  assert.equal(info.stripped, 1);
  assert.ok(info.savedBytes > 0);
  // untouched events keep identity
  assert.equal(next.records[0], page.records[0]);
  assert.equal(next.records[2], page.records[2]);
  // input is never mutated
  assert.equal(page.records[1].event.data.stream.length, 4);
});

test('keeps short streams, foreign events and empty pages untouched', () => {
  const short = [ { type: 'chunk', chunk: { type: 'usage', usage: {} } } ];
  const page = opening([
    rec(1, 'assistant/message', { message: { content: 'a' }, stream: short }),
    rec(2, 'assistant/attempt', { stream: [{ type: 'chunk', chunk: { type: 'text-delta', text: 'y'.repeat(300) } }] }),
    rec(3, 'user/message', { message: { content: 'b' }, stream: short }),
  ]);
  const { opening: next, info } = planCompact(page, {});
  assert.equal(next.records[0], page.records[0]);
  assert.deepEqual(next.records[1].event.data.stream, []);
  assert.equal(next.records[2], page.records[2]);
  assert.deepEqual(info, { stripped: 1, savedBytes: info.savedBytes });
  assert.ok(info.savedBytes > 0);

  assert.equal(planCompact({ type: 'snapshot', records: [] }, {}).info, null);
  assert.equal(planCompact({ type: 'event', event: {} }, {}).info, null);
  assert.equal(planCompact(null, {}).opening, null);
});

test('respects the stripStream switch and the size floor', () => {
  const chunk = { type: 'chunk', chunk: { type: 'text-delta', text: 'z'.repeat(400) } };
  const page = opening([ rec(1, 'assistant/message', { message: { content: 'm' }, stream: [chunk] }) ]);
  assert.equal(planCompact(page, { stripStream: false }).info, null);
  assert.equal(planCompact(page, { minStreamBytes: 100000 }).info, null);
  assert.ok(planCompact(page, { minStreamBytes: 10 }).info);
});
