/**
 * dsh-fastload — persisted first-page snapshot cache (P5).
 *
 * Opening a cold historical Session costs a full zstd log read, event
 * validation and page construction (hundreds of milliseconds on a long
 * transcript), and the same page is rebuilt from scratch on every cold open,
 * including the boot restore of the last Session.
 *
 * This module stores the *final* opening snapshot (the exact `snapshot` frame
 * the host would hand to the client) under a key that covers the Session id,
 * the persistence revision observed before the build, the page window and the
 * byte-trim configuration. Because the JSONL revision changes on every append,
 * a cache entry can only be used while the stored log is byte-identical to the
 * one it was built from.
 *
 * The cache is strictly best effort: any read, parse, decompress or write
 * failure falls back to the normal path, and the wrapper in index.js only
 * drops the live opening when its cursor and assistant-stream baseline match
 * the cached one.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

export const PAGE_CACHE_VERSION = 1;
const ENVELOPE_VERSION = 1;
const CACHE_SUBDIR = 'pages';
const PRUNE_INTERVAL_MS = 30_000;

const zstdCompress = typeof zlib.zstdCompress === 'function' ? promisify(zlib.zstdCompress) : null;
const zstdDecompress = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null;
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

async function encode(text) {
  if (zstdCompress !== null) {
    try {
      return { ext: '.zst', data: await zstdCompress(Buffer.from(text, 'utf8')) };
    } catch {}
  }
  return { ext: '.gz', data: await gzip(Buffer.from(text, 'utf8')) };
}

async function decode(ext, data) {
  const raw = ext === '.zst'
    ? (zstdDecompress !== null ? await zstdDecompress(data) : undefined)
    : await gunzip(data);
  if (raw === undefined) throw new Error('no zstd decoder');
  return raw.toString('utf8');
}

/**
 * @param {object} options
 * @param {object} options.persistence persistence service (stat source)
 * @param {string} options.dir cache directory (already resolved)
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxFiles]
 * @param {boolean} [options.debug]
 * @param {object} [options.logger]
 * @param {object} [options.state]
 */
