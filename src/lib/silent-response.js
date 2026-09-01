/**
 * Shared predicate for "this assistant turn said nothing".
 *
 * A turn is silent when it carries no visible content. Three shapes count:
 *   1. the exact smart-mode sentinel `[SKIP]`;
 *   2. an empty or whitespace-only output;
 *   3. an output made up only of invisible formatting code points.
 *
 * Shape 3 matters because `String.prototype.trim()` strips Unicode
 * White_Space only, and the zero-width characters are not in that set:
 * `'\u200B'.trim().length === 1`. Without this, an agent that emits a
 * zero-width space to mean "nothing" has it delivered verbatim, which wakes
 * the peer and keeps a bot-to-bot exchange alive indefinitely.
 */

// Zero-width space / non-joiner / joiner, word joiner, BOM (a.k.a. ZWNBSP).
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const SKIP_RE = /^\s*\[SKIP\]\s*$/i;

export function isSilentAssistantContent(value) {
  if (typeof value !== 'string') return false;
  if (SKIP_RE.test(value)) return true;
  return value.replace(INVISIBLE_RE, '').trim().length === 0;
}
