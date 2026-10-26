/**
 * Redact HXA credentials out of log text.
 *
 * The lab must never write `agent_token`, registration tickets or
 * Authorization headers into PM2 logs. Even though the pinned component only
 * logs `err.message`, network errors can embed URLs or bodies, so every
 * top-level error log goes through this function (vendor patch, hash-verified).
 */
const PATTERNS = [
  [/(\bAuthorization\b"?\s*[:=]\s*)(Bearer\s+)?[^\s"',}]+/gi, '$1$2[REDACTED]'],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/(\bagent_token\b"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]'],
  [/(\bticket\b"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}&]+)/gi, '$1[REDACTED]'],
  [/([?&](?:ticket|token|agent_token)=)[^&\s]+/gi, '$1[REDACTED]'],
  [/(\bagent_[A-Za-z0-9._~+/=-]{8,})/g, '[REDACTED]'],
];

export function redactSecrets(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}
