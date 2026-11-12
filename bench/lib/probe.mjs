/**
 * Injected at document-start into every measured page.
 *
 * It deliberately does not parse the first snapshot JSON: the page main thread
 * must stay free while the transcript is rendering. Byte counts and record
 * counts come from the CDP Network domain in Node. This probe only records
 * timestamps, cheap string fingerprints, layout facts and Long Task entries.
 */
export function installProbe(cfg) {
  if (window.__BENCH__) return;
  const B = (window.__BENCH__ = {
    version: 1,
    startedAt: performance.now(),
    errors: [],
    snapshots: [],
    follows: [],
    commits: [],
    longTasks: [],
    fcpAt: null,
    clickAt: null,
    clickSid: null,
    preClick: null,
    followSentAt: null,
    followRequest: null,
    targetSnapshotAt: null,
    targetSnapshotChars: 0,
    firstRowAt: null,
    firstRow: null,
    domNodesAtFirstRow: null,
    flowChildrenAtFirstRow: null,
    timeoutAt: null,
  });

  B.firstRowPromise = new Promise((resolve) => { B._resolveFirstRow = resolve; });

  function noteError(where, error) {
    try { B.errors.push(where + ': ' + String(error && error.message ? error.message : error)); } catch {}
  }

  try {
    localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: cfg.blankSessionId }));
  } catch (error) { noteError('localStorage', error); }

  window.addEventListener('error', (e) => noteError('window.error', e.message || e.error));
  window.addEventListener('unhandledrejection', (e) => noteError('unhandledrejection', e.reason));

  // A minimal React DevTools hook. Production React still calls onCommitFiberRoot
  // when this global exists; if the app installed its own hook we only wrap it.
  if (cfg.reactHook !== false) {
    try {
      let hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook) {
        const renderers = new Map();
        let nextRenderer = 1;
        hook = {
          supportsFiber: true,
          supportsFlight: true,
          renderers,
          inject(renderer) { const id = nextRenderer++; renderers.set(id, renderer); return id; },
          onCommitFiberRoot() { B.commits.push(performance.now()); },
          onCommitFiberUnmount() {},
          onPostCommitFiberRoot() {},
          checkDCE() {},
        };
        Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
          value: hook, configurable: true, enumerable: false, writable: false,
        });
      } else if (typeof hook.onCommitFiberRoot === 'function') {
        const original = hook.onCommitFiberRoot.bind(hook);
        hook.onCommitFiberRoot = function (...args) {
          B.commits.push(performance.now());
          return original(...args);
        };
      }
    } catch (error) { noteError('reactHook', error); }
  }

  // Timestamp the exact follow send and the exact target snapshot delivery.
  // Wrapping the constructor is less invasive than replacing WebSocket.prototype.
  try {
    const NativeWebSocket = window.WebSocket;
    function BenchWebSocket(url, protocols) {
      const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      const nativeSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          if (B.clickAt !== null && typeof data === 'string' && data.indexOf('"endpoint":"session/follow"') >= 0) {
            const msg = JSON.parse(data);
            if (msg && msg.endpoint === 'session/follow') {
              const request = msg.payload && msg.payload.args && msg.payload.args.request;
              const sid = request && request.address && request.address.sessionId;
              const at = performance.now();
              B.follows.push({ at, sid: sid || null });
              if (sid === cfg.targetSessionId && B.followSentAt === null) {
                B.followSentAt = at;
                B.followRequest = request;
              }
            }
          }
        } catch (error) { noteError('ws.send', error); }
        return nativeSend(data);
      };
      ws.addEventListener('message', (ev) => {
        try {
          const data = ev.data;
          if (typeof data !== 'string' || data.length < 80) return;
          if (data.slice(0, 64).indexOf('"type":"item"') < 0) return;
          if (data.indexOf('"type":"snapshot"') < 0) return;
          const at = performance.now();
          const headerAt = data.indexOf('"header":');
          const head = data.slice(headerAt >= 0 ? headerAt : 0, (headerAt >= 0 ? headerAt : 0) + 500);
          const match = /"id":"(session-[^"]+)"/.exec(head);
          const sid = match ? match[1] : null;
          B.snapshots.push({ at, chars: data.length, sid });
          if (sid === cfg.targetSessionId && B.targetSnapshotAt === null) {
            B.targetSnapshotAt = at;
            B.targetSnapshotChars = data.length;
          }
        } catch (error) { noteError('ws.message', error); }
      });
      return ws;
    }
    BenchWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) BenchWebSocket[key] = NativeWebSocket[key];
    Object.defineProperty(window, 'WebSocket', { value: BenchWebSocket, configurable: true, writable: true });
  } catch (error) { noteError('websocketPatch', error); }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        B.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (error) { noteError('longtaskObserver', error); }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint' && B.fcpAt === null) B.fcpAt = entry.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
  } catch (error) { noteError('paintObserver', error); }

  function findScrollBox(flow) {
    let node = flow;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.clientHeight > 0) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function firstVisibleRow() {
    const flow = document.querySelector('[data-slot="conversation.chat.flow"]');
    if (!flow) return null;
    const box = findScrollBox(flow);
    if (!box) return null;
    const br = box.getBoundingClientRect();
    const children = Array.from(flow.children);
    for (let index = 0; index < children.length; index += 1) {
      const el = children[index];
      if (!(el instanceof HTMLElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.width <= 0) continue;
      if (r.bottom <= br.top + 0.5 || r.top >= br.bottom - 0.5) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      return { el, index, box, boxRect: br, rect: r, children: children.length };
    }
    return null;
  }

  function startWatch() {
    if (B.watchStarted) return;
    B.watchStarted = true;
    const tick = () => {
      if (B.targetSnapshotAt !== null && B.firstRowAt === null) {
        try {
          const hit = firstVisibleRow();
          if (hit) {
            B.firstRowAt = performance.now();
            B.firstRow = {
              index: hit.index,
              kind: hit.el.getAttribute('data-chat-flow-kind'),
              height: hit.rect.height,
              width: hit.rect.width,
              topInViewport: hit.rect.top - hit.boxRect.top,
              bottomInViewport: hit.rect.bottom - hit.boxRect.top,
              textLength: (hit.el.textContent || '').length,
              scrollTop: hit.box.scrollTop,
              scrollHeight: hit.box.scrollHeight,
              clientHeight: hit.box.clientHeight,
              boxTag: hit.box.tagName,
              boxClass: String(hit.box.className || '').slice(0, 120),
            };
            B.domNodesAtFirstRow = document.getElementsByTagName('*').length;
            B.flowChildrenAtFirstRow = hit.children;
            B._resolveFirstRow(B.summary());
            return;
          }
        } catch (error) { noteError('firstRow', error); }
      }
      if (B.clickAt !== null && performance.now() - B.clickAt > cfg.timeoutMs) {
        B.timeoutAt = performance.now();
        B._resolveFirstRow(B.summary());
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  window.addEventListener('click', (event) => {
    try {
      const target = event.target && event.target.closest ? event.target.closest('[data-row-key^="session:"]') : null;
      if (!target) return;
      const key = target.getAttribute('data-row-key') || '';
      const sid = key.slice('session:'.length);
      if (sid !== cfg.targetSessionId) return;
      if (B.clickAt !== null) return;
      B.clickAt = performance.now();
      B.clickSid = sid;
      const flow = document.querySelector('[data-slot="conversation.chat.flow"]');
      B.preClick = {
        flowTextLength: flow ? (flow.textContent || '').length : 0,
        flowChildren: flow ? flow.children.length : 0,
        storedSession: localStorage.getItem('dsh.sessions.current'),
      };
      startWatch();
    } catch (error) { noteError('click', error); }
  }, true);

  B.summary = () => ({
    version: B.version,
    startedAt: B.startedAt,
    errors: B.errors.slice(0, 20),
    clickAt: B.clickAt,
    clickSid: B.clickSid,
    preClick: B.preClick,
    followSentAt: B.followSentAt,
    followRequest: B.followRequest,
    targetSnapshotAt: B.targetSnapshotAt,
    targetSnapshotChars: B.targetSnapshotChars,
    snapshots: B.snapshots.slice(-10),
    follows: B.follows.slice(-10),
    firstRowAt: B.firstRowAt,
    firstRow: B.firstRow,
    domNodesAtFirstRow: B.domNodesAtFirstRow,
    flowChildrenAtFirstRow: B.flowChildrenAtFirstRow,
    timeoutAt: B.timeoutAt,
    fcpAt: B.fcpAt,
    longTasks: B.longTasks.slice(),
    commits: B.commits.slice(),
    nav: (() => {
      try {
        const t = performance.getEntriesByType('navigation')[0];
        return t ? { startTime: t.startTime, domContentLoaded: t.domContentLoadedEventEnd, load: t.loadEventEnd, responseEnd: t.responseEnd } : null;
      } catch { return null; }
    })(),
  });
}
