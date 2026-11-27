/**
 * C4-local pseudo targets.
 *
 * `bot.js` writes system notices to `org:<label>|local:<name>` so the agent
 * sees them in the same context as real DMs. The hub has no such bot; sending
 * the bare name would fail with `Bot not found`.
 */
// A prefixed marker, not a bare name: a real hub bot may legitimately be
// called `admin`, and that send must keep working. Bot names cannot contain a
// colon, so `local:` cannot collide with one.
export const LOCAL_ENDPOINT_PREFIX = 'local:';

export function localEndpoint(name) {
  return `${LOCAL_ENDPOINT_PREFIX}${name}`;
}

export function isLocalEndpoint(target) {
  return String(target ?? '').startsWith(LOCAL_ENDPOINT_PREFIX);
}