export function createPageCache(options) {
  const { persistence, dir, maxBytes = 96 * 1024 * 1024, maxFiles = 400, debug = false, logger, state } = options || {};
  const enabled = Boolean(persistence) && typeof persistence.stat === 'function' && typeof persistence.open === 'function';
  const stats = { hits: 0, misses: 0, writes: 0, invalid: 0, errors: 0, dropped: 0 };
  const root = path.join(dir, CACHE_SUBDIR);
  let lastPrune = 0;
  let writeChain = Promise.resolve();

  const iso = () => new Date().toISOString();

  function cacheCandidates(key) {
    return [path.join(root, key + '.json.zst'), path.join(root, key + '.json.gz')];
  }

  /**
   * A cached page is only reusable when it is a complete opening snapshot whose
   * tail record still sits on the stored cursor. An entry that carries no
   * records, or whose records no longer end where the cursor says, would make
   * the client install an empty window; treat it as a miss and rebuild.
   * @param {object} opening stored opening snapshot
   * @returns {boolean}
   */
  function usableOpening(opening) {
    if (!opening || opening.type !== 'snapshot' || !Array.isArray(opening.records)) return false;
    if (opening.records.length === 0) return false;
    const tail = opening.records[opening.records.length - 1];
    const event = tail && typeof tail === 'object' ? (tail.type === 'event' ? tail.event : tail) : null;
    const tailSeq = event && typeof event.seq === 'number' ? event.seq : null;
    if (tailSeq === null) return false;
    if (Number.isFinite(opening.cursor) && tailSeq !== opening.cursor) return false;
    return true;
  }

  async function readEntry(file) {
    const base = file.endsWith('.zst') ? '.zst' : '.gz';
    const data = await fsp.readFile(file);
    const text = await decode(base, data);
    return JSON.parse(text);
  }

  /**
   * Resolve the stored revision for one Session and try to load a matching page.
   * @param {string} sessionId
   * @param {string} variant page window + trim configuration signature
   * @returns {Promise<{hit: boolean, revision?: string, key?: string, opening?: object}>}
   */
  async function lookup(sessionId, variant) {
    if (!enabled) return { hit: false };
    let observed;
    try {
      observed = await persistence.stat(sessionId);
    } catch {
      stats.errors += 1;
      return { hit: false };
    }
    const revision = observed && observed.revision;
    if (!revision) return { hit: false };
    const key = digest(JSON.stringify([PAGE_CACHE_VERSION, sessionId, String(revision), variant]));
    try {
      let file;
      let entry;
      let corrupt;
      for (const candidate of cacheCandidates(key)) {
        try {
          entry = await readEntry(candidate);
          file = candidate;
          break;
        } catch (error) {
          if (error && error.code === 'ENOENT') continue;
          corrupt = candidate;
          break;
        }
      }
      if (corrupt !== undefined) {
        stats.invalid += 1;
        void fsp.rm(corrupt, { force: true }).catch(() => {});
        return { hit: false, revision, key };
      }
      if (entry === undefined) return { hit: false, revision, key };
      if (!entry || entry.v !== ENVELOPE_VERSION || entry.sid !== sessionId || String(entry.rev) !== String(revision) || entry.key !== key || !entry.opening || typeof entry.opening !== 'object') {
        stats.invalid += 1;
        if (file !== undefined) void fsp.rm(file, { force: true }).catch(() => {});
        return { hit: false, revision, key };
      }
      if (!usableOpening(entry.opening)) {
        stats.invalid += 1;
        if (file !== undefined) void fsp.rm(file, { force: true }).catch(() => {});
        if (debug) process.stderr.write('[fl] page cache unusable opening, rebuilding\n');
        return { hit: false, revision, key };
      }
      stats.hits += 1;
      if (debug) process.stderr.write('[fl] page cache hit ' + entry.at + ' rev=' + revision + '\n');
      return { hit: true, revision, key, opening: entry.opening };
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) {
        stats.errors += 1;
        if (debug) process.stderr.write('[fl] page cache read failed: ' + error + '\n');
      }
      return { hit: false, revision, key };
    }
  }

  async function prune() {
    const now = Date.now();
    if (now - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = now;
    try {
      const names = await fsp.readdir(root);
      const files = [];
      let total = 0;
      for (const name of names) {
        try {
          const stat = await fsp.stat(path.join(root, name));
          files.push({ name, mtime: stat.mtimeMs, size: stat.size });
          total += stat.size;
        } catch {}
      }
      files.sort((a, b) => a.mtime - b.mtime);
      let live = files.length;
      for (const file of files) {
        if (total <= maxBytes && live <= maxFiles) break;
        await fsp.rm(path.join(root, file.name), { force: true }).catch(() => {});
        total -= file.size;
        live -= 1;
      }
    } catch {}
  }

  /**
   * Store one final opening snapshot. Never awaited by the request path.
   * @param {string} sessionId
   * @param {string|undefined} revision revision observed before the build
   * @param {string} key
   * @param {object} opening
   */
  function store(sessionId, revision, key, opening) {
    if (!enabled || typeof revision !== 'string' || revision === '' || !key || !opening) return;
    writeChain = writeChain.then(async () => {
      try {
        const text = JSON.stringify({ v: ENVELOPE_VERSION, sid: sessionId, rev: String(revision), key, at: iso(), opening });
        const encoded = await encode(text);
        await fsp.mkdir(root, { recursive: true });
        const target = path.join(root, key + '.json' + encoded.ext);
        const tmp = target + '.tmp-' + process.pid;
        await fsp.writeFile(tmp, encoded.data);
        await fsp.rename(tmp, target);
        stats.writes += 1;
        void prune();
        if (debug) process.stderr.write('[fl] page cache write ' + key + ' ' + encoded.data.length + 'B rev=' + revision + '\n');
      } catch (error) {
        stats.errors += 1;
        if (debug) process.stderr.write('[fl] page cache write failed: ' + error + '\n');
      }
    });
  }

  function evict(key) {
    if (!key) return;
    stats.dropped += 1;
    for (const candidate of cacheCandidates(key)) void fsp.rm(candidate, { force: true }).catch(() => {});
  }

  const api = {
    /** Format generation; consumers (idle refresh) refuse unknown versions. */
    version: PAGE_CACHE_VERSION,
    enabled,
    dir: root,
    stats,
    lookup,
    store,
    evict,
    /** Wait for pending writes (tests + shutdown). */
    async flush() { await writeChain; },
    snapshot() { return { ...stats, enabled, dir: root }; },
  };
  if (state) state.pageCache = api;
  if (debug) {
    try { logger?.info?.('[dsh-fastload] page cache on: ' + root); } catch {}
  }
  return api;
}

/** Remove one cache file by key (async, best effort). */
export function removeCacheFile(dir, key) {
  for (const ext of ['.json.zst', '.json.gz']) {
    try { fs.rmSync(path.join(dir, CACHE_SUBDIR, key + ext), { force: true }); } catch {}
  }
}
