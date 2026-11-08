const DEFAULT_INITIAL_MAX_MESSAGES = 500;

/**
 * Only the first history page is rewritten. Jump-to-message and "load older"
 * carry beforeSeq/throughSeq and must keep the caller's page window.
 *
 * When force=false, an explicit small page (<= the default 500) is respected.
 * The stock transport sends 500 for the initial page, so it is rewritten.
 */
export function isInitialPage(request, config = {}) {
  if (!request || typeof request !== 'object') return false;
  if (request.beforeSeq != null || request.throughSeq != null) return false;
  if (config.force) return true;

  const maxMessages = request.maxMessages;
  return maxMessages == null || maxMessages >= DEFAULT_INITIAL_MAX_MESSAGES;
}
