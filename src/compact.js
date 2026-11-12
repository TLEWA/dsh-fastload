/**
 * Compact the opening page by dropping replay-only payload.
 *
 * A settled `assistant/message` event carries both the assembled message and
 * the raw stream chunks that produced it. The chunks exist so a client can
 * rebuild/replay a settlement; the transcript itself renders from
 * `data.message`. On a long tool-heavy page those chunks are the single
 * largest payload (often over a third of the whole page).
 *
 * This transform replaces `data.stream` with an empty array on the *initial*
 * page only. Consumers that read the stream fall back to `data.usage` (already
 * present) and every other reader treats an empty stream as "no chunks", which
 * is exactly what it is. Older pages, jump targets and the persisted log keep
 * the original chunks.
 */

const ASSISTANT_SETTLEMENTS = new Set(['assistant/message', 'assistant/attempt']);

function eventOf(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'event' && record.event && typeof record.event === 'object') return record.event;
  if (typeof record.seq === 'number' && typeof record.type === 'string') return record;
  return null;
}

/**
 * @returns {{opening: object, info: null | {stripped: number, savedBytes: number}}}
 */
export function planCompact(opening, options = {}) {
  const unchanged = { opening, info: null };
  if (!opening || opening.type !== 'snapshot' || !Array.isArray(opening.records)) return unchanged;
  if (options.stripStream === false) return unchanged;

  const minBytes = Number(options.minStreamBytes) > 0 ? Number(options.minStreamBytes) : 256;
  let stripped = 0;
  let savedBytes = 0;
  let changed = false;

  const records = opening.records.map((record) => {
    const event = eventOf(record);
    if (!event || !ASSISTANT_SETTLEMENTS.has(event.type)) return record;
    const data = event.data;
    if (!data || !Array.isArray(data.stream) || data.stream.length === 0) return record;
    const chunks = JSON.stringify(data.stream).length - 2;
    if (chunks < minBytes) return record;

    changed = true;
    stripped += 1;
    savedBytes += chunks;
    const nextEvent = { ...event, data: { ...data, stream: [] } };
    return record === event ? nextEvent : { ...record, event: nextEvent };
  });

  if (!changed) return unchanged;
  return {
    opening: { ...opening, records },
    info: { stripped, savedBytes },
  };
}

export function compactOpening(opening, options = {}) {
  return planCompact(opening, options).opening;
}
