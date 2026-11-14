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

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);

function findMessageStarts(records) {
  const starts = [];
  for (let i = 0; i < records.length; i += 1) {
    const event = eventOf(records[i]);
    if (event && MESSAGE_TYPES.has(event.type)) starts.push(i);
  }
  return starts;
}

function findTurnStarts(records) {
  const starts = [];
  for (let i = 0; i < records.length; i += 1) {
    const event = eventOf(records[i]);
    if (event && event.type === TURN_START) starts.push(i);
  }
  return starts;
}

function suffixSizes(sizes) {
  const suffix = new Array(sizes.length + 1).fill(0);
  for (let i = sizes.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + sizes[i];
  return suffix;
}

/**
 * Cut the page at a *message* boundary instead of a turn boundary.
 *
 * A message count bounds how many messages a page starts with, not how many
 * bytes they carry: each message drags the tool/job events that happened after
 * it, and one large tool result can dominate the page. During streaming that
 * makes a 24-message window grow to hundreds of KiB. This plan keeps the newest
 * `minMessages` message groups and cuts older history at a message start,
 * which is the same shape a native paged window has when the Host cuts inside
 * a turn.
 *
 * @returns {{opening: object, info: null | object}}
 */
function planMessageTrim(opening, options, maxBytes) {
  const unchanged = { opening, info: null };
  const records = opening.records;
  const sizes = records.map(byteLength);
  const suffix = suffixSizes(sizes);
  const total = suffix[0];
  if (total <= maxBytes) return unchanged;

  const starts = findMessageStarts(records);
  if (starts.length === 0) return unchanged;

  const minMessages = Math.max(1, Number(options.minMessages) || 1);
  const floorCount = Math.min(minMessages, starts.length);
  // Index of the oldest protected message: a cut at or before it keeps at
  // least `minMessages` message groups in the window.
  const floorIndex = starts[starts.length - floorCount];
  const hardCapBytes = Math.max(
    maxBytes,
    Number(options.hardCapBytes) || 8 * 1024 * 1024
  );
  const budget = Math.floor(maxBytes * 0.97);

  let cutIndex = -1;
  for (const index of starts) {
    if (index <= 0 || index > floorIndex) continue;
    if (suffix[index] <= budget) {
      cutIndex = index;
      break;
    }
  }
  // The protected newest messages alone are over the soft budget: keep them
  // while they still fit the hard cap, otherwise fall through to a cut that
  // does fit (accuracy of the tail is worth less than a bounded page).
  if (cutIndex < 0 && suffix[floorIndex] <= hardCapBytes) cutIndex = floorIndex;
  if (cutIndex < 0) {
    for (const index of starts) {
      if (index <= floorIndex) continue;
      if (suffix[index] <= hardCapBytes) {
        cutIndex = index;
        break;
      }
    }
  }
  const protectSeq = Number(options.protectSeq);
  if (Number.isFinite(protectSeq)) {
    let protectIndex = -1;
    for (const index of starts) {
      const event = eventOf(records[index]);
      const seq = event && typeof event.seq === 'number' ? event.seq : null;
      if (seq !== null && seq <= protectSeq) protectIndex = index;
    }
    // A recovered message may be the very first record of the merged page; it
    // is still the only visible content the client can render, so index 0 must
    // be protected too. Cutting there keeps the whole page (cutIndex === 0),
    // which is what the caller gets back instead of an empty transcript.
    if (protectIndex >= 0 && cutIndex > protectIndex) {
      if (suffix[protectIndex] > hardCapBytes) return unchanged;
      cutIndex = protectIndex;
    }
  }
  // Protecting index 0 means the whole page has to be kept: there is no cut
  // point left that preserves the recovered visible message.
  if (cutIndex <= 0) return unchanged;

  const cutEvent = eventOf(records[cutIndex]);
  return {
    opening: { ...opening, records: records.slice(cutIndex), hasMore: true },
    info: {
      cutAt: 'message',
      beforeBytes: total,
      afterBytes: suffix[cutIndex],
      beforeRecords: records.length,
      afterRecords: records.length - cutIndex,
      cutIndex,
      cutSeq: cutEvent && typeof cutEvent.seq === 'number' ? cutEvent.seq : null,
      protectedIndex: floorIndex,
      maxBytes,
      hardCapBytes,
    },
  };
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
  // Message-aligned cutting bounds a running page by bytes; turn-aligned
  // cutting stays the default everywhere else.
  if (options.cutAtMessages === true) return planMessageTrim(opening, options, maxBytes);

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

  const suffix = suffixSizes(sizes);

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

  // A rewind-aware opening may have pulled one older, visible turn in front of
  // a tail that is entirely hidden. Cutting that turn away would hand the
  // client an empty transcript again, so keep it (and its turn prefix) even
  // when it costs more than the soft budget; if it cannot fit the hard cap the
  // page is left untouched, exactly like an oversized protected tail.
  const protectSeq = Number(options.protectSeq);
  if (cutIndex > 0 && Number.isFinite(protectSeq)) {
    let protectIndex = -1;
    for (const index of starts) {
      const event = eventOf(records[index]);
      const seq = event && typeof event.seq === 'number' ? event.seq : null;
      if (seq !== null && seq <= protectSeq) protectIndex = index;
    }
    if (protectIndex >= 0 && cutIndex > protectIndex) {
      if (suffix[protectIndex] > hardCapBytes) return unchanged;
      cutIndex = protectIndex;
    }
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