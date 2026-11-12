import { setTimeout as delay } from 'node:timers/promises';

function parseData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return String(data);
}

/** Minimal Chrome DevTools Protocol client over Node's global WebSocket. */
export class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async connect(url, timeoutMs = 15000) {
    const c = new Cdp(url);
    c.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout: ' + url)), timeoutMs);
      c.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      c.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error: ' + url)); }, { once: true });
    });
    c.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(parseData(ev.data)); } catch { return; }
      if (msg.id !== undefined) {
        const p = c.pending.get(msg.id);
        if (!p) return;
        c.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP ${p.method}: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of c.listeners.get(msg.method) ?? []) {
          try { fn(msg.params, msg); } catch {}
        }
      }
    });
    c.ws.addEventListener('close', () => {
      c.closed = true;
      for (const p of c.pending.values()) p.reject(new Error('CDP websocket closed'));
      c.pending.clear();
    });
    return c;
  }

  on(method, fn) {
    const arr = this.listeners.get(method) ?? [];
    arr.push(fn);
    this.listeners.set(method, arr);
    return () => this.listeners.set(method, (this.listeners.get(method) ?? []).filter((x) => x !== fn));
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP websocket already closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

export async function httpJson(port, route, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`${route}: HTTP ${r.status} ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export async function listTargets(port) {
  return httpJson(port, '/json/list');
}

export async function newPage(port, url = 'about:blank') {
  const target = await httpJson(port, `/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  return { target, cdp };
}

export async function closeTarget(port, targetId) {
  try { await httpJson(port, `/json/close/${encodeURIComponent(targetId)}`); } catch {}
}

export async function evalJs(cdp, expression, { awaitPromise = false, timeoutMs = 30000, returnByValue = true } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue,
    awaitPromise,
    userGesture: false,
  }, timeoutMs);
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.exception?.description || r.exceptionDetails.text || JSON.stringify(r.exceptionDetails);
    throw new Error('page evaluate failed: ' + text.slice(0, 2000));
  }
  return r.result ? r.result.value : undefined;
}

export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) { lastError = e; }
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

export { delay as sleep };
