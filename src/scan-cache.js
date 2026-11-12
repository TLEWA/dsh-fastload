/**
 * dsh-fastload — persisted session-header index (P4).
 *
 * The Session list is built by walking the sessions root and reading the
 * first (zstd) line of every session log, then parsing and validating that
 * header. On a large history this is hundreds of file opens plus zstd frame
 * decodes per list call, even though the header line of a session never
 * changes once written.
 *
 * This module wraps the JSONL persistence seam with two bounded caches:
 *
 * 1. A persisted header index keyed by log path + exact mtime + size. Any
 *    append changes the file size (and mtime), so a stale entry can never be
 *    used for a changed log; a missing/removed log simply never matches.
 * 2. A short single-flight/TTL memo on `list()` so the burst of list calls a
 *    single boot performs is served from one directory walk.
 *
 * Everything is optional and fails soft: if the persistence seam does not
 * expose the expected internals, or the cache file is unreadable, the plugin
 * behaves exactly like the unmodified host.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SCAN_CACHE_VERSION = 1;
const LIST_TTL_MS = 400;
const PERSIST_DELAY_MS = 1500;
const MAX_ENTRIES = 20_000;
const CORDIS_ORIGINAL = Symbol.for('cordis.original');
const INSTALLED = Symbol.for('dsh-fastload.scan-cache');

function numeric(value) {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? value : Number(value);
}

function identityOf(stat) {
  return { m: numeric(stat.mtimeMs), s: numeric(stat.size) };
}

function sameIdentity(a, b) {
  return a !== undefined && b !== undefined && a.m === b.m && a.s === b.s;
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

export function defaultCacheDir(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : path.join(os.homedir(), '.dsh');
  return path.join(home, 'cache', 'dsh-fastload');
}

function readIndexFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || parsed.v !== SCAN_CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return new Map();
    }
    const entries = new Map();
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.m !== 'number' || typeof entry.s !== 'number') continue;
      if (!entry.h || typeof entry.h !== 'object') continue;
      entries.set(key, { m: entry.m, s: entry.s, h: entry.h, f: entry.f });
    }
    return entries;
  } catch {
    return new Map();
  }
}

function serializeIndex(entries) {
  const out = {};
  for (const [key, entry] of entries) out[key] = { m: entry.m, s: entry.s, h: entry.h, f: entry.f };
  return JSON.stringify({ v: SCAN_CACHE_VERSION, entries: out });
}

/**
 * Install the header index + list memo over one persistence service.
 *
 * @param {object} options
 * @param {object} options.persistence raw or traced persistence service
 * @param {object} options.state plugin diagnostics object
 * @param {boolean} [options.debug]
 * @param {string} [options.cacheDir]
 * @param {object} [options.logger]
 * @returns {{installed: boolean, dispose: () => void, stats: () => object}}
 */
