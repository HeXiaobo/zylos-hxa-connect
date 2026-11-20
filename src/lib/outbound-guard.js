/**
 * Outbound org guard — stops a send from landing in a non-internal org by
 * accident.
 *
 * Opt-in by file: the guard only exists once
 * `<component>/outbound-guard.json` is present. Without that file every send
 * behaves exactly as before, so upgrades do not change behaviour on hosts that
 * have not asked for the guard.
 *
 *   { "internal_labels": ["org-1", "org-2"] }
 *
 * When the file is present and the resolved org label is not listed, the send
 * is refused unless `HXA_CONFIRM_ORG` names that same label.
 */

import fs from 'fs';
import path from 'path';

export const GUARD_FILENAME = 'outbound-guard.json';
export const CONFIRM_ENV = 'HXA_CONFIRM_ORG';

/**
 * Resolve the guard config path.
 * Exported so tests can point at a fixture directory instead of the real
 * component data dir.
 */
export function resolveGuardPath({ home = process.env.HOME } = {}) {
  if (!home) throw new Error('HOME is not set — cannot resolve outbound guard path');
  return path.join(home, 'zylos/components/hxa-connect', GUARD_FILENAME);
}

/**
 * Read the guard config.
 *
 * Returns `{ enabled: false }` when the file is absent — that is the "not
 * opted in" state, not an error. A present but unreadable/malformed file is an
 * error: silently letting traffic through on a broken guard would be the worst
 * of both worlds.
 */
export function loadGuardConfig(guardPath = resolveGuardPath()) {
  let raw;
  try {
    raw = fs.readFileSync(guardPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { enabled: false, path: guardPath };
    throw new Error(`cannot read ${guardPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${guardPath} is not valid JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${guardPath} must be a JSON object`);
  }
  if (!Array.isArray(parsed.internal_labels)) {
    throw new Error(`${guardPath} must have an "internal_labels" array`);
  }
  for (const label of parsed.internal_labels) {
    if (typeof label !== 'string' || label === '') {
      throw new Error(`${guardPath} internal_labels must contain non-empty strings`);
    }
  }

  return {
    enabled: true,
    path: guardPath,
    internalLabels: parsed.internal_labels,
  };
}

/**
 * Decide what to do with one send.
 *
 * Returns one of:
 *   { action: 'allow' }          — internal org, or guard not configured
 *   { action: 'confirm', ... }   — external org, HXA_CONFIRM_ORG matches
 *   { action: 'block', ... }     — external org, no confirmation
 *
 * Pure: no I/O, no process state, so it is cheap to test.
 */
export function evaluateSend({ effectiveLabel, target, guard, confirmOrg, confirmFromEnvFile = false }) {
  if (!guard || !guard.enabled) return { action: 'allow', guarded: false };

  if (guard.internalLabels.includes(effectiveLabel)) {
    return { action: 'allow', guarded: false };
  }

  const confirmed = !confirmFromEnvFile
    && typeof confirmOrg === 'string'
    && confirmOrg !== ''
    && confirmOrg === effectiveLabel;
  return {
    action: confirmed ? 'confirm' : 'block',
    guarded: true,
    effectiveLabel,
    target,
    internalLabels: guard.internalLabels,
    // Tells a blocked operator why a value they thought was set did not work.
    ignoredEnvFileConfirmation: !confirmed && confirmFromEnvFile && confirmOrg === effectiveLabel,
  };
}

/**
 * Print the operator-facing lines for a guarded send. Kept next to the
 * decision so the wording and the rule cannot drift apart.
 *
 * The target and the org label are the only message-derived values printed;
 * the body is never echoed, and credentials are never touched.
 */
export function formatGuardMessage(decision) {
  const { action, target, effectiveLabel, internalLabels } = decision;

  if (action === 'block') {
    const lines = [
      `[hxa-connect] BLOCKED: org "${effectiveLabel}" is not in internal_labels — message not sent`,
      `[hxa-connect] target: ${target}`,
      `[hxa-connect] org label: ${effectiveLabel}`,
      `[hxa-connect] internal_labels: ${internalLabels.join(', ')}`,
    ];
    if (decision.ignoredEnvFileConfirmation) {
      lines.push(`[hxa-connect] HXA_CONFIRM_ORG=${effectiveLabel} was found in ~/zylos/.env — ignored, pass it on this command instead`);
    }
    lines.push(`[hxa-connect] to send anyway: HXA_CONFIRM_ORG=${effectiveLabel} node send.js ...`);
    return lines.join('\n');
  }

  return `[hxa-connect] CONFIRMED EXTERNAL: org "${effectiveLabel}" approved by HXA_CONFIRM_ORG — target: ${target}`;
}
