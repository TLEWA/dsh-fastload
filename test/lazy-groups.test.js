import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  LAZY_GROUPS_KEY,
  LAZY_GROUPS_SLOT,
  LAZY_PROGRESSIVE_KEY,
  LAZY_GROUP_TEXT_MAX,
  lazyGroupEligible,
  lazyGroupMode,
  lazyGroupText,
} from '../src/lazy-groups.js';

function owner(overrides = {}) {
  const process = {
    foldable: true,
    open: false,
    spec: { turn: 3, processStartSeq: 10, answerAnchorSeq: 40 },
    ...overrides.process,
  };
  const node = {
    kind: 'tool-call',
    anchorSeq: 20,
    key: 'n1',
    data: { name: 'ops_bash' },
    ...overrides.node,
  };
  return { turnProcess: overrides.turnProcess === null ? undefined : process, node: overrides.node === null ? undefined : node };
}

test('the lazy-group switch is a stable localStorage key', () => {
  assert.equal(LAZY_GROUPS_KEY, 'dsh-fastload.lazy-groups');
});

test('the flow slot name matches the native registration', () => {
  assert.equal(LAZY_GROUPS_SLOT, 'conversation.chat.flow');
});

test('folded tool-call inside the process window is eligible', () => {
  assert.equal(lazyGroupEligible(owner()), true);
});

test('an open group is never eligible', () => {
  assert.equal(lazyGroupEligible(owner({ process: { open: true } })), false);
});

test('a non-foldable process is never eligible', () => {
  assert.equal(lazyGroupEligible(owner({ process: { foldable: false } })), false);
});

test('only tool calls are replaced; user and assistant-step stay native', () => {
  assert.equal(lazyGroupEligible(owner({ node: { kind: 'user' } })), false);
  assert.equal(lazyGroupEligible(owner({ node: { kind: 'assistant-step' } })), false);
  assert.equal(lazyGroupEligible(owner({ node: { kind: 'turn-process' } })), false);
});

test('a missing owner, node or process delegates to native', () => {
  assert.equal(lazyGroupEligible(null), false);
  assert.equal(lazyGroupEligible(owner({ node: null })), false);
  assert.equal(lazyGroupEligible(owner({ turnProcess: null })), false);
  assert.equal(lazyGroupEligible(owner({ process: { spec: null } })), false);
});

test('nodes before the process window or at/after the answer anchor stay native', () => {
  assert.equal(lazyGroupEligible(owner({ node: { anchorSeq: 9 } })), false);
  assert.equal(lazyGroupEligible(owner({ node: { anchorSeq: 40 } })), false);
  assert.equal(lazyGroupEligible(owner({ node: { anchorSeq: 39 } })), true);
});

test('an unknown answer anchor keeps the whole process window eligible', () => {
  assert.equal(lazyGroupEligible(owner({ process: { spec: { turn: 3, processStartSeq: 10, answerAnchorSeq: null } }, node: { anchorSeq: 999 } })), true);
});

test('text mirror collects scalars and skips duplicated wire keys', () => {
  const text = lazyGroupText({
    name: 'ops_bash',
    input: { command: 'git status', retries: 2, ok: true },
    raw: 'duplicated raw payload',
    json: 'duplicated json payload',
    nested: [{ text: 'first' }, { text: 'second' }],
  });
  assert.match(text, /ops_bash/);
  assert.match(text, /git status/);
  assert.match(text, /2/);
  assert.match(text, /true/);
  assert.match(text, /first/);
  assert.match(text, /second/);
  assert.doesNotMatch(text, /duplicated/);
});

test('text mirror caps the collected characters', () => {
  assert.equal(lazyGroupText('abcdefghij', 4), 'abcd');
  assert.equal(lazyGroupText({ a: 'xxxx', b: 'yyyy' }, 6).replace(/ /g, ''), 'xxxxyy');
  assert.equal(lazyGroupText('abc', 0), '');
  assert.equal(lazyGroupText('abc', -1), '');
});

test('text mirror is depth-limited and safe on cycles', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 'too-deep' } } } } } } };
  assert.doesNotMatch(lazyGroupText(deep), /too-deep/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => lazyGroupText(cyclic));
  assert.equal(lazyGroupText(null), '');
});

test('the shipped client keeps the same switch, slot and marker', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("'dsh-fastload.lazy-groups'"));
  assert.ok(client.includes("'conversation.chat.flow'"));
  assert.ok(client.includes('data-fastload-lazy-group'));
  assert.ok(client.includes('installLazyGroups'));
  assert.ok(client.includes('__dshFastloadLazyGroups'));
  assert.ok(client.includes("node.kind !== 'tool-call'"));
});

test('the mirror budget constant is documented and bounded', () => {
  assert.equal(LAZY_GROUP_TEXT_MAX, 4000);
});

test('progressive switch is separate and wins over permanent', () => {
  assert.equal(LAZY_PROGRESSIVE_KEY, 'dsh-fastload.lazy-progressive');
  assert.equal(lazyGroupMode(false, false), 'off');
  assert.equal(lazyGroupMode(true, false), 'permanent');
  assert.equal(lazyGroupMode(false, true), 'progressive');
  assert.equal(lazyGroupMode(true, true), 'progressive');
});

test('the shipped client exposes both switches and the progressive drain', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("'dsh-fastload.lazy-progressive'"));
  assert.ok(client.includes('requestIdleCallback'));
  assert.ok(client.includes('flushSync'));
  assert.ok(client.includes("addEventListener('beforematch'"));
  assert.ok(client.includes('LAZY_PROGRESSIVE_CHUNK_NODES'));
});
