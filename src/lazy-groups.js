// Pure predicates for the stage 4 lazy-group experiment.
//
// client.js is a single classic script loaded by the DSH web module loader, so
// it cannot import this module at runtime. The browser bundle keeps an inline
// copy of these two functions; this file exists so the decision logic can be
// tested under node --test and referenced from the research report.

export const LAZY_GROUPS_KEY = 'dsh-fastload.lazy-groups';
export const LAZY_GROUPS_SLOT = 'conversation.chat.flow';
export const LAZY_GROUP_TEXT_MAX = 4000;

/**
 * Collect a bounded, human-readable text mirror from a chat node payload.
 *
 * Only strings, numbers and booleans are collected. Keys named raw/json are
 * skipped because they duplicate already-collected text or carry wire data.
 * The traversal is depth-limited and budget-limited; malformed cyclic input
 * cannot hang the caller because the recursion stops at the budget.
 */
export function lazyGroupText(value, maxChars = LAZY_GROUP_TEXT_MAX) {
  const out = [];
  let budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  if (budget === 0) return '';
  const walk = (item, depth) => {
    if (budget <= 0 || depth > 6 || item == null) return;
    if (typeof item === 'string') {
      const text = item.length > budget ? item.slice(0, budget) : item;
      out.push(text);
      budget -= text.length;
      return;
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      const text = String(item);
      out.push(text);
      budget -= text.length;
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        walk(child, depth + 1);
        if (budget <= 0) break;
      }
      return;
    }
    if (typeof item === 'object') {
      for (const key of Object.keys(item)) {
        if (key === 'raw' || key === 'json') continue;
        walk(item[key], depth + 1);
        if (budget <= 0) break;
      }
    }
  };
  try { walk(value, 0); } catch {}
  return out.join(' ');
}

/**
 * Whether the native presentation considers this node a folded process member
 * that can be replaced by a placeholder.
 *
 * Requirements (all must hold):
 * - the owner exposes a foldable turn process that is currently closed;
 * - the node is a tool call (assistant-step nodes stay native: they carry the
 *   folded reply preview and are shared with the answer row);
 * - the process spec exists and the node sits between processStartSeq and
 *   answerAnchorSeq (when the answer anchor is known).
 */
export function lazyGroupEligible(owner) {
  const process = owner && owner.turnProcess;
  const node = owner && owner.node;
  if (!process || process.foldable !== true || process.open === true) return false;
  if (!node || node.kind !== 'tool-call') return false;
  const spec = process.spec;
  if (!spec) return false;
  if (typeof node.anchorSeq !== 'number' || node.anchorSeq < spec.processStartSeq) return false;
  if (spec.answerAnchorSeq !== null && spec.answerAnchorSeq !== undefined && node.anchorSeq >= spec.answerAnchorSeq) return false;
  return true;
}

export const LAZY_PROGRESSIVE_KEY = 'dsh-fastload.lazy-progressive';

/**
 * Resolve the experimental mode from the two independent switches.
 * Progressive wins when both are on; an unknown/partial input is off.
 */
export function lazyGroupMode(permanent, progressive) {
  if (progressive === true) return 'progressive';
  if (permanent === true) return 'permanent';
  return 'off';
}
