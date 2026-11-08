export const DEFAULTS = Object.freeze({
  enabled: true,
  force: false,
  maxMessages: 100,
  minMessages: 40,
  minTurns: 2,
  maxBytes: 0,
  hardCapBytes: 8 * 1024 * 1024,
  debug: false,
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

  return {
    enabled: readBool(env, 'DSH_FASTLOAD_ENABLED', DEFAULTS.enabled),
    force: readBool(env, 'DSH_FASTLOAD_FORCE', DEFAULTS.force),
    maxMessages,
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
    debug: readBool(env, 'DSH_FASTLOAD_DEBUG', DEFAULTS.debug),
  };
}
