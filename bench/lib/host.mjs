import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, findListenerPid, killTree, waitPortFree, waitFor, fetchWithTimeout, readFrom } from './util.mjs';

const TOKEN_RE = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._~-]+)/;

export function resolveDshBin(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_BIN) return path.resolve(process.env.DSH_BIN);
  const userProfile = process.env.USERPROFILE || '';
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(localAppData, 'Programs', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  throw new Error('cannot locate @deepseek-ai/dsh/lib/bin.js; pass --dsh-bin or set DSH_BIN');
}

export class DshHost {
  constructor({ home, port, workspace, dshBin, outDir, label = 'host', extraEnv = {} }) {
    this.home = path.resolve(home);
    this.port = port;
    this.workspace = path.resolve(workspace);
    this.dshBin = resolveDshBin(dshBin);
    this.outDir = outDir;
    this.label = label;
    this.extraEnv = extraEnv;
    this.pid = null;
    this.launcherPid = null;
    this.tokenUrl = null;
    this.stdoutPath = path.join(outDir, label + '.out.log');
    this.stderrPath = path.join(outDir, label + '.err.log');
    this.startCount = 0;
  }

  get serveLogPath() { return path.join(this.home, 'cache', 'dsh-fastload', 'serve.log'); }

  async start() {
    await ensureDir(this.outDir);
    const existing = await findListenerPid(this.port);
    if (existing) throw new Error('port ' + this.port + ' already in use by pid ' + existing);
    this.startCount += 1;
    const out = fs.createWriteStream(this.stdoutPath, { flags: 'a' });
    const err = fs.createWriteStream(this.stderrPath, { flags: 'a' });
    out.on('error', () => {});
    err.on('error', () => {});
    const safeWrite = (stream, chunk) => {
      if (!stream.writableEnded && !stream.destroyed) stream.write(chunk);
    };
    this.outStream = out;
    this.errStream = err;
    out.write('\n=== start ' + new Date().toISOString() + ' ===\n');
    err.write('\n=== start ' + new Date().toISOString() + ' ===\n');

    const env = {
      ...process.env,
      ...this.extraEnv,
      DSH_HOME: this.home,
      DSH_FASTLOAD_DEBUG: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
    const child = spawn(process.execPath, [this.dshBin, 'web', '--no-open', '--port', String(this.port)], {
      cwd: this.workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.launcherPid = child.pid;
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    let buffer = '';
    const consume = (chunk) => {
      buffer += chunk.toString();
      const match = TOKEN_RE.exec(buffer);
      if (match && !this.tokenUrl) this.tokenUrl = match[1];
    };
    child.stdout.on('data', (d) => { safeWrite(out, d); consume(d); });
    child.stderr.on('data', (d) => { safeWrite(err, d); consume(d); });

    try {
      await waitFor(() => this.tokenUrl, { timeoutMs: 90000, intervalMs: 100, label: 'dsh web token' });
      const listener = await waitFor(() => findListenerPid(this.port), { timeoutMs: 30000, intervalMs: 100, label: 'dsh listener on ' + this.port });
      this.pid = listener;
      const response = await fetchWithTimeout(this.tokenUrl, { redirect: 'manual' }, 15000);
      if (![200, 303, 302, 307, 401].includes(response.status)) {
        throw new Error('unexpected token URL status ' + response.status);
      }
      await new Promise((r) => setTimeout(r, 300));
      return this;
    } catch (e) {
      const details = exited ? ' (child exited ' + JSON.stringify(exited) + ')' : '';
      await this.stop().catch(() => {});
      throw new Error('host start failed' + details + ': ' + e.message);
    }
  }

  async stop() {
    const pids = new Set();
    if (this.pid) pids.add(this.pid);
    const listener = await findListenerPid(this.port);
    if (listener) pids.add(listener);
    if (this.launcherPid) pids.add(this.launcherPid);
    for (const pid of pids) await killTree(pid);
    await waitPortFree(this.port, 15000);
    for (const stream of [this.outStream, this.errStream]) {
      if (stream && !stream.writableEnded) stream.end();
    }
    this.outStream = null;
    this.errStream = null;
    this.pid = null;
    this.launcherPid = null;
    this.child = null;
    this.tokenUrl = null;
  }

  async readServeLog(offset = 0) {
    return readFrom(this.serveLogPath, offset);
  }

  async readStderr(offset = 0) {
    return readFrom(this.stderrPath, offset);
  }

  async currentServeOffset() {
    try { return (await fsp.stat(this.serveLogPath)).size; } catch { return 0; }
  }

  async currentStderrOffset() {
    try { return (await fsp.stat(this.stderrPath)).size; } catch { return 0; }
  }
}
