/**
 * Delivery decisions shared by the realtime handlers and catch-up.
 *
 * Why this is a separate module: the round-1 review (blockers 4, 6, 8) was
 * about *when* a message counts as delivered and *which* policy applies when
 * the same content arrives over a different path (live socket vs. replay).
 * Those decisions used to live inline in the per-org loop in bot.js, which is a
 * top-level-await script — untestable. Here they are pure functions plus one
 * state transition helper, so both paths are pinned by unit tests.
 *
 * Verdicts:
 *   'deliver'   pass the policy gate; run the delivery pipeline
 *   'skipped'   not ours / no final answer needed (self, no @mention,
 *               rate-limited) — do NOT record it, a later replay may retry
 *   'rejected'  policy said no for good (dmPolicy, groupPolicy, sender
 *               allowlist, oversized) — record it, replaying will not help
 */

import { isDmAllowed, isThreadAllowed, isSenderAllowed } from './auth.js';

export const DELIVER = 'deliver';
export const SKIP = 'skipped';
export const REJECT = 'rejected';

const verdict = (verdict, reason) => ({ verdict, reason });

const groupPolicyOff = access => (access?.groupPolicy || 'open') === 'disabled';

/**
 * DM policy, for live and replay. Same function on both paths: a DM that is
 * refused live must not be delivered by catch-up either.
 */
export function decideDmDelivery({ access, isSelf, message, sender, catchup = false, takeRateToken }) {
  if (isSelf?.(message?.sender_id, message?.metadata)) return verdict(SKIP, 'self');
  if (!isDmAllowed(access, sender)) return verdict(REJECT, `dmPolicy:${access?.dmPolicy || 'open'}`);
  // Rate limiting is realtime-only: replayed messages are already throttled in
  // batches by the catch-up runner.
  if (!catchup && takeRateToken && !takeRateToken()) return verdict(SKIP, 'rate-limited');
  return verdict(DELIVER, 'ok');
}

/**
 * Thread policy, for live and replay.
 *
 * `groupPolicy=disabled` stops EVERY thread delivery regardless of `reason`
 * (messages, invites, lifecycle). A replayed invite carries the topic name, so
 * it must not slip past what the live path would have dropped.
 */
export function decideThreadDelivery({
  access, isSelf, message, threadId, sender, reason, mode,
  isMention = false, catchup = false, takeRateToken,
}) {
  if (groupPolicyOff(access)) return verdict(REJECT, 'groupPolicy:disabled');
  // The SDK filters the bot's own outbound messages on the live path; a replay
  // reads raw history, so apply the same rule here (human-authored exceptions
  // are the caller's isSelf()).
  if (isSelf?.(message?.sender_id, message?.metadata)) return verdict(SKIP, 'self');

  const interactive = reason === 'message';
  if (interactive && !isThreadAllowed(access, threadId)) {
    return verdict(REJECT, `groupPolicy:${access?.groupPolicy || 'open'}`);
  }
  if (interactive && !isSenderAllowed(access, threadId, sender)) return verdict(REJECT, 'sender-not-allowed');
  if (interactive && mode === 'mention' && !isMention) return verdict(SKIP, 'not-mentioned');
  if (interactive && !catchup && takeRateToken && !takeRateToken()) return verdict(SKIP, 'rate-limited');
  return verdict(DELIVER, 'ok');
}

/**
 * Offline lifecycle events (invites, status changes) go through the same policy
 * boundary as live thread traffic. Anything not delivered stays a log line.
 */
export function decideCatchupEvent({ access, event }) {
  if (groupPolicyOff(access)) return verdict(REJECT, 'groupPolicy:disabled');
  if ((event?.type === 'thread_invited' || event?.type === 'thread_status_changed')
      && event.thread_id && !isThreadAllowed(access, event.thread_id)) {
    return verdict(REJECT, `groupPolicy:${access?.groupPolicy || 'open'}`);
  }
  return verdict(DELIVER, 'ok');
}

/**
 * Record the outcome of ONE live delivery in the shared delivery state.
 *
 * Invariants (blocker 4 / 7):
 *   - only 'delivered' or 'rejected' is remembered; 'skipped' is not, and a
 *     transport failure definitely is not;
 *   - a failure opens a gap (`markGap`) and bumps the gap epoch, so the next
 *     catch-up run retries the message instead of the boundary moving past it;
 *   - an in-flight marker is always cleared, so a failure cannot look delivered.
 *
 * @returns {'delivered'|'rejected'|'skipped'|'failed'}
 */
export function settleLiveDelivery({ outcome, error, id, at, gate, markGap, save }) {
  if (error || (outcome !== DELIVER && outcome !== REJECT && outcome !== SKIP)) {
    gate?.clear?.(id);
    markGap?.();
    save?.();
    return 'failed';
  }
  if (outcome === DELIVER || outcome === REJECT) {
    gate?.mark?.(id, at);
    save?.();
    return outcome;
  }
  gate?.clear?.(id);
  return SKIP;
}
