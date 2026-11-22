// Defensive reads of the conversation assembler's private surface.
//
// The chat view reads a handful of fields that `assembler.ts` declares
// `private`: TypeScript privacy is erased at runtime, so today the values are
// reachable, but nothing in the plugin surface promises that. A minor host
// release may rename a field, make it a getter that throws, or change a Map
// into a plain record. Reading them raw turns that into an exception inside a
// polling loop, which is far worse than losing the optimisation.
//
// So every access goes through one place: it checks that the owner and the
// field exist, wraps the read in try/catch, validates the shape the caller
// needs, and records a miss instead of throwing. A miss means "degrade": the
// caller keeps the stock path (no slimming, no repair) and the page is warned
// about once.
//
// client.js is a single classic script loaded by the DSH web module loader, so
// it cannot import this module at runtime. The browser bundle keeps an inline
// copy of `createAssemblerSurface`; this file exists so the degrade logic can
// be tested under node --test and referenced from the adaptation report.

/** Fields read by this plugin, all declared `private` in the host assembler. */
export const ASSEMBLER_PRIVATE_FIELDS = Object.freeze([
  'contexts',
  'inputs',
  'locationIndex',
  'views',
  'groups',
  'viewDefinitions',
]);

/**
 * Build a surface reader bound to one page.
 *
 * `onMiss(id, key, reason)` is called the first time a given key/reason pair is
 * seen; the caller uses it to warn once. Every failure path returns
 * `{ ok: false, reason }` and never throws, and `degraded` latches: once the
 * surface could not be read, the page stays on the stock path.
 */
export function createAssemblerSurface(onMiss) {
  const missing = [];
  const seen = new Set();
  let degraded = false;
  const miss = (key, reason) => {
    degraded = true;
    const id = key + ':' + reason;
    if (seen.has(id)) return false;
    seen.add(id);
    missing.push(id);
    if (typeof onMiss === 'function') {
      try {
        onMiss(id, key, reason);
      } catch {}
    }
    return true;
  };
  const read = (owner, key, extract) => {
    if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) {
      miss(key, 'no-assembler');
      return { ok: false, reason: 'no-assembler' };
    }
    let value;
    try {
      value = owner[key];
    } catch (error) {
      miss(key, 'threw');
      return { ok: false, reason: 'threw', detail: String(error && error.message ? error.message : error) };
    }
    if (value === undefined || value === null) {
      miss(key, 'missing');
      return { ok: false, reason: 'missing' };
    }
    if (typeof extract !== 'function') return { ok: true, value };
    try {
      const out = extract(value);
      if (out === undefined) {
        miss(key, 'shape');
        return { ok: false, reason: 'shape' };
      }
      return { ok: true, value: out };
    } catch (error) {
      miss(key, 'threw');
      return { ok: false, reason: 'threw', detail: String(error && error.message ? error.message : error) };
    }
  };
  return {
    fields: ASSEMBLER_PRIVATE_FIELDS,
    get degraded() {
      return degraded;
    },
    missing,
    read,
    field: (owner, key) => read(owner, key),
    size: (owner, key) => read(owner, key, (value) => (typeof value.size === 'number' ? value.size : undefined)),
    keys: (owner, key) => read(owner, key, (value) => (typeof value.keys === 'function' ? [...value.keys()] : undefined)),
    // A Map lookup that legitimately misses returns undefined, which the
    // shape check above would read as a broken container: wrap it so only a
    // missing get() and a throwing get() count as a miss.
    get: (owner, key, name) => {
      const result = read(owner, key, (value) => (typeof value.get === 'function' ? { value: value.get(name) } : undefined));
      return result.ok ? { ok: true, value: result.value.value } : result;
    },
    snapshot() {
      return { degraded, missing: missing.slice() };
    },
  };
}
