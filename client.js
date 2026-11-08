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
 */

(() => {
  const MODULE_ID = 'dsh-fastload';
  const AUTOLOAD_DELAY_MS = 900;
  const RETRY_MS = 700;
  const MAX_ATTEMPTS = 8;
  const INPUT_IDLE_MS = 1500;
  const SCROLL_SLACK_PX = 16;

  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory() {
      return {
        inject: [],
        apply(ctx) {
          if (typeof document === 'undefined') return;

          const state = {
            version: '0.2.1',
            scans: 0,
            loads: 0,
            skipped: 0,
            last: null,
            error: null,
          };
          window.__DSH_FASTLOAD_CLIENT__ = state;

          ctx.effect(() => {
            const seen = new WeakSet();
            const timers = new Set();
            let lastInputAt = -Infinity;

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
                if (child.getAttribute('data-slot') === 'conversation.chat.flow') return child;
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

            const scan = () => {
              state.scans += 1;
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
            };

            scan();
            const interval = setInterval(scan, 500);

            return () => {
              clearInterval(interval);
              for (const timer of timers) clearTimeout(timer);
              timers.clear();
              for (const type of inputEvents) {
                document.removeEventListener(type, noteInput, { capture: true });
              }
            };
          });
        },
      };
    },
  });
})();
