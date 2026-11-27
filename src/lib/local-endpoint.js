/**
 * C4-local pseudo targets.
 *
 * `bot.js` writes admin notices to `org:<label>|admin` so the agent sees them
 * in the same context as real DMs. `admin` is not a hub bot: sending it to the
 * hub fails with `Bot not found: admin`. These targets must stay local.
 */
export const LOCAL_ENDPOINTS = Object.freeze(['admin']);

export function isLocalEndpoint(target) {
  return LOCAL_ENDPOINTS.includes(String(target ?? ''));
}
