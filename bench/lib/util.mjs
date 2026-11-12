import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const execFileAsync = promisify(execFile);

export const BENCH_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const REPO_ROOT = path.resolve(BENCH_DIR, '..');

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

export async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export async function readTextIfExists(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return ''; }
}

export async function readFrom(p, offset) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st) return { text: '', next: offset };
  if (st.size < offset) offset = 0;
  const fh = await fsp.open(p, 'r');
  try {
    const length = Math.max(0, st.size - offset);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, offset);
    return { text: buf.toString('utf8'), next: st.size };
  } finally {
    await fh.close();
  }
}

export async function listFiles(dir) {
  try {
    const names = await fsp.readdir(dir);
    const out = [];
    for (const name of names) {
      const p = path.join(dir, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.isFile()) out.push({ name, path: p, size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  } catch { return []; }
}

export async function findListenerPid(port) {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== 'TCP') continue;
      const local = parts[1];
      if (!local.endsWith(':' + port)) continue;
      if (parts[3] !== 'LISTENING') continue;
      const pid = Number(parts[4]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {}
  return null;
}

export async function waitPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await findListenerPid(port))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !(await findListenerPid(port));
}

export async function killTree(pid) {
  if (!pid) return;
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch {}
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) { lastError = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('timeout waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
}

export function round(n, digits = 3) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function maskSession(id) {
  if (typeof id !== 'string') return id;
  const m = /^session-([0-9a-f]{8})/.exec(id);
  return m ? 'session-' + m[1] + '-****' : id.slice(0, 12) + '****';
}

export function median(values) {
  const a = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function quantile(values, q) {
  const a = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return a[base + 1] !== undefined ? a[base] + rest * (a[base + 1] - a[base]) : a[base];
}

export function summarize(values) {
  const a = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!a.length) return { n: 0, median: null, min: null, max: null, p25: null, p75: null, mean: null };
  const sum = a.reduce((x, y) => x + y, 0);
  return {
    n: a.length,
    median: round(median(a), 3),
    min: round(Math.min(...a), 3),
    max: round(Math.max(...a), 3),
    p25: round(quantile(a, 0.25), 3),
    p75: round(quantile(a, 0.75), 3),
    mean: round(sum / a.length, 3),
  };
}

export function timestampForPath(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}
