export const DEFAULTS = Object.freeze({
  enabled: true,
  force: false,
  maxMessages: 100,
  // A running Session is opened to watch the tail: a tool-heavy turn turns a
  // 100-message page into megabytes of records, so the running window is much
  // smaller and is refilled by the built-in "load older" pager.
  runningMaxMessages: 24,
  minMessages: 40,
  minTurns: 2,
  maxBytes: 0,
  hardCapBytes: 8 * 1024 * 1024,
  scanCache: true,
  stripStream: true,
  pageCache: true,
  // A page served while the Agent is producing text is invalidated by the next
  // stream frame. Skipping the cache for the running window avoids writing
  // doomed pages and dropping them (full resync) on the next open.
  runningPageCache: false,
  idleCacheRefresh: false,
  deferLiveBuild: true,
  rewindAware: true,
  pageCacheMaxBytes: 96 * 1024 * 1024,
  pageCacheMaxFiles: 400,
  cacheDir: '',
  debug: false,
  serveLog: true,
});

function readInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

export function readConfig(env = process.env) {
  const maxMessages = readInt(env, 'DSH_FASTLOAD_MAX_MESSAGES', DEFAULTS.maxMessages, 1, 10_000);
  const minMessages = Math.min(
    readInt(env, 'DSH_FASTLOAD_MIN_MESSAGES', DEFAULTS.minMessages, 1, 10_000),
    maxMessages
  );
  const maxBytesRaw = readInt(env, 'DSH_FASTLOAD_MAX_BYTES', DEFAULTS.maxBytes, 0, 64 * 1024 * 1024);
  const runningMaxMessages = readInt(
    env,
    'DSH_FASTLOAD_RUNNING_MAX_MESSAGES',
    DEFAULTS.runningMaxMessages,
    1,
    10_000
  );

  return {
    enabled: readBool(env, 'DSH_FASTLOAD_ENABLED', DEFAULTS.enabled),
    force: readBool(env, 'DSH_FASTLOAD_FORCE', DEFAULTS.force),
    maxMessages,
    runningMaxMessages,
    minMessages,
    minTurns: readInt(env, 'DSH_FASTLOAD_MIN_TURNS', DEFAULTS.minTurns, 1, 100),
    maxBytes: maxBytesRaw > 0 ? Math.max(maxBytesRaw, 64 * 1024) : 0,
    hardCapBytes: readInt(
      env,
      'DSH_FASTLOAD_HARD_CAP_BYTES',
      DEFAULTS.hardCapBytes,
      256 * 1024,
      64 * 1024 * 1024
    ),
    scanCache: readBool(env, 'DSH_FASTLOAD_SCAN_CACHE', DEFAULTS.scanCache),
    stripStream: readBool(env, 'DSH_FASTLOAD_STRIP_STREAM', DEFAULTS.stripStream),
    pageCache: readBool(env, 'DSH_FASTLOAD_PAGE_CACHE', DEFAULTS.pageCache),
    runningPageCache: readBool(
      env,
      'DSH_FASTLOAD_RUNNING_PAGE_CACHE',
      DEFAULTS.runningPageCache
    ),
    idleCacheRefresh: readBool(env, 'DSH_FASTLOAD_IDLE_CACHE_REFRESH', DEFAULTS.idleCacheRefresh),
    deferLiveBuild: readBool(env, 'DSH_FASTLOAD_DEFER_LIVE_BUILD', DEFAULTS.deferLiveBuild),
    pageCacheMaxBytes: readInt(
      env,
      'DSH_FASTLOAD_PAGE_CACHE_BYTES',
      DEFAULTS.pageCacheMaxBytes,
      1024 * 1024,
      2 * 1024 * 1024 * 1024
    ),
    pageCacheMaxFiles: readInt(env, 'DSH_FASTLOAD_PAGE_CACHE_FILES', DEFAULTS.pageCacheMaxFiles, 1, 10_000),
    cacheDir: env.DSH_FASTLOAD_CACHE_DIR && env.DSH_FASTLOAD_CACHE_DIR.trim() !== '' ? env.DSH_FASTLOAD_CACHE_DIR.trim() : DEFAULTS.cacheDir,
    debug: readBool(env, 'DSH_FASTLOAD_DEBUG', DEFAULTS.debug),
    serveLog: readBool(env, 'DSH_FASTLOAD_SERVE_LOG', DEFAULTS.serveLog),
    rewindAware: readBool(env, 'DSH_FASTLOAD_REWIND_AWARE', DEFAULTS.rewindAware),
  };
}
