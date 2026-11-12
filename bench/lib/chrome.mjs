import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, findListenerPid, killTree, waitPortFree, waitFor, fetchWithTimeout, rmrf } from './util.mjs';

export function resolveChrome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.CHROME_PATH) return path.resolve(process.env.CHROME_PATH);
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  throw new Error('cannot locate Chrome/Edge; pass --chrome or set CHROME_PATH');
}

export class HeadlessChrome {
  constructor({ port, userDataDir, chromePath, outDir }) {
    this.port = port;
    this.userDataDir = path.resolve(userDataDir);
    this.chromePath = resolveChrome(chromePath);
    this.outDir = outDir;
    this.pid = null;
    this.browserWsUrl = null;
  }

  async start() {
    await ensureDir(this.outDir);
    if (await findListenerPid(this.port)) throw new Error('CDP port ' + this.port + ' already in use');
    await rmrf(this.userDataDir);
    await ensureDir(this.userDataDir);
    const stdoutPath = path.join(this.outDir, 'chrome.out.log');
    const stderrPath = path.join(this.outDir, 'chrome.err.log');
    const out = fs.createWriteStream(stdoutPath, { flags: 'a' });
    const err = fs.createWriteStream(stderrPath, { flags: 'a' });
    out.on('error', () => {});
    err.on('error', () => {});
    const safeWrite = (stream, chunk) => {
      if (!stream.writableEnded && !stream.destroyed) stream.write(chunk);
    };
    this.outStream = out;
    this.errStream = err;
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--window-size=1280,900',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + this.userDataDir,
      '--remote-debugging-port=' + this.port,
      '--remote-allow-origins=*',
      'about:blank',
    ];
    const child = spawn(this.chromePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pid = child.pid;
    child.stdout.on('data', (d) => safeWrite(out, d));
    child.stderr.on('data', (d) => safeWrite(err, d));
    try {
      const version = await waitFor(async () => {
        const r = await fetchWithTimeout('http://127.0.0.1:' + this.port + '/json/version', {}, 3000);
        if (!r.ok) return null;
        return r.json();
      }, { timeoutMs: 30000, intervalMs: 200, label: 'chrome devtools endpoint' });
      this.browserWsUrl = version.webSocketDebuggerUrl;
      this.version = version;
      return this;
    } catch (e) {
      await this.stop().catch(() => {});
      throw new Error('chrome start failed: ' + e.message);
    }
  }

  async stop({ keepProfile = false } = {}) {
    if (this.pid) await killTree(this.pid);
    const listener = await findListenerPid(this.port);
    if (listener) await killTree(listener);
    await waitPortFree(this.port, 15000);
    for (const stream of [this.outStream, this.errStream]) {
      if (stream && !stream.writableEnded) stream.end();
    }
    this.outStream = null;
    this.errStream = null;
    this.pid = null;
    this.child = null;
    if (!keepProfile) await rmrf(this.userDataDir).catch(() => {});
  }
}
