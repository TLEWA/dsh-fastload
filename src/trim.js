const TURN_START = 'turn/start';

function eventOf(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'event' && record.event && typeof record.event === 'object') return record.event;
  if (typeof record.seq === 'number' && typeof record.type === 'string') return record;
  return null;
}

function byteLength(value) {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
}

function findTurnStarts(records) {
  const starts = [];
  for (let i = 0; i < records.length; i += 1) {
    const event = eventOf(records[i]);
    if (event && event.type === TURN_START) starts.push(i);
  }
  return starts;
}

/**
 * Plan a byte-bounded opening page.
 *
 * The only legal cut points are turn/start events. At least options.minTurns
 * complete turns are kept. If those protected turns exceed the soft budget but
 * fit the hard cap, they are kept as-is rather than cutting into a turn.
 *
 * @returns {{opening: object, info: null | {
 *   beforeBytes: number, afterBytes: number,
 *   beforeRecords: number, afterRecords: number,
 *   cutIndex: number, cutSeq: number | null,
 *   protectedIndex: number, maxBytes: number, hardCapBytes: number
 * }}}
 */
export function planTrim(opening, options = {}) {
  const unchanged = { opening, info: null };
  if (!opening || opening.type !== 'snapshot' || !Array.isArray(opening.records)) return unchanged;

  const records = opening.records;
  if (records.length === 0) return unchanged;

  const maxBytes = Number(options.maxBytes) || 0;
  if (maxBytes <= 0) return unchanged;

  const sizes = records.map(byteLength);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= maxBytes) return unchanged;

  const minTurns = Math.max(1, Number(options.minTurns) || 2);
  const hardCapBytes = Math.max(
    maxBytes,
    Number(options.hardCapBytes) || 8 * 1024 * 1024
  );
  const starts = findTurnStarts(records);
  if (starts.length < minTurns) return unchanged;

  const protectedIndex = starts[starts.length - minTurns];
  if (protectedIndex <= 0) return unchanged;

  const suffix = new Array(records.length + 1).fill(0);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    suffix[i] = suffix[i + 1] + sizes[i];
  }

  const budget = Math.floor(maxBytes * 0.97);
  let cutIndex = -1;
  for (const index of starts) {
    if (index <= 0 || index > protectedIndex) continue;
    if (suffix[index] <= budget) {
      cutIndex = index;
      break;
    }
  }

  // The newest protected turns alone are over the soft budget. Keep them only
  // when they still fit the hard cap; otherwise leave the page untouched.
  if (cutIndex < 0 && suffix[protectedIndex] <= hardCapBytes) {
    cutIndex = protectedIndex;
  }
  if (cutIndex <= 0) return unchanged;

  const cutEvent = eventOf(records[cutIndex]);
  const trimmed = {
    ...opening,
    records: records.slice(cutIndex),
    hasMore: true,
  };

  return {
    opening: trimmed,
    info: {
      beforeBytes: total,
      afterBytes: suffix[cutIndex],
      beforeRecords: records.length,
      afterRecords: trimmed.records.length,
      cutIndex,
      cutSeq: cutEvent && typeof cutEvent.seq === 'number' ? cutEvent.seq : null,
      protectedIndex,
      maxBytes,
      hardCapBytes,
    },
  };
}

export function trimOpening(opening, options = {}) {
  return planTrim(opening, options).opening;
}
