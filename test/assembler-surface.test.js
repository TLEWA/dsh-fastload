import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { ASSEMBLER_PRIVATE_FIELDS, createAssemblerSurface } from '../src/assembler-surface.js';

const clientUrl = new URL('../client.js', import.meta.url);
const source = readFileSync(clientUrl, 'utf8');

/** The rc.5 shape: every field is a Map, locationIndex/viewDefinitions are objects. */
function assembler(overrides = {}) {
  return {
    contexts: new Map(),
    inputs: new Map([['chat', 1]]),
    locationIndex: { snapshot: () => ({ turnOrder: [1, 2] }) },
    views: new Map([['chat', { snapshot: { order: ['a'] } }]]),
    groups: new Map([['chat', { store: { entries: [] } }]]),
    viewDefinitions: { entries: () => [{ target: 'chat' }] },
    ...overrides,
  };
}

test('the guarded field list covers every private field this plugin reads', () => {
  assert.deepEqual([...ASSEMBLER_PRIVATE_FIELDS], [
    'contexts',
    'inputs',
    'locationIndex',
    'views',
    'groups',
    'viewDefinitions',
  ]);
  // The inline copy in the browser bundle must name exactly the same fields,
  // otherwise a field is guarded in one place and read raw in the other.
  const copy = source.match(/const ASSEMBLER_PRIVATE_FIELDS = \[([^\]]*)\]/);
  assert.ok(copy, 'client.js carries its own copy of the field list');
  const names = [...copy[1].matchAll(/'([a-zA-Z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(names, [...ASSEMBLER_PRIVATE_FIELDS]);
});

test('a complete rc.5 surface reads with no miss and no degrade', () => {
  let warned = 0;
  const surface = createAssemblerSurface(() => {
    warned += 1;
  });
  const host = assembler();
  assert.equal(surface.degraded, false);
  assert.equal(surface.size(host, 'inputs').value, 1);
  assert.equal(surface.size(host, 'contexts').value, 0);
  assert.deepEqual(surface.keys(host, 'views').value, ['chat']);
  assert.equal(surface.get(host, 'groups', 'chat').value.store.entries.length, 0);
  assert.deepEqual(surface.keys(host, 'groups').value, ['chat']);
  assert.equal(surface.read(host, 'locationIndex', (value) => value.snapshot().turnOrder.length).value, 2);
  assert.equal(surface.read(host, 'viewDefinitions', (value) => value.entries().length).value, 1);
  // A view name that is legitimately absent is not a miss.
  assert.equal(surface.get(host, 'views', 'missing').ok, true);
  assert.equal(surface.degraded, false);
  assert.deepEqual(surface.missing, []);
  assert.equal(warned, 0);
});

test('a missing field degrades instead of throwing, and warns only once', () => {
  const warnings = [];
  const surface = createAssemblerSurface((id) => warnings.push(id));
  // The one shape a refactor is most likely to produce: the field is gone.
  const host = assembler({ views: undefined, groups: undefined });
  const read = surface.size(host, 'views');
  assert.deepEqual(read, { ok: false, reason: 'missing' });
  assert.equal(surface.degraded, true);
  assert.deepEqual(surface.missing, ['views:missing']);
  assert.deepEqual(warnings, ['views:missing']);
  // Repeated reads keep returning the safe answer without a second warning.
  assert.deepEqual(surface.keys(host, 'views'), { ok: false, reason: 'missing' });
  assert.deepEqual(warnings, ['views:missing']);
  // A second, different field is recorded but still must not warn again: the
  // page already logged that it fell back.
  assert.deepEqual(surface.keys(host, 'groups'), { ok: false, reason: 'missing' });
  assert.deepEqual(surface.missing, ['views:missing', 'groups:missing']);
  assert.deepEqual(surface.snapshot(), { degraded: true, missing: ['views:missing', 'groups:missing'] });
});

test('a throwing getter, a wrong shape and a missing assembler all degrade', () => {
  const host = assembler();
  Object.defineProperty(host, 'groups', {
    get() {
      throw new Error('private field is not initialised');
    },
  });
  const surface = createAssemblerSurface();
  const thrown = surface.keys(host, 'groups');
  assert.equal(thrown.ok, false);
  assert.equal(thrown.reason, 'threw');
  assert.match(thrown.detail, /not initialised/);
  // Present but no longer a Map: the shape check is what catches a refactor
  // that keeps the name and swaps the container.
  const plain = createAssemblerSurface();
  assert.deepEqual(plain.size(assembler({ inputs: { chat: 1 } }), 'inputs'), { ok: false, reason: 'shape' });
  assert.deepEqual(plain.keys(assembler({ views: { chat: {} } }), 'views'), { ok: false, reason: 'shape' });
  const bare = createAssemblerSurface();
  assert.deepEqual(bare.size(null, 'inputs'), { ok: false, reason: 'no-assembler' });
  assert.equal(bare.degraded, true);
  // A throwing callback must not escape either.
  const noisy = createAssemblerSurface(() => {
    throw new Error('sink is broken');
  });
  assert.doesNotThrow(() => noisy.size(null, 'inputs'));
});

test('the browser copy routes every assembler read through the guarded reader', () => {
  // Same inline-copy contract as the lazy-group predicates: the browser cannot
  // import src/, so the rule is enforced by matching the two implementations.
  assert.match(source, /const surfaceRead = \(owner, key, extract\) => \{/);
  assert.match(source, /if \(!owner \|\| \(typeof owner !== 'object' && typeof owner !== 'function'\)\) \{/);
  assert.match(source, /surfaceMiss\(key, 'no-assembler'\)/);
  assert.match(source, /const surfaceSize = \(owner, key\) => surfaceRead\(owner, key, \(value\) => \(typeof value\.size === 'number' \? value\.size : undefined\)\)/);
  assert.match(source, /const surfaceKeys = \(owner, key\) => surfaceRead\(owner, key, \(value\) => \(typeof value\.keys === 'function' \? \[\.\.\.value\.keys\(\)\] : undefined\)\)/);
  assert.match(source, /const surfaceGet = \(owner, key, name\) => \{/);
  assert.match(source, /read\.ok \? \{ ok: true, value: read\.value\.value \} : read/);
  // No raw private reads survive outside the guarded reader.
  assert.doesNotMatch(source, /assembler\.inputs\.size/);
  assert.doesNotMatch(source, /assembler\.(views|groups|contexts)\.get\('chat'\)/);
  assert.doesNotMatch(source, /assembler\.(views|groups|contexts)\.size/);
  assert.doesNotMatch(source, /assembler\.(views|groups)\.keys\(\)/);
  assert.doesNotMatch(source, /assembler\.locationIndex\.snapshot\(\)/);
  // Degraded means the stock path: the watchers bail out before repairing.
  assert.match(source, /if \(surface\.degraded\) return false;/);
  // One warning for the whole page, through the untouched console.warn.
  assert.match(source, /const surfaceWarned = \{ value: false \};/);
  assert.match(source, /originalWarn\('\[dsh-fastload\] assembler surface/);
});
