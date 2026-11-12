import test from 'node:test';
import assert from 'node:assert/strict';
import { earliestCut, findRewindCuts, firstSeqOf, hiddenByCuts } from '../src/rewind.js';

const run = (seq, name, args) => ({ event: { type: 'command/run', seq, data: { name, args } } });
const done = (seq, marker, kind = 'success') => ({ event: { type: 'command/done', seq, data: { kind, sourceEventSeq: marker } } });
const message = (seq, type = 'assistant/message') => ({ event: { type, seq, data: {} } });

test('rewind commands pair with their completion into cuts', () => {
  const cuts = findRewindCuts([
    message(10),
    run(20, 'rewind-plugin', ' @5 chat'),
    done(22, 21),
    message(30),
  ]);
  assert.deepEqual(cuts, [{ target: 5, marker: 21, runSeq: 20 }]);
});

test('legacy rewind name and the "both" scope are recognized', () => {
  const cuts = findRewindCuts([run(40, 'rewind', ' @12 both'), done(44, 43)]);
  assert.deepEqual(cuts, [{ target: 12, marker: 43, runSeq: 40 }]);
});

test('previews, candidate listings and non-rewind commands are ignored', () => {
  const cuts = findRewindCuts([
    run(1, 'rewind-plugin', ' @5 chat preview'),
    done(2, 1),
    run(3, 'rewind', ' --__candidates'),
    done(4, 3),
    run(5, 'compact', ' @1'),
    done(6, 6),
  ]);
  assert.deepEqual(cuts, []);
});

test('failed outcomes never produce a cut', () => {
  const cuts = findRewindCuts([run(10, 'rewind', ' @5'), done(12, 11, 'error')]);
  assert.deepEqual(cuts, []);
});

test('a run without a completion stays uncut', () => {
  assert.deepEqual(findRewindCuts([run(10, 'rewind', ' @5')]), []);
});

test('hiddenByCuts matches the inclusive interval only', () => {
  const cuts = [{ target: 5, marker: 9 }];
  assert.equal(hiddenByCuts(4, cuts), false);
  assert.equal(hiddenByCuts(5, cuts), true);
  assert.equal(hiddenByCuts(9, cuts), true);
  assert.equal(hiddenByCuts(10, cuts), false);
  assert.equal(hiddenByCuts(null, cuts), false);
});

test('earliestCut and firstSeqOf read the page boundaries', () => {
  assert.equal(earliestCut([{ target: 30, marker: 40 }, { target: 12, marker: 20 }]), 12);
  assert.equal(earliestCut([]), null);
  assert.equal(firstSeqOf([message(7), message(8)]), 7);
  assert.equal(firstSeqOf([]), null);
});

test('a page fully inside a cut has no visible message', () => {
  const records = [message(6), message(7), run(10, 'rewind', ' @5 chat'), done(12, 11), message(8)];
  const cuts = findRewindCuts(records);
  const seqs = records
    .map((record) => record.event)
    .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    .filter((event) => !hiddenByCuts(event.seq, cuts))
    .map((event) => event.seq);
  assert.deepEqual(seqs, []);
});
