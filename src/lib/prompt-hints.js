/**
 * Shared C4 prompt fragments for the HXA adapter.
 *
 * The [SKIP] sentinel is the only sanctioned way for an agent turn to stay
 * silent (issues #11/#14). The hint below is what makes that sentinel
 * discoverable: thread routes inject it for explicitly configured 'smart'
 * threads, DM routes inject it unconditionally (issue #20).
 */

export const SMART_MODE_SKIP_HINT = '<smart-mode>\nDecide whether to respond. Reply with exactly [SKIP] when a response is unnecessary.\n</smart-mode>\n\n';

/**
 * Builds the C4 prompt content for an interactive DM delivery.
 *
 * The smart-mode hint is always injected on the DM path: DMs have no
 * per-thread mode configuration surface (`access.threads` is keyed by thread
 * id and DM turns never consult it), and every policy-admitted DM becomes an
 * agent turn. Without the hint the only actor able to emit [SKIP] is never
 * told the sentinel exists, which is issue #20 cause 1.
 */
export function buildDmPromptContent({ displayPrefix, sender, content, attachments = '' }) {
  if (typeof displayPrefix !== 'string' || typeof sender !== 'string'
    || typeof content !== 'string' || typeof attachments !== 'string') {
    throw new TypeError('displayPrefix, sender, content and attachments must be strings');
  }
  return `${SMART_MODE_SKIP_HINT}[${displayPrefix} DM] ${sender} said: ${content}${attachments}`;
}
