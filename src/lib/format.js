/**
 * C4 message fragments shared by the realtime handlers and catch-up.
 * Kept in one place so a replayed message is byte-identical to the same
 * message delivered live, except for the catch-up marker.
 */

/** Marker prefixed to anything that was replayed from the hub event log. */
export const CATCHUP_TAG = '[补收] ';

/**
 * @param {object} opts
 * @param {string} opts.displayPrefix  "HXA-Connect" or "HXA:<org>"
 * @param {string} opts.sender
 * @param {string} opts.content
 * @param {string} [opts.attachments] already-formatted attachment block
 * @param {boolean} [opts.catchup]
 */
export function buildDmContent({ displayPrefix, sender, content, attachments = '', catchup = false }) {
  const tag = catchup ? CATCHUP_TAG : '';
  return `[${displayPrefix} DM] ${tag}${sender} said: ${content}${attachments}`;
}

/**
 * First line of a thread delivery: the trigger message.
 * @param {object} opts
 * @param {string} opts.displayPrefix
 * @param {string} opts.threadId
 * @param {string} opts.sender
 * @param {boolean} opts.hasMessage
 * @param {boolean} [opts.catchup]
 */
export function buildThreadHeader({ displayPrefix, threadId, sender, hasMessage, catchup = false }) {
  if (!hasMessage) return `[${displayPrefix} Thread:${threadId}] System update: `;
  const tag = catchup ? CATCHUP_TAG : '';
  return `[${displayPrefix} Thread:${threadId}] ${tag}${sender} said: `;
}
