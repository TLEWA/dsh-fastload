/**
 * dsh-fastload — host half.
 *
 * Long DSH sessions often open with hundreds of transcript rows because the
 * initial history page is bounded by message count and turn count, not by
 * what the user can actually see. This plugin narrows the *initial* page to
 * two complete turns (100 messages max, 40 min). Optional byte trimming cuts
 * older whole turns from the response without ever cutting into the newest
 * two turns.
 *
 * Scope: only requests without beforeSeq/throughSeq are touched. "Load
 * older", jump-to-message and live updates keep their original semantics.
 */

import { readConfig } from './src/config.js';
import { isInitialPage } from './src/page.js';
import { planTrim } from './src/trim.js';

export const name = 'dsh-fastload';
export const inject = ['sessionController'];

function wrapFirstSnapshot(result, config, state, ctx) {
  const trimFrame = (frame) => {
    const { opening, info } = planTrim(frame, config);
    if (!info) return opening;
    state.trims += 1;
    state.lastTrim = info;
    if (config.debug) {
      try {
        ctx.logger?.info?.(
          '[dsh-fastload] trimmed initial page ' +
            info.beforeBytes + ' -> ' + info.afterBytes + ' bytes, ' +
            info.beforeRecords + ' -> ' + info.afterRecords + ' records'
        );
      } catch {}
    }
    return opening;
  };

  if (result && typeof result.then === 'function') {
    return result.then(trimFrame);
  }

  if (result && typeof result[Symbol.asyncIterator] === 'function') {
    return (async function* () {
      let first = true;
      for await (const frame of result) {
        if (first) {
          first = false;
          yield trimFrame(frame);
        } else {
          yield frame;
        }
      }
    })();
  }

  return result;
}

const STATE_VERSION = '0.2.1';
const CORDIS_ORIGINAL = Symbol.for('cordis.original');

/**
 * Reuse the diagnostics object for the same version so a wrapper left over from
 * an earlier install never writes into an orphaned state.
 */
function reuseState() {
  const existing = globalThis.__DSH_FASTLOAD__;
  if (existing && typeof existing === 'object' && existing.version === STATE_VERSION) {
    return existing;
  }
  const state = {
    version: STATE_VERSION,
    config: null,
    installed: false,
    trims: 0,
    lastTrim: null,
    error: null,
  };
  globalThis.__DSH_FASTLOAD__ = state;
  return state;
}

/**
 * Raw service behind cordis's traceable proxy. Reads through that proxy create
 * a fresh shadow for every function property, so restored functions must be
 * compared and written on the target, never on the public object.
 */
function installTarget(service) {
  return (service && service[CORDIS_ORIGINAL]) || service;
}

export function apply(ctx) {
  const config = readConfig(process.env);
  const state = reuseState();
  state.config = config;
  state.installed = false;
  state.error = null;

  if (!config.enabled) return;

  const banner =
    '[dsh-fastload] active: initial page ' +
    config.maxMessages + '/' + config.minMessages + '/' + config.minTurns +
    ', maxBytes=' + config.maxBytes +
    ', client auto-fill=on';
  try {
    ctx.logger?.info?.(banner);
  } catch {}
  if (config.debug) process.stderr.write(banner + '\n');

  ctx.inject(['sessionController'], (c) => {
    let sc;
    try {
      sc = c.get('sessionController');
    } catch (error) {
      state.error = String((error && error.stack) || (error && error.message) || error);
      return;
    }
    if (!sc || typeof sc.follow !== 'function') {
      state.error = 'sessionController.follow is unavailable';
      return;
    }

    const target = installTarget(sc);
    if (target.__dshFastload) {
      state.installed = true;
      return;
    }

    const install = () => {
      const original = target.follow;
      const ownDescriptor = Object.getOwnPropertyDescriptor(target, 'follow');
      // Another plugin can wrap us and keep calling the wrapper it captured. If
      // teardown cannot restore target.follow, this flag turns the leftover
      // wrapper into a passthrough instead of leaving the old page size in the
      // chain and re-applying it after the next install.
      let active = true;
      const wrapped = function follow(request, signal) {
        if (!active) return original.call(this, request, signal);
        const next = { ...request };
        const initial = isInitialPage(next, config);

        if (initial) {
          next.maxMessages = config.maxMessages;
          next.turnWindow = {
            minMessages: config.minMessages,
            minTurns: config.minTurns,
          };
        }

        const result = original.call(this, next, signal);
        if (!initial || config.maxBytes <= 0) return result;
        return wrapFirstSnapshot(result, config, state, ctx);
      };

      target.follow = wrapped;
      target.__dshFastload = true;
      state.installed = true;

      return () => {
        if (target.follow === wrapped) {
          if (ownDescriptor) Object.defineProperty(target, 'follow', ownDescriptor);
          else delete target.follow;
        } else {
          active = false;
          state.error =
            'sessionController.follow was re-wrapped by another plugin; the dsh-fastload wrapper was switched off and now passes requests through';
        }
        delete target.__dshFastload;
        state.installed = false;
      };
    };

    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(install, 'dsh-fastload: sessionController.follow');
      } else {
        // Hosts without ctx.effect: keep the pre-fix install-once behavior.
        install();
      }
    } catch (error) {
      state.error = String((error && error.stack) || (error && error.message) || error);
    }
  });
}
