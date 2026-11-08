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

export function apply(ctx) {
  const config = readConfig(process.env);
  const state = {
    version: '0.2.1',
    config,
    installed: false,
    trims: 0,
    lastTrim: null,
    error: null,
  };
  globalThis.__DSH_FASTLOAD__ = state;

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
    try {
      const sc = c.get('sessionController');
      if (!sc || typeof sc.follow !== 'function') {
        state.error = 'sessionController.follow is unavailable';
        return;
      }
      if (sc.__dshFastload) return;

      const original = sc.follow;
      sc.follow = function follow(request, signal) {
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

      sc.__dshFastload = true;
      state.installed = true;
    } catch (error) {
      state.error = String((error && error.stack) || (error && error.message) || error);
    }
  });
}
