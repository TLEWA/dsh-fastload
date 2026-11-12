/**
 * dsh-fastload — browser half.
 *
 * The host half opens a long session with a smaller first history page. On a
 * short session that page can be shorter than the viewport, so the user sees
 * less history than stock DSH would show at the bottom. This module fills that
 * gap once, after the first paint and while the user is idle, by pressing the
 * built-in "Load older" button.
 *
 * It deliberately reuses the chat's own button instead of calling
 * session.loadOlder(): the button runs ChatNavigation.loadEarlier(), which
 * begins the viewport paging anchor and pauses tail-following. A direct
 * loadOlder() call would prepend rows without that anchor compensation.
 *
 * Scope: one extra page per mounted transcript, only when the transcript is
 * not scrollable (scrollHeight <= clientHeight). If the first page already
 * scrolls, the newest content is already at the bottom and adding older rows
 * would only cost work without changing what the user sees.
 *
 * Diagnostics: the module keeps a small ring buffer of uncaught errors,
 * unhandled rejections and console.error calls, so a transcript that renders
 * empty can be explained afterwards. `window.__DSH_FASTLOAD__.probe()` returns
 * the whole picture (flow geometry, slot-error boundaries, scroll box, buffered
 * errors) and copies it to the clipboard; the buffer is also printed once when
 * an empty transcript with "Load older" is detected.
 */