export function installScanCache(options) {
  const { persistence, state, debug = false, cacheDir, logger } = options || {};
  const disabled = (stats) => ({ installed: false, dispose() {}, stats: () => stats });
  const target = persistence && (persistence[CORDIS_ORIGINAL] || persistence);
  if (!target || typeof target !== 'object') return disabled({ reason: 'no-persistence' });
  if (target[INSTALLED]) return disabled({ reason: 'already-installed' });
  if (typeof target.readGenerationHeader !== 'function' || typeof target.list !== 'function') {
    return disabled({ reason: 'unsupported-seam' });
  }

  const stats = { hits: 0, misses: 0, listHits: 0, listMisses: 0, persisted: 0, restored: 0 };
  const dir = cacheDir || defaultCacheDir();
  const indexFile = path.join(dir, 'scan-headers.json');
  const memo = new Map();
  let dirty = false;
  let timer = null;
  let disposed = false;
  let flushed = 0;

  const loaded = readIndexFile(indexFile);
  if (loaded.size > 0) {
    for (const [key, entry] of loaded) memo.set(key, entry);
    stats.restored = memo.size;
  }

  const scheduleFlush = () => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, PERSIST_DELAY_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const flush = async () => {
    if (!dirty || disposed) return;
    dirty = false;
    try {
      // Bound growth: keep the most recently touched entries.
      if (memo.size > MAX_ENTRIES) {
        const keep = [...memo.entries()].sort((a, b) => b[1].m - a[1].m).slice(0, MAX_ENTRIES);
        memo.clear();
        for (const [key, entry] of keep) memo.set(key, entry);
      }
      await fsp.mkdir(dir, { recursive: true });
      const tmp = indexFile + '.tmp-' + process.pid;
      await fsp.writeFile(tmp, serializeIndex(memo), 'utf8');
      await fsp.rename(tmp, indexFile);
      flushed += 1;
      stats.persisted = flushed;
      if (debug) process.stderr.write('[fl] scan index flushed entries=' + memo.size + '\n');
    } catch (error) {
      if (debug) process.stderr.write('[fl] scan index flush failed: ' + error + '\n');
    }
  };

  const originalHeader = target.readGenerationHeader;
  const headerWrapper = async function readGenerationHeader(selected, expectedId, signal) {
    if (disposed) return originalHeader.apply(this, arguments);
    const sourcePath = selected && selected.sourcePath;
    let before;
    if (typeof sourcePath === 'string') {
      try {
        before = identityOf(await fsp.stat(sourcePath, { bigint: true }));
      } catch {
        before = undefined;
      }
      const cached = before && memo.get(sourcePath);
      if (cached && sameIdentity(cached, before)) {
        stats.hits += 1;
        return { header: clone(cached.h), formatStatus: cached.f };
      }
    }
    const value = await originalHeader.apply(this, arguments);
    stats.misses += 1;
    if (before && value && typeof sourcePath === 'string') {
      let after;
      try {
        after = identityOf(await fsp.stat(sourcePath, { bigint: true }));
      } catch {
        after = undefined;
      }
      // Only memoize when the file did not move underneath the read, so the
      // entry can never describe a different revision than its identity.
      if (sameIdentity(before, after)) {
        memo.set(sourcePath, { m: before.m, s: before.s, h: value.header, f: value.formatStatus });
        dirty = true;
        scheduleFlush();
      }
    }
    return value;
  };

  const originalList = target.list;
  let listMemo = null;
  let inflight = null;
  // One shared list read serves every caller, so it cannot borrow the first
  // caller's abort signal: cancelling that caller would abort the read for
  // everyone else. Each caller keeps its own signal and stops waiting on it.
  const waitForCaller = (promise, signal) => {
    if (!signal || typeof signal.addEventListener !== 'function') return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('This operation was aborted'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  };
  const listWrapper = async function list() {
    if (disposed) return originalList.apply(this, arguments);
    const options = arguments[0];
    const signal = options && options.signal;
    if (signal && typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    if (listMemo !== null && Date.now() - listMemo.at < LIST_TTL_MS) {
      stats.listHits += 1;
      return listMemo.value;
    }
    if (inflight !== null) {
      stats.listHits += 1;
      return waitForCaller(inflight, signal);
    }
    stats.listMisses += 1;
    const self = this;
    const shared = options && options.signal === undefined ? options : { ...options };
    if (shared !== options) shared.signal = new AbortController().signal;
    inflight = (async () => {
      try {
        const value = await originalList.call(self, shared);
        listMemo = { at: Date.now(), value };
        return value;
      } finally {
        inflight = null;
      }
    })();
    return waitForCaller(inflight, signal);
  };

  target.readGenerationHeader = headerWrapper;
  target.list = listWrapper;
  target[INSTALLED] = true;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      if (target.readGenerationHeader === headerWrapper) delete target.readGenerationHeader;
      if (target.list === listWrapper) delete target.list;
      delete target[INSTALLED];
    } catch {}
    void flush();
  };

  if (debug) {
    try {
      logger?.info?.('[dsh-fastload] scan cache on: ' + memo.size + ' header(s) from ' + indexFile);
    } catch {}
    process.stderr.write('[fl] scan cache on entries=' + memo.size + '\n');
  }
  state.scanCache = { installed: true, dir, restored: memo.size, stats };
  return { installed: true, dispose, stats: () => ({ ...stats, entries: memo.size }) };
}
