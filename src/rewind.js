/**
 * Rewind-aware page extension.
 *
 * `/rewind` (dsh-rewind-plugin) hides every transcript row whose anchor falls
 * inside a cut. A tail-only opening page can therefore land entirely inside a
 * cut and render zero rows even though the page itself is fine. The host can
 * spot the commands in the page it just built and reach one page further back,
 * so the first dispatch already contains visible content.
 */

const ENGINE_COMMANDS = new Set(['rewind', 'rewind-plugin']);
const TARGET = /@(\d+)/;

/** Cuts performed inside `records`, in execution order. */
export function findRewindCuts(records) {
  const cuts = [];
  let pending = null;
  for (const record of Array.isArray(records) ? records : []) {
    const event = record && record.event ? record.event : record;
    if (!event || typeof event.type !== 'string') continue;
    const data = event.data || {};
    if (event.type === 'command/run') {
      const name = typeof data.name === 'string' ? data.name : '';
      if (!ENGINE_COMMANDS.has(name)) continue;
      const args = typeof data.args === 'string' ? data.args : '';
      if (args.includes('preview') || args.includes('__candidates')) continue;
      const match = TARGET.exec(args);
      if (!match) continue;
      const target = Number(match[1]);
      if (!Number.isFinite(target)) continue;
      pending = { target, runSeq: Number.isFinite(event.seq) ? event.seq : null };
      continue;
    }
    if (event.type === 'command/done' && pending) {
      if (data.kind !== undefined && data.kind !== 'success') { pending = null; continue; }
      const marker = Number.isFinite(data.sourceEventSeq) ? data.sourceEventSeq : null;
      if (marker === null) { pending = null; continue; }
      if (pending.target <= marker) cuts.push({ target: pending.target, marker, runSeq: pending.runSeq });
      pending = null;
    }
  }
  return cuts;
}

/** Lowest sequence a cut removed, or null when nothing was cut. */
export function earliestCut(cuts) {
  let lowest = null;
  for (const cut of Array.isArray(cuts) ? cuts : []) {
    if (!Number.isFinite(cut.target)) continue;
    if (lowest === null || cut.target < lowest) lowest = cut.target;
  }
  return lowest;
}

/** True when `seq` itself falls inside any cut. */
export function hiddenByCuts(seq, cuts) {
  if (!Number.isFinite(seq)) return false;
  for (const cut of Array.isArray(cuts) ? cuts : []) {
    if (cut.target <= seq && seq <= cut.marker) return true;
  }
  return false;
}

/** First sequence present in a page, or null. */
export function firstSeqOf(records) {
  for (const record of Array.isArray(records) ? records : []) {
    const event = record && record.event ? record.event : record;
    if (event && Number.isFinite(event.seq)) return event.seq;
  }
  return null;
}
