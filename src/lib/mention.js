/**
 * Thread @mention detection for the delivery policy.
 *
 * A thread message counts as "mentioning us" when any of these hold:
 *   1. `mention_all` is set on the wire message.
 *   2. `mentions[]` contains our own id (`{ bot_id, name }`, see the SDK's
 *      WireThreadMessage/MentionRef types). This is the structural signal the
 *      hub sends and it does not depend on how the bot happens to be named.
 *   3. The visible text contains `@<agent_name>` (the historical heuristic,
 *      still needed for messages that carry only free text).
 *
 * Rule 2 exists because rule 3 alone silently dropped thread messages: the
 * configured `agent_name` and the name the hub renders in the mention text can
 * differ, so `@<agent_name>` never matched even though the hub had already
 * told us we were mentioned. DMs never used this check, which is why they were
 * unaffected.
 *
 * Kept as a pure module so the live path and catch-up replay are pinned by the
 * same unit tests (bot.js itself is a top-level-await script).
 */

/** Escape a string for safe use inside a RegExp body. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * All searchable text of a message: content, part contents, and the
 * alt/name/title of non-text parts (an @mention can live in those fields too).
 * @param {object} msg wire thread message
 * @returns {string}
 */
export function extractMentionText(msg) {
  const texts = [msg?.content || ''];
  if (Array.isArray(msg?.parts)) {
    for (const part of msg.parts) {
      if (part && 'content' in part && typeof part.content === 'string') {
        texts.push(part.content);
      }
      if (part?.type === 'image' && part.alt) texts.push(part.alt);
      if (part?.type === 'file' && part.name) texts.push(part.name);
      if (part?.type === 'link' && part.title) texts.push(part.title);
    }
  }
  return texts.join(' ');
}

/**
 * True when `mentions[]` names us. Element shape is `{ bot_id, name }`.
 * @param {Array<{bot_id?: string, name?: string}>} mentions
 * @param {string|null|undefined} agentId our own agent id
 */
export function mentionsSelf(mentions, agentId) {
  if (!agentId || !Array.isArray(mentions)) return false;
  return mentions.some(m => m && m.bot_id === agentId);
}

/**
 * Decide whether a thread message mentions us.
 * @param {object} opts
 * @param {object} opts.message wire thread message
 * @param {string|null|undefined} opts.agentId our own agent id (config agent_id)
 * @param {string|null|undefined} opts.agentName our configured agent name
 * @returns {boolean}
 */
export function isThreadMentioned({ message, agentId, agentName }) {
  const msg = message || {};
  if (msg.mention_all) return true;
  if (mentionsSelf(msg.mentions, agentId)) return true;
  if (!agentName) return false;
  const mentionRe = new RegExp(`@${escapeRe(agentName)}\\b`, 'i');
  return mentionRe.test(extractMentionText(msg));
}