(() => {
  const MODULE_ID = 'dsh-fastload';
  const AUTOLOAD_DELAY_MS = 900;
  const RETRY_MS = 700;
  const MAX_ATTEMPTS = 8;
  const INPUT_IDLE_MS = 1500;
  const SCROLL_SLACK_PX = 16;
  const FLOW_SLOT = 'conversation.chat.flow';
  const MAX_ERRORS = 24;
  // A transcript that installs a page cursor (hasMore) but renders no rows is
  // unusable: the page button cannot recover it and the window cannot scroll.
  // Reopening the session rebuilds the window once; the cooldown keeps a
  // deterministic failure from turning that recovery into a reload loop.
  const HEAL_KEY = 'dsh-fastload:heal:';
  const HEAL_COOLDOWN_MS = 10 * 60 * 1000;
  const AUTOFIX_KEY = 'dsh-fastload.autofix';
  // Every served module instance stamps its build id into the probe payload:
  // two instances of this client can coexist while a page is being rebuilt,
  // and a stale one would answer the probe with old logic.
  const BUILD = 'v19';
// Instrumentation patches hot paths (assembler flush, chat builder replace),
// so it stays off unless explicitly asked for: localStorage
// 'dsh-fastload.debug' = '1', or window.__DSH_FASTLOAD_DEBUG__ = true.
const DEBUG = (() => {
  try {
    return localStorage.getItem('dsh-fastload.debug') === '1' || window.__DSH_FASTLOAD_DEBUG__ === true;
  } catch {
    return false;
  }
})();
  // A blank transcript can repair itself (the window may be installed a moment
  // after the first frame), so the probe keeps a rolling timeline of what the
  // flow was handed: a sample taken after recovery still shows whether rows
  // ever existed and when they disappeared.
  const SAMPLE_MS = 400;
  const MAX_SAMPLES = 60;
  // A window is blank when the flow component was handed zero entries while
  // the page still advertises older history. Give the first frame time to
  // install before acting on it.
  const BLANK_GRACE_MS = 600;
  // The Session event feed publishes synchronously when a window is installed,
  // so a guard subscribed to it can reconcile the conversation in the same
  // task instead of on the next DOM poll. Coalesce bursts, and stop after a
  // few repairs so a genuinely empty page cannot spin.
  const GUARD_MIN_MS = 120;
  const GUARD_MAX_REBUILDS = 4;
  // An executed /rewind hides every row inside its cut. A page that lands
  // entirely inside a cut renders nothing and is not a broken window: the
  // surviving history is simply further back, so walking back is the repair.
  const ADVANCE_MAX = 4;
  const ADVANCE_GAP_MS = 700;
  // P6: hovering a sidebar row is the strongest hint about which session opens
  // next. A passive follow builds and caches the opening page off the critical
  // path, without activating the Agent (the host only promotes when
  // activate === true). Delayed, deduplicated and serialized so a fast sweep
  // down the list cannot start a fleet of log parses.
  const PREWARM_KEY = 'dsh-fastload.prewarm';
  const PREWARM_DELAY_MS = 150;
  const PREWARM_TTL_MS = 10 * 60 * 1000;
  const PREWARM_MAX_QUEUE = 4;
  // Stage 2: the persisted selection names the session this page will restore,
  // so its opening page can be built while the workspace/session lists are
  // still loading. This is opt-in (unlike the hover hint above) because it
  // costs one extra initial-page read on every page load. Values: '1' or true.
  const RESTORE_PREWARM_KEY = 'dsh-fastload.restore-prewarm';
  // Remember one successful warm per tab. A reload does not change the
  // persistence revision, so the disk page cache from the first warm is still
  // the one the native restore will use; warming again only adds Host work.
  const RESTORE_WARM_GUARD_KEY = 'dsh-fastload.restore-prewarm.at';
  const RESTORE_WARM_GUARD_MS = 60 * 1000;
  // uiWorkspace may activate shortly after this plugin. Wait for it briefly,
  // but never warm without its selection signal: a warm racing the native
  // restore would open the same page twice, and skipping is the safer fallback.
  const RESTORE_SIGNAL_RETRY_MS = 200;
  const RESTORE_SIGNAL_RETRIES = 10;
  const RESTORE_START_DELAY_MS = 0;

  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory() {
      return {
        inject: ['remote', 'remote.session'],
        apply(ctx) {
          if (typeof document === 'undefined') return;

          const samples = [];
          const state = {
            version: '0.2.1',
            scans: 0,
            loads: 0,
            skipped: 0,
            last: null,
            blank: null,
            healed: 0,
            heal: null,
            repairs: 0,
            advance: null,
            guard: null,
            stuck: [],
            error: null,
          };
          // Recovery attempts overwrite each other, so a single "heal" field
          // loses exactly the evidence that matters: the state before the first
          // repair. Keep the recent history next to it.
          const heals = [];
          let lastHeal = null;
          Object.defineProperty(state, 'heal', {
            get: () => lastHeal,
            set: (value) => {
              lastHeal = value;
              try {
                heals.push(value);
                while (heals.length > 8) heals.shift();
              } catch {}
            },
          });
          state.heals = heals;
          window.__DSH_FASTLOAD_CLIENT__ = state;

          ctx.effect(() => {
            const seen = new WeakSet();
            const blankHandled = new WeakSet();
            const blankFirstSeen = new WeakMap();
            const advanceState = new WeakMap();
            const advanceStateOf = (flow) => {
              let rec = advanceState.get(flow);
              if (!rec) {
                rec = { clicks: 0, at: 0 };
                advanceState.set(flow, rec);
              }
              return rec;
            };
            const timers = new Set();
            let lastInputAt = -Infinity;

            // P6 prewarm state. Everything is per-effect so a module reload
            // leaves no listeners, timers or in-flight streams behind.
            const prewarm = {
              at: null,
              sid: null,
              ms: null,
              ok: null,
              done: 0,
              failed: 0,
              skipped: 0,
              queued: 0,
              error: null,
            };
            state.prewarm = prewarm;
            const prewarmed = new Map();
            const prewarmQueue = [];
            let prewarmActive = null;
            let prewarmTimer = null;
            let prewarmPending = null;
            let disposed = false;

            // Stage 2 state. stage is one of disabled, waiting, queued,
            // running, shared, done, skipped, cancelled or failed; "shared"
            // means a hover warm for the same session already covers this
            // target. Nothing here is ever copied into a Session store.
            const restorePrewarm = {
              enabled: null,
              stage: 'waiting',
              sid: null,
              reason: null,
              at: null,
              ms: null,
            };
            state.restorePrewarm = restorePrewarm;
            let restoreWatch = null;
            let restoreSignalTimer = null;
            let restoreSignalAttempts = 0;

            const prewarmAllowed = () => {
              try {
                if (localStorage.getItem(PREWARM_KEY) === '0') return false;
              } catch {}
              return window.__DSH_FASTLOAD_PREWARM__ !== false;
            };
            // Stage 2: unlike the hover hint, the restore hint is off unless
            // explicitly enabled. The two switches deliberately have opposite
            // polarities, so a missing key can never turn this one on.
            const restorePrewarmAllowed = () => {
              try {
                if (localStorage.getItem(RESTORE_PREWARM_KEY) === '1') return true;
              } catch {}
              return window.__DSH_FASTLOAD_RESTORE_PREWARM__ === true;
            };
            const uiWorkspaceOf = () => {
              try {
                return ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
              } catch {
                return undefined;
              }
            };
            // The live main reference, not dsh.sessions.current: the persisted
            // selection already equals the restore target before anything opens.
            const mainSessionId = () => {
              try {
                const service = uiWorkspaceOf();
                const reference = service && service.mainReference;
                return reference && typeof reference.sessionId === 'string' ? reference.sessionId : null;
              } catch {
                return null;
              }
            };
            const stopRestoreWatch = () => {
              if (restoreWatch !== null) {
                try {
                  restoreWatch();
                } catch {}
                restoreWatch = null;
              }
              if (restoreSignalTimer !== null) {
                clearTimeout(restoreSignalTimer);
                timers.delete(restoreSignalTimer);
                restoreSignalTimer = null;
              }
            };
            const finishRestorePrewarm = (stage, reason) => {
              if (restorePrewarm.stage === 'done' || restorePrewarm.stage === 'cancelled') return;
              restorePrewarm.stage = stage;
              restorePrewarm.reason = reason === undefined ? null : reason;
              restorePrewarm.at = Date.now();
              stopRestoreWatch();
            };
            const cancelQueuedPrewarm = (sid, source) => {
              let removed = false;
              for (let index = prewarmQueue.length - 1; index >= 0; index -= 1) {
                const entry = prewarmQueue[index];
                if (entry.sid === sid && entry.source === source) {
                  prewarmQueue.splice(index, 1);
                  removed = true;
                }
              }
              if (removed) prewarm.queued = prewarmQueue.length;
              return removed;
            };
            const rowSessionId = (node) => {
              if (!node || typeof node.closest !== 'function') return null;
              const row = node.closest('[data-row-key^="session:"]');
              if (!row) return null;
              const key = row.getAttribute('data-row-key') || '';
              const id = key.slice('session:'.length);
              return id === '' ? null : id;
            };
            const remoteSession = () => {
              try {
                const remote = ctx ? ctx.remote : undefined;
                const session = remote && remote.session;
                return session && typeof session.follow === 'function' ? session : null;
              } catch {
                return null;
              }
            };
            const drainPrewarm = () => {
              if (disposed || prewarmActive !== null) return;
              while (prewarmQueue.length > 0) {
                const entry = prewarmQueue.shift();
                prewarm.queued = prewarmQueue.length;
                if (entry.source === 'restore') {
                  // dsh.sessions.current already holds the restore target, so
                  // currentSessionId() cannot distinguish "already open" from
                  // "saved but not restored yet". Only the live main reference
                  // proves the native view took the session over.
                  if (mainSessionId() === entry.sid) {
                    finishRestorePrewarm('skipped', 'already-open');
                    continue;
                  }
                } else if (entry.sid === currentSessionId()) {
                  continue;
                }
                void runPrewarm(entry.sid, entry.source);
                return;
              }
            };
            const runPrewarm = async (sid, source) => {
              const session = remoteSession();
              if (!session) {
                prewarm.skipped += 1;
                prewarm.error = 'remote.session.follow is unavailable';
                if (source === 'restore') finishRestorePrewarm('skipped', 'remote-unavailable');
                return;
              }
              const controller = new AbortController();
              prewarmActive = { sid, source, controller };
              const startedAt = Date.now();
              if (source === 'restore') {
                restorePrewarm.stage = 'running';
                restorePrewarm.at = startedAt;
              }
              try {
                const stream = session.follow(
                  {
                    address: { kind: 'session', sessionId: sid },
                    assistantStream: true,
                    activate: false,
                  },
                  controller.signal
                );
                const iterator = stream && typeof stream[Symbol.asyncIterator] === 'function'
                  ? stream[Symbol.asyncIterator]()
                  : stream;
                const first = await iterator.next();
                if (!first.done) {
                  prewarmed.set(sid, Date.now());
                  prewarm.done += 1;
                  prewarm.at = Date.now();
                  prewarm.sid = sid;
                  prewarm.ms = Date.now() - startedAt;
                  prewarm.ok = true;
                  if (source === 'restore') {
                    restorePrewarm.stage = 'done';
                    restorePrewarm.reason = null;
                    restorePrewarm.at = Date.now();
                    restorePrewarm.ms = Date.now() - startedAt;
                    markRestoreWarmed(sid);
                    stopRestoreWatch();
                  }
                } else {
                  prewarm.skipped += 1;
                  if (source === 'restore') finishRestorePrewarm('skipped', 'empty-page');
                }
                try {
                  await iterator.return?.();
                } catch {}
              } catch (error) {
                prewarm.failed += 1;
                prewarm.ok = false;
                prewarm.error = String((error && error.message) || error).slice(0, 200);
                if (source === 'restore') {
                  if (controller.signal.aborted) {
                    // A native open cancels the wait; keep that stage instead
                    // of reporting the resulting abort as a fresh failure.
                    if (restorePrewarm.stage !== 'cancelled') {
                      restorePrewarm.stage = 'cancelled';
                      restorePrewarm.reason = 'aborted';
                      restorePrewarm.at = Date.now();
                    }
                  } else {
                    finishRestorePrewarm('failed', prewarm.error);
                  }
                  stopRestoreWatch();
                }
              } finally {
                prewarmActive = null;
                drainPrewarm();
              }
            };
            const queuePrewarm = (sid, source) => {
              const origin = source === 'restore' ? 'restore' : 'hover';
              const now = Date.now();
              const last = prewarmed.get(sid);
              if (last !== undefined && now - last < PREWARM_TTL_MS) {
                prewarm.skipped += 1;
                if (origin === 'restore') finishRestorePrewarm('skipped', 'warm-cache-fresh');
                return;
              }
              if (prewarmActive !== null && prewarmActive.sid === sid) {
                if (origin === 'restore') finishRestorePrewarm('shared', 'already-running');
                return;
              }
              const queued = prewarmQueue.find((entry) => entry.sid === sid);
              if (queued !== undefined) {
                if (origin === 'restore') finishRestorePrewarm('shared', 'already-queued');
                return;
              }
              if (prewarmQueue.length >= PREWARM_MAX_QUEUE) {
                prewarm.skipped += 1;
                if (origin === 'restore') finishRestorePrewarm('skipped', 'queue-full');
                return;
              }
              prewarmQueue.push({ sid, source: origin });
              prewarm.queued = prewarmQueue.length;
              if (origin === 'restore') {
                restorePrewarm.stage = 'queued';
                restorePrewarm.reason = null;
              }
              drainPrewarm();
            };
            const cancelPendingPrewarm = () => {
              if (prewarmTimer !== null) {
                clearTimeout(prewarmTimer);
                timers.delete(prewarmTimer);
                prewarmTimer = null;
              }
              prewarmPending = null;
            };
            const onPrewarmOver = (event) => {
              if (!prewarmAllowed() || document.hidden) return;
              const sid = rowSessionId(event.target);
              if (sid === null || sid === currentSessionId()) return;
              if (prewarmPending === sid) return;
              cancelPendingPrewarm();
              prewarmPending = sid;
              prewarmTimer = setTimeout(() => {
                timers.delete(prewarmTimer);
                prewarmTimer = null;
                const target = prewarmPending;
                prewarmPending = null;
                if (target !== null) queuePrewarm(target);
              }, PREWARM_DELAY_MS);
              timers.add(prewarmTimer);
            };
            const onPrewarmOut = (event) => {
              const sid = rowSessionId(event.target);
              if (sid === null || sid !== prewarmPending) return;
              const next = rowSessionId(event.relatedTarget);
              if (next === sid) return;
              cancelPendingPrewarm();
            };
            document.addEventListener('pointerover', onPrewarmOver, { capture: true, passive: true });
            document.addEventListener('pointerout', onPrewarmOut, { capture: true, passive: true });
            document.addEventListener('focusin', onPrewarmOver, { capture: true });

            const noteInput = () => {
              lastInputAt = performance.now();
            };
            const inputEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
            for (const type of inputEvents) {
              document.addEventListener(type, noteInput, { capture: true, passive: true });
            }

            const scrollParentOf = (flow) => {
              for (let node = flow.parentElement; node; node = node.parentElement) {
                const overflowY = getComputedStyle(node).overflowY;
                if (overflowY === 'auto' || overflowY === 'scroll') return node;
              }
              return null;
            };

            const flowSlotOf = (flow) => {
              for (const child of flow.children) {
                if (child.getAttribute('data-slot') === FLOW_SLOT) return child;
              }
              return null;
            };

            const olderButtonOf = (flow) => {
              const slot = flowSlotOf(flow);
              if (!slot) return null;
              const older = slot.previousElementSibling;
              if (!older || older.nextElementSibling !== slot) return null;
              if (!/older/i.test(String(older.className || ''))) return null;
              const button = older.querySelector('button');
              return button instanceof HTMLButtonElement ? button : null;
            };

            const schedule = (flow, attempt) => {
              const timer = setTimeout(() => {
                timers.delete(timer);
                try {
                  if (!flow.isConnected || flow.hasAttribute('data-fastload-autoloaded')) return;
                  // A blank transcript already lost its window; pressing the page
                  // button would only leave it disabled forever.
                  if (flow.hasAttribute('data-fastload-blank')) return;
                  if (document.visibilityState === 'hidden') {
                    if (attempt < MAX_ATTEMPTS) schedule(flow, attempt + 1);
                    return;
                  }
                  if (performance.now() - lastInputAt < INPUT_IDLE_MS) {
                    if (attempt < MAX_ATTEMPTS) schedule(flow, attempt + 1);
                    return;
                  }

                  const scroll = scrollParentOf(flow);
                  if (!scroll || scroll.clientHeight <= 0) {
                    if (attempt < MAX_ATTEMPTS) schedule(flow, attempt + 1);
                    return;
                  }
                  if (scroll.scrollHeight > scroll.clientHeight + SCROLL_SLACK_PX) {
                    state.skipped += 1;
                    state.last = { action: 'skip-scrollable', attempt };
                    return;
                  }

                  const button = olderButtonOf(flow);
                  if (!button || button.disabled) {
                    if (attempt < MAX_ATTEMPTS) schedule(flow, attempt + 1);
                    return;
                  }

                  flow.setAttribute('data-fastload-autoloaded', '');
                  state.loads += 1;
                  state.last = { action: 'load', attempt };
                  button.click();
                } catch (error) {
                  state.error = String((error && error.stack) || (error && error.message) || error);
                }
              }, attempt === 0 ? AUTOLOAD_DELAY_MS : RETRY_MS);
              timers.add(timer);
            };

            // ---- diagnostics -------------------------------------------------
            const buffer = [];
            const remember = (kind, value) => {
              let text;
              try {
                text = typeof value === 'string' ? value : value && value.stack ? value.stack : JSON.stringify(value);
              } catch {
                text = String(value);
              }
              buffer.push({ t: Math.round(performance.now()), kind, text: String(text).slice(0, 1500) });
              if (buffer.length > MAX_ERRORS) buffer.shift();
            };

            const onError = (event) => {
              const error = event && event.error;
              remember('error', (error && (error.stack || error.message)) || (event && event.message) || 'error');
            };
            const onRejection = (event) => {
              const reason = event && event.reason;
              remember('rejection', (reason && (reason.stack || reason.message)) || reason || 'rejection');
            };
            window.addEventListener('error', onError);
            window.addEventListener('unhandledrejection', onRejection);

            const originalError = console.error;
            const quietError = (...args) => {
              try {
                remember('console', args.map((arg) => (arg && arg.stack ? arg.stack : arg)).join(' '));
              } catch {}
              return originalError.apply(console, args);
            };
            console.error = quietError;

            const rectOf = (node) => {
              const rect = node.getBoundingClientRect();
              return { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top) };
            };

            // React keeps the fiber on the host element; walking it is the only
            // way to read what a slot was handed without instrumenting the UI
            // packages. Read-only: nothing here mutates a component.
            const fiberKeyOf = (node) => {
              for (const key of Object.keys(node)) {
                if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) return key;
              }
              return null;
            };

            const fiberName = (fiber) => {
              const type = fiber && fiber.type;
              const name = (type && (type.displayName || type.name)) || (typeof type === 'string' ? type : '');
              return String(name).slice(0, 40);
            };

            const fiberRootOf = (node) => {
              const key = fiberKeyOf(node);
              if (!key) return null;
              try {
                return node[key] || null;
              } catch {
                return null;
              }
            };

            // Walk the mounted tree once and return the ChatFlow fiber: its
            // props.entries is exactly the list the transcript renders.
            const chatFlowFiber = (flow) => {
              const root = fiberRootOf(flowSlotOf(flow) || flow);
              if (!root) return null;
              const seenFibers = new Set();
              const queue = [root];
              let visited = 0;
              while (queue.length > 0 && visited < 8000) {
                const fiber = queue.shift();
                if (!fiber || seenFibers.has(fiber)) continue;
                seenFibers.add(fiber);
                visited += 1;
                const name = fiberName(fiber);
                const props = fiber.memoizedProps;
                if (name === 'ChatFlow' && props && Array.isArray(props.entries)) return fiber;
                if (fiber.child) queue.push(fiber.child);
                if (fiber.sibling) queue.push(fiber.sibling);
              }
              return null;
            };

            // Hooks are the only readable trace of ChatView's own state: the
            // ordered window lives in a useSyncExternalStore hook, the memo that
            // combines groupedEntries with order lives in a useMemo tuple.
            const hooksProbe = (start, limit) => {
              const out = [];
              let fiber = start;
              let depth = 0;
              while (fiber && depth < limit) {
                const name = fiberName(fiber);
                const props = fiber.memoizedProps;
                const entry = { f: name || 'anonymous' };
                if (props && typeof props === 'object') {
                  if (Array.isArray(props.entries)) entry.pEntries = props.entries.length;
                  if (Array.isArray(props.order)) entry.pOrder = props.order.length;
                }
                const hooks = [];
                let hook = fiber.memoizedState;
                let index = 0;
                while (hook && hook.next !== hook && index < 64) {
                  const value = hook.memoizedState;
                  if (Array.isArray(value)) {
                    hooks.push({ i: index, a: value.length });
                  } else if (value && typeof value === 'object') {
                    hooks.push({ i: index, k: Object.keys(value).slice(0, 5) });
                  } else if (value !== null && value !== undefined) {
                    hooks.push({ i: index, t: typeof value });
                  }
                  hook = hook.next;
                  index += 1;
                }
                if (hooks.length > 0) entry.hooks = hooks.slice(0, 24);
                out.push(entry);
                fiber = fiber.return;
                depth += 1;
              }
              return out;
            };

            const entriesOf = (flow) => {
              const fiber = chatFlowFiber(flow);
              if (!fiber) return null;
              const entries = fiber.memoizedProps.entries;
              return Array.isArray(entries) ? entries : null;
            };

            const fiberProbe = () => {
              const out = [];
              const flow = document.querySelector('[data-chat-flow]');
              if (!flow) return out;
              const root = fiberRootOf(flowSlotOf(flow) || flow);
              if (!root) return out;
              const seenFibers = new Set();
              const queue = [root];
              let visited = 0;
              while (queue.length > 0 && visited < 8000) {
                const fiber = queue.shift();
                if (!fiber || seenFibers.has(fiber)) continue;
                seenFibers.add(fiber);
                visited += 1;
                const name = fiberName(fiber);
                const props = fiber.memoizedProps;
                if (props && typeof props === 'object' && Array.isArray(props.entries)) {
                  out.push({
                    f: name,
                    entries: props.entries.length,
                    kinds: props.entries.slice(0, 4).map((entry) => (entry && entry.kind) || null),
                  });
                  if (name === 'ChatFlow') break;
                }
                if (fiber.child) queue.push(fiber.child);
                if (fiber.sibling) queue.push(fiber.sibling);
              }
              const chatFlow = chatFlowFiber(flow);
              if (chatFlow) {
                // ChatView holds the ordered window and the memo that turns
                // grouping output plus order into the rows ChatFlow receives.
                const chain = [];
                let fiber = chatFlow.return;
                let depth = 0;
                while (fiber && depth < 30) {
                  const name = fiberName(fiber);
                  chain.push(name || 'anonymous');
                  if (name === 'ChatView') {
                    out.push(...hooksProbe(fiber, 1));
                    break;
                  }
                  fiber = fiber.return;
                  depth += 1;
                }
                out.push({ f: 'chain', entries: chain.length, kinds: chain.slice(0, 8) });
              }
              out.push({ f: 'visited', entries: visited });
              return out;
            };

            // One line per scan: what the mounted flow was handed and what the
            // user could see, so a later probe can replay the first seconds.
            const flowSample = () => {
              const flow = document.querySelector('[data-chat-flow]:not([data-step-process-content])');
              const slot = flow ? flowSlotOf(flow) : null;
              const scroll = flow ? scrollParentOf(flow) : null;
              const entries = flow ? entriesOf(flow) : null;
              const sample = {
                t: Math.round(performance.now()),
                sid: currentSessionId().slice(-8),
                flow: flow !== null,
                entries: entries === null ? null : entries.length,
                kids: slot ? slot.children.length : -1,
                text: slot ? (slot.textContent || '').length : -1,
                older: flow ? olderButtonOf(flow) !== null : false,
                blank: flow ? flow.hasAttribute('data-fastload-blank') : null,
                scroll: scroll ? scroll.scrollHeight : null,
                top: scroll ? Math.round(scroll.scrollTop) : null,
                state: (() => { const s = sessionFeed(false); return s.ok ? (s.openState || '?') + '/' + (s.hasMore ? 'more' : 'end') : 'none'; })(),
                conv: (() => { const c = conversationProbe(); return c.ok ? (c.inputs || 0) + '/' + (c.chatEntries === null ? '-' : c.chatEntries) : 'none'; })(),
              };
              samples.push(sample);
              if (samples.length > MAX_SAMPLES) samples.shift();
            };

            const resourceProbe = () => {
              const out = [];
              try {
                for (const entry of performance.getEntriesByType('resource')) {
                  const path = String(entry.name).replace(/^[a-z-]+:\/\/[^/]+/, '');
                  if (path.indexOf('/api/') !== 0) continue;
                  out.push({
                    p: path.slice(0, 72),
                    s: Math.round(entry.startTime),
                    d: Math.round(entry.duration),
                    b: entry.transferSize || 0,
                  });
                }
              } catch {}
              return out.slice(-16);
            };

            const currentSessionId = () => {
              try {
                const raw = localStorage.getItem('dsh.sessions.current');
                if (!raw) return '';
                const parsed = JSON.parse(raw);
                if (typeof parsed === 'string') return parsed;
                return (parsed && parsed.sessionId) || '';
              } catch {
                return '';
              }
            };

            // ---- Stage 2: warm the last selection ---------------------------
            // Reads dsh.sessions.current only. DSH's own restoreSelection()
            // remains the only code that opens a session; this half just asks
            // the Host for the first page so that opening finds it cached.
            const readRestoreTarget = () => {
              let raw;
              try {
                raw = localStorage.getItem('dsh.sessions.current');
              } catch {
                return { reason: 'storage-unavailable' };
              }
              if (!raw) return { reason: 'empty' };
              let parsed;
              try {
                parsed = JSON.parse(raw);
              } catch {
                return { reason: 'invalid-json' };
              }
              if (typeof parsed === 'string') {
                return parsed === '' ? { reason: 'empty' } : { sid: parsed };
              }
              if (parsed === null || typeof parsed !== 'object') {
                return { reason: 'invalid-shape' };
              }
              // Same rule as restoreSelection(): any defined subagentAddress
              // takes the subagent branch, so this first version skips it.
              if (parsed.subagentAddress !== undefined) return { reason: 'subagent' };
              if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') {
                return { reason: 'missing-session-id' };
              }
              return { sid: parsed.sessionId };
            };
            const recentlyRestoreWarmed = (sid) => {
              let raw;
              try {
                raw = sessionStorage.getItem(RESTORE_WARM_GUARD_KEY) || '';
              } catch {
                return false;
              }
              const split = raw.lastIndexOf('@');
              if (split < 0 || raw.slice(0, split) !== sid) return false;
              const at = Number(raw.slice(split + 1));
              return Number.isFinite(at) && at > 0 && Date.now() - at < RESTORE_WARM_GUARD_MS;
            };
            const markRestoreWarmed = (sid) => {
              try {
                sessionStorage.setItem(RESTORE_WARM_GUARD_KEY, sid + '@' + Date.now());
              } catch {}
            };
            // Only answers when the session list is already ready. Waiting for
            // it would defeat the startup overlap; when it is not ready the
            // follow itself reports a deleted session as a silent failure.
            const restoredTargetProblem = (service, sid) => {
              try {
                const list = service.sessions && service.sessions.list
                  ? service.sessions.list.getSnapshot()
                  : null;
                if (!list || list.phase !== 'ready' || !list.byId) return null;
                const summary = list.byId[sid];
                if (summary === undefined) return 'session-missing';
                if (summary.blank === true) return 'blank-session';
              } catch {}
              return null;
            };
            const cancelRestorePrewarm = (reason) => {
              const stage = restorePrewarm.stage;
              if (stage !== 'waiting' && stage !== 'queued' && stage !== 'running') return;
              restorePrewarm.stage = 'cancelled';
              restorePrewarm.reason = reason;
              restorePrewarm.at = Date.now();
              cancelQueuedPrewarm(restorePrewarm.sid, 'restore');
              if (prewarmActive !== null
                && prewarmActive.sid === restorePrewarm.sid
                && prewarmActive.source === 'restore') {
                // Only this plugin's own passive follow is aborted. A hover
                // warm that happens to target the same session is left alone,
                // and the native restore stream is never touched.
                try {
                  prewarmActive.controller.abort();
                } catch {}
              }
              stopRestoreWatch();
            };
            const armRestoreWatch = (service, sid) => {
              restoreWatch = service.selection.subscribe((snapshot) => {
                if (disposed) return;
                const selected = snapshot && typeof snapshot === 'object' ? snapshot.sessionId : undefined;
                if (typeof selected !== 'string' || selected === '') return;
                if (selected !== sid) {
                  // The native restore picked another session (or the user
                  // did); the saved target is no longer what this page opens.
                  cancelRestorePrewarm('selection-changed');
                  return;
                }
                // replaceMain() writes the selection just before it installs
                // mainReference, so decide one microtask later: the initial
                // rehydrated value must not be mistaken for a fresh open.
                queueMicrotask(() => {
                  if (disposed) return;
                  if (mainSessionId() === sid) cancelRestorePrewarm('opened');
                });
              });
            };
            const armRestoreSignal = () => {
              restoreSignalTimer = null;
              if (disposed || restorePrewarm.stage !== 'waiting') return;
              const service = uiWorkspaceOf();
              if (service !== undefined
                && service.selection
                && typeof service.selection.subscribe === 'function'
                && typeof service.selection.getSnapshot === 'function') {
                if (mainSessionId() === restorePrewarm.sid) {
                  finishRestorePrewarm('skipped', 'already-open');
                  return;
                }
                const problem = restoredTargetProblem(service, restorePrewarm.sid);
                if (problem !== null) {
                  finishRestorePrewarm('skipped', problem);
                  return;
                }
                queuePrewarm(restorePrewarm.sid, 'restore');
                const stage = restorePrewarm.stage;
                if (stage === 'queued' || stage === 'running') {
                  armRestoreWatch(service, restorePrewarm.sid);
                }
                return;
              }
              restoreSignalAttempts += 1;
              if (restoreSignalAttempts > RESTORE_SIGNAL_RETRIES) {
                finishRestorePrewarm('skipped', 'cancel-signal-unavailable');
                return;
              }
              const target = readRestoreTarget();
              if (target.sid !== restorePrewarm.sid) {
                finishRestorePrewarm('skipped', 'selection-changed');
                return;
              }
              restoreSignalTimer = setTimeout(() => {
                timers.delete(restoreSignalTimer);
                restoreSignalTimer = null;
                try {
                  armRestoreSignal();
                } catch (error) {
                  finishRestorePrewarm('failed', String((error && error.message) || error).slice(0, 200));
                }
              }, RESTORE_SIGNAL_RETRY_MS);
              timers.add(restoreSignalTimer);
            };
            const startRestorePrewarm = () => {
              restorePrewarm.enabled = restorePrewarmAllowed();
              if (!restorePrewarm.enabled) {
                finishRestorePrewarm('disabled', 'disabled');
                return;
              }
              if (disposed || document.hidden) {
                finishRestorePrewarm('skipped', 'hidden');
                return;
              }
              const target = readRestoreTarget();
              if (typeof target.sid !== 'string') {
                finishRestorePrewarm('skipped', target.reason);
                return;
              }
              restorePrewarm.sid = target.sid;
              restorePrewarm.stage = 'waiting';
              if (recentlyRestoreWarmed(target.sid)) {
                // A reload did not change the persistence revision, so the
                // page cache from the previous warm is still current.
                finishRestorePrewarm('skipped', 'recently-warmed');
                return;
              }
              if (currentSessionId() !== target.sid) {
                finishRestorePrewarm('skipped', 'selection-changed');
                return;
              }
              armRestoreSignal();
            };
            {
              const startTimer = setTimeout(() => {
                timers.delete(startTimer);
                try {
                  startRestorePrewarm();
                } catch (error) {
                  finishRestorePrewarm('failed', String((error && error.message) || error).slice(0, 200));
                }
              }, RESTORE_START_DELAY_MS);
              timers.add(startTimer);
            }

            const autofixAllowed = () => {
              try {
                if (localStorage.getItem(AUTOFIX_KEY) === '0') return false;
              } catch {}
              return window.__DSH_FASTLOAD_AUTOFIX__ !== false;
            };

            // Read the Conversation binding only if it already exists.
            // conversation.binding(id) creates one as a side effect, which
            // would both change what a diagnostic observes and hide a first
            // replace that landed before the chat view subscribed.
            const conversationBindingOf = (conversation, sessionId) => {
              try {
                const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                const owner = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined;
                if (!owner) return undefined;
                const record = conversation && conversation.bindings ? conversation.bindings.get(owner) : undefined;
                if (record && record.binding) return record.binding;
              } catch {}
              return undefined;
            };

            // The conversation assembler is the layer that turns the Session
            // window into chat rows. A window can be installed while that layer
            // holds no target at all, which renders as an open transcript with
            // a page button and zero rows; reading the assembler separates
            // "installed but never assembled" from "assembled but hidden".
            const assemblerProbe = (assembler) => {
              const out = {};
              try {
                out.viewDefs = assembler.viewDefinitions.entries().map((definition) => definition.target);
              } catch (error) { out.viewDefs = String(error); }
              try {
                out.byTarget = [...assembler.contextsByTarget].map(([target, set]) => target + ':' + set.size);
              } catch (error) { out.byTarget = String(error); }
              try {
                const kinds = {};
                for (const context of assembler.contexts.values()) {
                  const kind = context.definition && context.definition.kind ? context.definition.kind : '?';
                  kinds[kind] = (kinds[kind] || 0) + 1;
                }
                out.kinds = kinds;
              } catch (error) { out.kinds = String(error); }
              try { out.views = [...assembler.views.keys()]; } catch (error) { out.views = String(error); }
              try {
                const chat = assembler.contextsByTarget.get('chat');
                out.chatContexts = chat
                  ? [...chat].slice(0, 4).map((context) => ({
                    kind: context.definition && context.definition.kind,
                    state: context.state === undefined ? 'undef' : 'set',
                    build: typeof (context.definition && context.definition.buildViewNode),
                  }))
                  : null;
              } catch (error) { out.chatContexts = String(error); }
              try {
                const view = assembler.views.get('chat');
                out.chatView = view
                  ? {
                    builderId: builderIdOf(view.builder),
                    builder: view.builder === undefined ? 'undef' : 'set',
                    snapshot: view.snapshot === undefined ? 'undef' : 'set',
                    order: view.snapshot && Array.isArray(view.snapshot.order) ? view.snapshot.order.length : null,
                    group: view.groupDefinition ? view.groupDefinition.kind : null,
                    create: typeof (view.definition && view.definition.create),
                  }
                  : null;
              } catch (error) { out.chatView = String(error); }
              try {
                const timeline = assembler.locationIndex.snapshot();
                out.turns = Array.isArray(timeline.turnOrder) ? timeline.turnOrder.length : null;
              } catch (error) { out.turns = String(error); }
              try {
                const group = assembler.groups.get('chat');
                out.chatGroup = group
                  ? { entries: group.store ? group.store.entries.length : null, def: group.definition ? group.definition.kind : null }
                  : null;
              } catch (error) { out.chatGroup = String(error); }
              return out;
            };

            const conversationProbe = (deep) => {
              try {
                const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined;
                const sessionId = currentSessionId();
                if (!conversation || !sessionId) return { ok: false, why: 'no-service' };
                const binding = conversationBindingOf(conversation, sessionId);
                if (!binding) return { ok: false, why: 'no-binding' };
                const assembler = binding.assembler;
                if (!assembler) return { ok: false, why: 'no-assembler' };
                const out = { ok: true };
                try { out.revision = binding.revision; } catch {}
                try { out.inputs = assembler.inputs.size; } catch {}
                try { out.contexts = assembler.contexts.size; } catch {}
                try { out.active = [...assembler.activeTargets]; } catch {}
                try { out.replacePending = assembler.replacePending === true; } catch {}
                try { out.dirty = assembler.dirty.size; } catch {}
                try { out.groups = [...assembler.groups.keys()]; } catch {}
                try {
                  const group = assembler.groups.get('chat');
                  out.chatEntries = group && group.store ? group.store.entries.length : null;
                } catch {}
                try {
                  const view = assembler.views.get('chat');
                  const snapshot = view ? view.snapshot : null;
                  out.chatView = snapshot
                    ? { order: Array.isArray(snapshot.order) ? snapshot.order.length : null, builderId: builderIdOf(view.builder) }
                    : null;
                } catch {}
                if (deep === true) {
                  try { out.assembler = assemblerProbe(assembler); } catch (error) { out.assembler = String(error); }
                }
                return out;
              } catch (error) {
                return { ok: false, why: String(error) };
              }
            };

            // Reconciling the conversation rebuilds every active target from the
            // window the Session already holds: no request, no navigation, no
            // scroll jump, and it is a no-op when the view is already correct.
            const rebuildConversation = () => {
              try {
                const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined;
                const sessionId = currentSessionId();
                if (!conversation || !sessionId) return false;
                const binding = conversationBindingOf(conversation, sessionId);
                if (!binding || typeof binding.rebuild !== 'function') return false;
                binding.rebuild();
                return true;
              } catch (error) {
                state.error = String(error);
                return false;
              }
            };

            // The assembler can hold a full window while publishing no chat rows
            // (a first replace that lands before the chat view subscribes is
            // dropped). That state is readable: inputs exist, chat entries do
            // not. Reconciling is cheap and idempotent, so nudge it as soon as
            // it is seen instead of waiting for the blank-grace timer.
            const nudges = new WeakMap();
            const assemblyWatch = (flow) => {
              const conversation = conversationProbe();
              if (!conversation.ok) return false;
              if (!(conversation.inputs > 0)) return false;
              if (conversation.chatEntries !== 0 && conversation.chatEntries !== null) return false;
              const previous = nudges.get(flow);
              const now = Date.now();
              if (previous && (previous.count >= 3 || now - previous.at < 1200)) return false;
              const count = previous ? previous.count + 1 : 1;
              nudges.set(flow, { count, at: now });
              const rebuilt = rebuildConversation();
              state.heal = {
                action: rebuilt ? 'assembly-nudge' : 'assembly-nudge-unavailable',
                count,
                conversation: conversationProbe(true),
              };
              return rebuilt;
            };

            // One recovery per session per cooldown. Rebuilding in place is the
            // cheap repair; a reload stays the fallback when the assembled rows
            // still do not appear, because only a fresh window can be trusted
            // after that.
            const healEmptyTranscript = (payload) => {
              if (!autofixAllowed()) return;
              const sessionId = currentSessionId() || 'unknown';
              let last = 0;
              try {
                last = Number(sessionStorage.getItem(HEAL_KEY + sessionId) || 0);
              } catch {}
              const now = Date.now();
              if (Number.isFinite(last) && last > 0 && now - last < HEAL_COOLDOWN_MS) return;
              try {
                sessionStorage.setItem(HEAL_KEY + sessionId, String(now));
              } catch {}
              state.healed += 1;
              state.blank = payload;
              const before = conversationProbe(true);
              // A window that carries an executed rewind is not broken: walk
              // back instead of re-publishing the same all-hidden order.
              if (windowRewound()) {
                const flow = document.querySelector('[data-chat-flow]:not([data-step-process-content])');
                if (advanceHidden(flow, 'blank')) return;
              }
              const nudged = rebuildConversation();
              state.heal = { action: nudged ? 'rebuild' : 'rebuild-unavailable', at: Math.round(performance.now()), before };
              try {
                originalError('[dsh-fastload] empty transcript with a page button', { sessionId, nudged, before });
              } catch {}
              setTimeout(() => {
                const flow = document.querySelector('[data-chat-flow]:not([data-step-process-content])');
                const entries = flow ? entriesOf(flow) : null;
                if (entries !== null && entries.length > 0) {
                  state.heal = { action: 'recovered-by-rebuild', entries: entries.length, before };
                  try {
                    flow.removeAttribute('data-fastload-blank');
                  } catch {}
                  blankHandled.delete(flow);
                  return;
                }
                const after = conversationProbe(true);
                state.heal = { action: 'rebuild-failed', entries: entries === null ? null : entries.length, after };
                captureStuck('blank-grace/rebuild-failed', after);
              }, 900);
            };
            // The transcript's own window is the ground truth. A batch of rows
            // can be invisible while the Session still holds a page, and a page
            // can be empty while the Session claims older history; reading the
            // Session directly separates those two failures, which no amount
            // of DOM inspection can.
            const sessionFeed = (deep) => {
              try {
                const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                const id = currentSessionId();
                if (!sessions || !id) return { ok: false, why: 'no-service' };
                const binding = typeof sessions.binding === 'function' ? sessions.binding(id) : undefined;
                const s = binding && binding.session;
                if (!s) return { ok: false, why: 'no-binding' };
                const out = { ok: true };
                try { out.openState = s.openState; } catch {}
                try { out.hasMore = s.hasMore; } catch {}
                try { out.baseSeq = s.baseSeq; } catch {}
                try { out.loadingOlder = s.loadingOlder === true; } catch {}
                try { out.openError = s.openError ? String(s.openError.message || s.openError.code || '') : null; } catch {}
                if (deep !== true) return out;
                try {
                  const snap = s.eventSource && typeof s.eventSource.getSnapshot === 'function' ? s.eventSource.getSnapshot() : null;
                  if (snap) {
                    const entries = Array.isArray(snap.entries) ? snap.entries : [];
                    const firstEvent = entries.length ? entries[0].event || {} : {};
                    const lastEvent = entries.length ? entries[entries.length - 1].event || {} : {};
                    out.feed = {
                      n: entries.length,
                      more: snap.hasMore,
                      rev: snap.revision,
                      kind: snap.change && snap.change.kind ? snap.change.kind : null,
                      changed: snap.change && Array.isArray(snap.change.entries) ? snap.change.entries.length : null,
                      first: entries.length ? firstEvent.seq : null,
                      last: entries.length ? lastEvent.seq : null,
                    };
                  }
                } catch (error) {
                  out.feedError = String(error);
                }
                return out;
              } catch (error) {
                return { ok: false, why: String(error) };
              }
            };

            // A window that lands before the chat view subscribes is dropped by
            // the assembler and nothing schedules a second attempt. The Session
            // event feed notifies synchronously when the window is installed, so
            // watching it lets the repair run in the same task as the drop: the
            // blank frame never reaches a paint.
            const guards = new Map();
            // The drop happens inside the assembler's own flush, before any DOM
            // exists to inspect. Patch the prototype once so every later binding
            // records the inputs of a publish that produced no chat rows.
            const flushLog = [];
            const buildLog = [];
            // These patches are DEBUG-only and sit on host-owned prototypes;
            // disposal has to put the originals back, or a disabled plugin
            // keeps changing behaviour until the page reloads.
            const patchTrackers = [];
            const trackPatch = (owner, key, original, flag) => {
              patchTrackers.push({ owner, key, original, flag });
            };
            const restorePatches = () => {
              while (patchTrackers.length) {
                const patch = patchTrackers.pop();
                try {
                  if (patch.owner[patch.key] !== patch.original) patch.owner[patch.key] = patch.original;
                  delete patch.owner[patch.flag];
                } catch {}
              }
            };
            const instrumentFlush = () => {
              try {
                const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined;
                const sessionId = currentSessionId();
                if (!conversation || !sessionId) return false;
                const binding = conversationBindingOf(conversation, sessionId);
                const assembler = binding && binding.assembler;
                if (!assembler) return false;
                const proto = Object.getPrototypeOf(assembler);
                if (!proto || typeof proto.flush !== 'function') return false;
                if (proto.__dshFastloadPatched === true) return true;
                const buildOwner = typeof proto.buildTargetNodes === 'function' ? proto : assembler;
                if (buildOwner.__dshFastloadBuildPatched !== true && typeof buildOwner.buildTargetNodes === 'function') {
                  const originalBuild = buildOwner.buildTargetNodes;
                  buildOwner.__dshFastloadBuildPatched = true;
                  buildOwner.buildTargetNodes = function patchedBuild(target, contexts) {
                    state.buildSeen = (state.buildSeen || 0) + 1;
                    state.lastBuildTarget = target;
                    const nodes = originalBuild.call(this, target, contexts);
                    state.buildDone = (state.buildDone || 0) + 1;
                    try {
                      const list = contexts && typeof contexts[Symbol.iterator] === 'function' ? Array.from(contexts) : [];
                      if (target === 'chat' && list.length > 0) {
                        const stats = { total: list.length, built: nodes.length, hidden: 0, samples: [] };
                        stats.kinds = {};
                        for (const node of nodes) {
                          if (!node || node.visibility !== 'visible') stats.hidden += 1;
                          const kind = node && node.kind ? node.kind + ':' + (node.visibility || 'unset') : 'none';
                          stats.kinds[kind] = (stats.kinds[kind] || 0) + 1;
                        }
                        for (const context of list.slice(0, 5)) {
                          const current = context.current && typeof context.current.get === 'function' ? context.current.get('chat') : undefined;
                          const event = Array.isArray(context.matches) && context.matches.length ? context.matches[context.matches.length - 1].event : undefined;
                          let location = 'none';
                          try {
                            const found = event ? this.locationIndex.locationOf(event) : undefined;
                            location = found === undefined ? 'missing' : found.kind || 'unknown';
                          } catch {}
                          stats.samples.push({
                            kind: context.kind,
                            state: context.state === undefined ? 'unset' : 'set',
                            loc: location,
                            cur: current === null || current === undefined ? 'null' : current.visibility || 'unknown',
                          });
                        }
                        buildLog.push(stats);
                        while (buildLog.length > 8) buildLog.shift();
                        if (nodes.length === 0) captureStuck('build-zero', { build: stats, assembler: assemblerProbe(this) });
                      }
                    } catch {}
                    return nodes;
                  };
                  trackPatch(buildOwner, 'buildTargetNodes', originalBuild, '__dshFastloadBuildPatched');
                }
                state.patched = {
                  build: buildOwner === proto ? 'prototype' : 'instance',
                  flush: proto.__dshFastloadPatched === true ? 'prototype' : 'new',
                  own: Object.prototype.hasOwnProperty.call(assembler, 'buildTargetNodes'),
                };
                const original = proto.flush;
                proto.__dshFastloadPatched = true;
                proto.flush = function patchedFlush(...args) {
                  const self = this;
                  let before = null;
                  try {
                    const chatContexts = self.contextsByTarget && self.contextsByTarget.get('chat');
                    before = {
                      ctxChat: chatContexts ? chatContexts.size : -1,
                      view: self.views ? self.views.has('chat') : null,
                      active: self.activeTargets ? self.activeTargets.has('chat') : null,
                      pending: self.replacePending === true,
                    };
                  } catch {}
                  let result;
                  try {
                    result = original.apply(self, args);
                  } catch (error) {
                    state.flushError = { at: Math.round(performance.now()), message: String(error).slice(0, 300), before };
                    throw error;
                  }
                  state.flushes = (state.flushes || 0) + 1;
                  state.lastFlush = {
                    at: Math.round(performance.now()),
                    result,
                    buildCalls: buildLog.length,
                    before,
                    viewsHas: self.views && self.views.has('chat'),
                    activeSize: self.activeTargets ? self.activeTargets.size : -1,
                    views: self.views ? [...self.views.keys()] : null,
                  };
                  try {
                    const snap = typeof self.snapshot === 'function' ? self.snapshot('chat') : undefined;
                    const order = snap && Array.isArray(snap.order) ? snap.order.length : -1;
                    if (before && order === 0) {
                      flushLog.push({ ...before, order, at: Math.round(performance.now()) });
                      while (flushLog.length > 12) flushLog.shift();
                      captureStuck('flush-zero', {
                        flush: flushLog[flushLog.length - 1],
                        build: buildLog[buildLog.length - 1],
                        assembler: assemblerProbe(self),
                      });
                    }
                  } catch {}
                  return result;
                };
                trackPatch(proto, 'flush', original, '__dshFastloadPatched');
                return true;
              } catch {
                return false;
              }
            };
            // The chat builder is the only place where 135 built nodes can still
            // collapse into an empty order. Patch its replace/apply once.
            const builderLog = [];
            const builderIds = new WeakMap();
            let builderNextId = 1;
            const builderIdOf = (builder) => {
              if (!builder || typeof builder !== 'object') return 0;
              if (!builderIds.has(builder)) builderIds.set(builder, builderNextId++);
              return builderIds.get(builder);
            };
            const instrumentBuilder = () => {
              try {
                const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined;
                const binding = conversationBindingOf(conversation, currentSessionId());
                const assembler = binding && binding.assembler;
                if (!assembler || !assembler.views) return false;
                const view = assembler.views.get('chat');
                const builder = view && view.builder;
                if (!builder) return false;
                const proto = Object.getPrototypeOf(builder);
                if (!proto || typeof proto.replace !== 'function') return false;
                if (proto.__dshFastloadBuilderPatched === true) return true;
                proto.__dshFastloadBuilderPatched = true;
                const shapeOf = (value) => {
                  const out = { n: 0, vis: {}, kinds: {} };
                  const list = Array.isArray(value) ? value : [];
                  for (const node of list) {
                    out.n += 1;
                    const visibility = node && node.visibility;
                    const label = visibility === undefined ? 'undef' : String(visibility);
                    out.vis[label] = (out.vis[label] || 0) + 1;
                    const kind = String(node && node.kind) + ':' + label;
                    out.kinds[kind] = (out.kinds[kind] || 0) + 1;
                  }
                  return out;
                };
                const wrap = (name) => {
                  const original = proto[name];
                  if (typeof original !== 'function') return;
                  proto[name] = function patchedBuilder(input) {
                    const batch = input && Array.isArray(input.nodes) ? input.nodes : input && Array.isArray(input.upserts) ? input.upserts : [];
                    const record = { at: Math.round(performance.now()), name, id: builderIdOf(this), input: batch.length, ctor: this && this.constructor ? this.constructor.name : '?', own: this ? Object.keys(this).slice(0, 8).join(',') : '', raw: shapeOf(batch) };
                    try {
                      const result = original.call(this, input);
                      record.order = Array.isArray(this.order) ? this.order.length : String(this.order);
                      record.snap = result && Array.isArray(result.order) ? result.order.length : -1;
                      record.visible = record.snap;
                      try { record.store = this.store && typeof this.store.values === 'function' ? this.store.values().length : null; } catch {}
                      if (batch.length > 0 && (record.order === 0 || record.order === 'undefined')) {
                        const sample = batch[0];
                        try { record.first = { keys: Object.keys(sample).slice(0, 10).join(','), kind: sample.kind, visibility: sample.visibility, seq: sample.anchorSeq }; } catch {}
                        try { record.firstStore = this.store && typeof this.store.values === 'function' ? this.store.values().slice(0, 2).map((node) => node.kind + ':' + node.visibility) : null; } catch {}
                      }
                      return result;
                    } catch (error) {
                      record.error = String(error && error.message ? error.message : error).slice(0, 220);
                      throw error;
                    } finally {
                      builderLog.push(record);
                      while (builderLog.length > 6) builderLog.shift();
                    }
                  };
                  trackPatch(proto, name, original, '__dshFastloadBuilderPatched');
                };
                wrap('replace');
                wrap('apply');
                return true;
              } catch {
                return false;
              }
            };
            const healBlankMarkers = () => {
              for (const flow of document.querySelectorAll('[data-chat-flow][data-fastload-blank]')) {
                const entries = entriesOf(flow);
                if (entries === null || entries.length === 0) continue;
                flow.removeAttribute('data-fastload-blank');
                blankHandled.delete(flow);
                blankFirstSeen.delete(flow);
                state.heal = { action: 'recovered-by-rebuild', entries: entries.length };
              }
            };
            // Rebuilding republishes from the assembler's own state. When the
            // chat target itself produced no nodes, re-activating it forces a
            // fresh complete replacement before anything heavier is tried.
            const reactivateChat = () => {
              try {
                const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined;
                const sessionId = currentSessionId();
                if (!conversation || !sessionId) return false;
                const binding = conversationBindingOf(conversation, sessionId);
                const assembler = binding && binding.assembler;
                if (!assembler || !assembler.activeTargets || typeof assembler.activateTarget !== 'function') return false;
                assembler.activeTargets.delete('chat');
                assembler.activateTarget('chat');
                const snapshot = typeof assembler.snapshot === 'function' ? assembler.snapshot('chat') : undefined;
                const order = snapshot && Array.isArray(snapshot.order) ? snapshot.order.length : 0;
                return order > 0;
              } catch (error) {
                state.error = String(error);
                return false;
              }
            };

            // A repair that reports success can still publish nothing. Verify
            // against the live rows, then escalate once: re-activate, capture,
            // and only then fall back to a reload.
            const escalate = (rec, why) => {
              const checked = conversationProbe();
              if (checked.ok && checked.chatEntries > 0) {
                healBlankMarkers();
                return true;
              }
              captureStuck(why, conversationProbe(true));
              const reactivated = reactivateChat();
              const after = conversationProbe(true);
              state.heal = {
                action: reactivated ? 'reactivated' : 'stuck',
                at: Math.round(performance.now()),
                why,
                conversation: after,
              };
              if (after.ok && after.chatEntries > 0) {
                healBlankMarkers();
                return true;
              }
              try {
                originalError('[dsh-fastload] transcript stayed empty after repair', { why, conversation: after });
              } catch {}
              return false;
            };

            // Keep the pre-repair assembler state; a later successful repair
            // must not erase the only evidence of what broke.
            const captureStuck = (why, conversation) => {
              try {
                const payload = {
                  at: new Date().toISOString(),
                  build: BUILD,
                  why,
                  session: currentSessionId(),
                  conversation,
                };
                state.stuck.push(payload);
                while (state.stuck.length > 3) state.stuck.shift();
                sessionStorage.setItem('dsh-fastload:stuck', JSON.stringify(state.stuck).slice(0, 200000));
                if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                  navigator.clipboard.writeText(JSON.stringify(payload)).catch(() => {});
                }
              } catch {}
            };

            // The installed window is the only place a rewind command can be
            // observed: once one ran, rows inside its cut are hidden by design.
            const windowRewound = () => {
              try {
                const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                const id = currentSessionId();
                const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(id) : undefined;
                // The Session owns the feed; the sessions binding is not it.
                const session = binding && binding.session ? binding.session : binding;
                const source = session && session.eventSource;
                const snapshot = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
                if (!snapshot) return false;
                const change = snapshot.change;
                const entries = Array.isArray(snapshot.entries) && snapshot.entries.length > 0
                  ? snapshot.entries
                  : change && Array.isArray(change.entries) ? change.entries : [];
                for (const entry of entries) {
                  const event = entry && entry.event ? entry.event : entry;
                  if (!event || event.type !== 'command/run') continue;
                  const name = event.data && event.data.name;
                  if (typeof name === 'string' && /rewind/i.test(name)) return true;
                }
              } catch {}
              return false;
            };

            // Press the transcript's own page button: it owns the anchor
            // compensation that keeps the reading position stable.
            const advanceHidden = (flow, why) => {
              if (!flow) return false;
              const button = olderButtonOf(flow);
              if (!button) return false;
              const rec = advanceStateOf(flow);
              if (rec.clicks >= ADVANCE_MAX) {
                state.heal = { action: 'advance-exhausted', at: Math.round(performance.now()), why, clicks: rec.clicks };
                return true;
              }
              if (Date.now() - rec.at < ADVANCE_GAP_MS) return true;
              if (button.disabled) return true;
              rec.clicks += 1;
              rec.at = Date.now();
              state.advance = { at: Math.round(performance.now()), why, clicks: rec.clicks };
              try {
                button.click();
              } catch {
                return false;
              }
              state.heal = { action: 'advance-hidden', at: Math.round(performance.now()), why, clicks: rec.clicks };
              return true;
            };

            const guardCheck = (why) => {
              const sessionId = currentSessionId();
              const rec = sessionId ? guards.get(sessionId) : undefined;
              if (!rec) return false;
              const now = performance.now();
              if (now - rec.at < GUARD_MIN_MS) return false;
              rec.at = now;
              rec.checks += 1;
              const feed = sessionFeed(false);
              if (!feed.ok || feed.openState !== 'open') return false;
              const conversation = conversationProbe();
              if (!conversation.ok) return false;
              if (!(conversation.inputs > 0)) return false;
              if (conversation.chatEntries !== 0 && conversation.chatEntries !== null) return false;
              if (document.querySelector('[data-slot="conversation.chat.node"]')) return false;
              // Rewound rows are hidden on purpose; rebuilding cannot help and
              // would only re-publish the same empty order.
              const flow = document.querySelector('[data-chat-flow]:not([data-step-process-content])');
              if (windowRewound()) {
                if (advanceHidden(flow, why)) return true;
              }
              // One page back is cheap and reversible: when the installed rows
              // are empty, more history is the likeliest missing ingredient.
              if (rec.rebuilds === 0 && flow && advanceStateOf(flow).clicks === 0) {
                if (advanceHidden(flow, why + '/pre-rebuild')) return true;
              }
              if (rec.rebuilds >= GUARD_MAX_REBUILDS) return false;
              rec.rebuilds += 1;
              const rebuilt = rebuildConversation();
              state.repairs += 1;
              state.heal = {
                action: rebuilt ? 'feed-rebuild' : 'feed-rebuild-unavailable',
                at: Math.round(now),
                why,
                count: rec.rebuilds,
                before: conversationProbe(true),
              };
              if (rebuilt) {
                healBlankMarkers();
                const timer = setTimeout(() => {
                  timers.delete(timer);
                  try {
                    escalate(rec, why);
                  } catch (error) {
                    state.error = String(error);
                  }
                }, 400);
                timers.add(timer);
              } else {
                captureStuck(why + '/rebuild-unavailable', conversationProbe(true));
              }
              return rebuilt;
            };
            // A stale page cache cannot be repaired inside the stream (a
            // second opening frame is a protocol violation), so the host fails
            // the stream and the client rebuilds the source from scratch. The
            // stale file is evicted host-side, so the retry is a plain load.
            const STALE_PATTERN = /page cache is stale/i;
            const staleWatch = new Map();
            const staleResync = (sessionId) => {
              try {
                if (!sessionId) return false;
                const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                const owner = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined;
                const session = owner && owner.session;
                if (!session || session.openState !== 'error') return false;
                const message = session.openError ? String(session.openError.message || '') : '';
                if (!STALE_PATTERN.test(message)) return false;
                const now = performance.now();
                const rec = staleWatch.get(sessionId) || { at: 0, tries: 0 };
                if (rec.tries >= 3 || now - rec.at < 1200) return false;
                rec.at = now;
                rec.tries += 1;
                staleWatch.set(sessionId, rec);
                state.heal = { action: 'cache-resync', at: Math.round(now), tries: rec.tries, message: message.slice(0, 120) };
                Promise.resolve(session.resync()).catch((error) => { state.error = String(error); });
                return true;
              } catch {
                return false;
              }
            };
            const releaseGuard = (rec) => {
              try {
                if (rec.unsub) rec.unsub();
              } catch {}
              try {
                if (rec.sessionUnsub) rec.sessionUnsub();
              } catch {}
              rec.unsub = null;
              rec.sessionUnsub = null;
            };
            const guardAttach = (rec) => {
              if (rec.unsub) return true;
              try {
                const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
                const owner = sessions && typeof sessions.binding === 'function' ? sessions.binding(rec.sessionId) : undefined;
                const source = owner && owner.eventSource;
                if (!source || typeof source.subscribe !== 'function') return false;
                rec.unsub = source.subscribe(() => {
                  guardCheck('event');
                });
                const session = owner && owner.session;
                if (!rec.sessionUnsub && session && typeof session.subscribe === 'function') {
                  rec.sessionUnsub = session.subscribe(() => {
                    staleResync(rec.sessionId);
                  });
                }
                return true;
              } catch {
                return false;
              }
            };
            const ensureGuard = () => {
              const sessionId = currentSessionId();
              if (!sessionId) return;
              for (const [id, old] of guards) {
                if (id === sessionId) continue;
                releaseGuard(old);
                guards.delete(id);
              }
              let rec = guards.get(sessionId);
              if (!rec) {
                rec = { sessionId, unsub: null, sessionUnsub: null, checks: 0, rebuilds: 0, at: 0, checked: false, reloaded: false };
                guards.set(sessionId, rec);
              }
              const attached = guardAttach(rec);
              state.guard = { session: sessionId.slice(-8), attached, checks: rec.checks, rebuilds: rec.rebuilds, reloaded: rec.reloaded === true };
              if (!attached || rec.checked) return;
              rec.checked = true;
              // A window installed before this guard existed is repaired on
              // the next turns of the loop instead of after the blank grace.
              for (const delay of [0, 60, 140, 300, 600, 1000]) {
                const timer = setTimeout(() => {
                  timers.delete(timer);
                  guardCheck('attach');
                }, delay);
                timers.add(timer);
              }
            };

            const probe = () => {
              const flows = [];
              for (const flow of document.querySelectorAll('[data-chat-flow]')) {
                const slot = flowSlotOf(flow);
                if (!slot) continue;
                const scroll = scrollParentOf(flow);
                flows.push({
                  step: flow.hasAttribute('data-step-process-content'),
                  flow: rectOf(flow),
                  slot: rectOf(slot),
                  slotChildren: slot.children.length,
                  slotText: (slot.innerText || '').trim().length,
                  nodeSeats: slot.querySelectorAll('[data-slot="conversation.chat.node"]').length,
                  slotError: (flow.querySelector('[data-slot-error]') || {}).getAttribute
                    ? flow.querySelector('[data-slot-error]').getAttribute('data-slot-error')
                    : null,
                  hasOlder: olderButtonOf(flow) !== null,
                  autoloaded: flow.hasAttribute('data-fastload-autoloaded'),
                  blank: flow.hasAttribute('data-fastload-blank'),
                  scroll: scroll ? { h: scroll.clientHeight, top: Math.round(scroll.scrollTop), total: scroll.scrollHeight } : null,
                });
              }
              return {
                at: new Date().toISOString(),
                build: BUILD,
                session: currentSessionId(),
                href: location.href,
                view: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
                flows,
                slotErrors: [...document.querySelectorAll('[data-slot-error]')].map((node) => node.getAttribute('data-slot-error')),
                factoryErrors: [...document.querySelectorAll('[data-factory-error]')].map((node) => node.getAttribute('data-factory-error')),
                client: { build: BUILD, patched: state.patched, flushError: state.flushError, builderLog, flushes: state.flushes, lastFlush: state.lastFlush, buildSeen: state.buildSeen, buildDone: state.buildDone, lastBuildTarget: state.lastBuildTarget, scans: state.scans, loads: state.loads, skipped: state.skipped, healed: state.healed, repairs: state.repairs, advance: state.advance, prewarm: state.prewarm, restorePrewarm: state.restorePrewarm, rewound: windowRewound(), heal: state.heal, heals: heals.slice(-4), flushLog: flushLog.slice(-6), buildLog: buildLog.slice(-4), stuck: state.stuck.slice(-2), guard: state.guard, last: state.last, error: state.error },
                fibers: fiberProbe(),
                feed: sessionFeed(true),
                conversation: conversationProbe(true),
                samples: samples.slice(-32),
                requests: resourceProbe(),
                lastBlank: (() => {
                  try {
                    const raw = sessionStorage.getItem('dsh-fastload:blank');
                    return raw ? JSON.parse(raw) : null;
                  } catch {
                    return 'unreadable';
                  }
                })(),
                errors: buffer.slice(-12),
              };
            };

            const publish = (payload) => {
              try {
                window.__DSH_FASTLOAD__.last = payload;
              } catch {}
              // A blank transcript may heal by reloading, which discards this
              // window; keep the evidence in sessionStorage so the next probe
              // can still show what was handed to the flow.
              try {
                sessionStorage.setItem('dsh-fastload:blank', JSON.stringify(payload).slice(0, 60000));
              } catch {}
              try {
                const clipboardCopy = globalThis.copy;
                if (typeof clipboardCopy === 'function') clipboardCopy(JSON.stringify(payload));
              } catch {}
            };

            window.__DSH_FASTLOAD__ = {
              probe,
              publish,
              rebuild: rebuildConversation,
              instrument: () => ({ flush: instrumentFlush(), build: instrumentBuilder(), buildLog: buildLog.length }),
              whoami: () => {
                try {
                  const conversation = ctx && typeof ctx.get === 'function' ? ctx.get('uiConversation') : undefined;
                  const binding = conversationBindingOf(conversation, currentSessionId());
                  const assembler = binding && binding.assembler;
                  if (!assembler) return { ok: false };
                  const proto = Object.getPrototypeOf(assembler);
                  return {
                    ok: true,
                    buildFn: String(assembler.buildTargetNodes).slice(0, 46),
                    flushFn: String(assembler.flush).slice(0, 46),
                    sameBuild: assembler.buildTargetNodes === proto.buildTargetNodes,
                    sameFlush: assembler.flush === proto.flush,
                    protoBuildFlag: proto.__dshFastloadBuildPatched === true,
                    protoFlushFlag: proto.__dshFastloadPatched === true,
                    active: assembler.activeTargets ? [...assembler.activeTargets] : null,
                    bindings: (() => {
                      try {
                        const ownerBinding = conversation.binding(currentSessionId());
                        const out = [];
                        for (const owner of conversation.bindings.values) {
                          const bound = conversation.bindings.get(owner);
                          if (!bound || !bound.binding) continue;
                          const asm = bound.binding.assembler;
                          out.push({
                            same: bound === ownerBinding,
                            active: asm.activeTargets ? [...asm.activeTargets] : null,
                            order: asm.snapshot ? (asm.snapshot('chat') || {}).order && asm.snapshot('chat').order.length : null,
                            inputs: asm.inputs ? asm.inputs.size : null,
                            pending: asm.replacePending === true,
                            views: asm.views ? [...asm.views.keys()] : null,
                          });
                        }
                        return out;
                      } catch (error) {
                        return [String(error)];
                      }
                    })(),
                  };
                } catch (error) {
                  return { ok: false, why: String(error) };
                }
              },
              guard: () => guardCheck('manual'),
              deep: () => conversationProbe(true),
              last: null,
            };

            for (const delay of [0, 40, 110, 250, 500, 900, 1500]) {
              const timer = setTimeout(() => {
                timers.delete(timer);
                if (!DEBUG) return;
                instrumentFlush();
                instrumentBuilder();
              }, delay);
              timers.add(timer);
            }

            // An open transcript with a "Load older" button but no rendered
            // slot content and no height cannot be reached through the host
            // paginator: flag it once with everything a later triage needs.
            const watchEmpty = (flow) => {
              if (blankHandled.has(flow)) return;
              const slot = flowSlotOf(flow);
              if (!slot) return;
              // A page button is the marker of an installed window: without it
              // an empty transcript is a legitimately empty session.
              if (olderButtonOf(flow) === null) return;
              const entries = entriesOf(flow);
              const empty = entries !== null
                ? entries.length === 0
                : slot.getBoundingClientRect().height <= 1 && (slot.innerText || '').trim() === '';
              if (!empty) {
                blankFirstSeen.delete(flow);
                return;
              }
              const first = blankFirstSeen.get(flow);
              const now = Date.now();
              if (first === undefined) {
                blankFirstSeen.set(flow, now);
                return;
              }
              if (now - first < BLANK_GRACE_MS) return;
              blankHandled.add(flow);
              blankFirstSeen.delete(flow);
              flow.setAttribute('data-fastload-blank', '');
              const payload = probe();
              publish(payload);
              try {
                originalError('[dsh-fastload] empty transcript with a page button', payload);
              } catch {}
              healEmptyTranscript(payload);
            };

            const scan = () => {
              state.scans += 1;
              try {
                flowSample();
              } catch {}
              try {
                ensureGuard();
                staleResync(currentSessionId());
                if (DEBUG) {
                  instrumentFlush();
                  instrumentBuilder();
                }
              } catch {}
              for (const flow of document.querySelectorAll('[data-chat-flow]')) {
                if (seen.has(flow)) continue;
                // Reasoning/tool-step bodies also carry data-chat-flow; they are
                // not the transcript and have neither the flow slot nor a page
                // button of their own.
                if (flow.hasAttribute('data-step-process-content')) continue;
                if (!flowSlotOf(flow)) continue;
                seen.add(flow);
                schedule(flow, 0);
              }
              try {
                for (const flow of document.querySelectorAll('[data-chat-flow]')) {
                  if (flow.hasAttribute('data-step-process-content')) continue;
                  try {
                    if (assemblyWatch(flow)) continue;
                  } catch {}
                  watchEmpty(flow);
                }
              } catch {}
            };

            scan();
            const interval = setInterval(scan, 500);

            return () => {
              disposed = true;
              stopRestoreWatch();
              if (restorePrewarm.stage === 'waiting'
                || restorePrewarm.stage === 'queued'
                || restorePrewarm.stage === 'running') {
                restorePrewarm.stage = 'cancelled';
                restorePrewarm.reason = 'disposed';
                restorePrewarm.at = Date.now();
              }
              cancelPendingPrewarm();
              prewarmQueue.length = 0;
              prewarm.queued = 0;
              try {
                if (prewarmActive !== null) prewarmActive.controller.abort();
              } catch {}
              document.removeEventListener('pointerover', onPrewarmOver, { capture: true });
              document.removeEventListener('pointerout', onPrewarmOut, { capture: true });
              document.removeEventListener('focusin', onPrewarmOver, { capture: true });
              clearInterval(interval);
              for (const timer of timers) clearTimeout(timer);
              timers.clear();
              for (const rec of guards.values()) releaseGuard(rec);
              guards.clear();
              restorePatches();
              for (const type of inputEvents) {
                document.removeEventListener(type, noteInput, { capture: true });
              }
              window.removeEventListener('error', onError);
              window.removeEventListener('unhandledrejection', onRejection);
              if (console.error === quietError) console.error = originalError;
            };
          });
        },
      };
    },
  });
})();
