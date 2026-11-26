/**
 * Outbound org guard — default-deny allowlist that stops a send from landing
 * in a customer or non-with3 org by accident.
 *
 * Fail-closed by default: when `<component>/outbound-guard.json` is absent,
 * every outbound send is blocked unless explicitly approved on that single
 * invocation via `HXA_CONFIRM_ORG=<label>` (never from `~/zylos/.env`).
 *
 * Allowlist file (`<component>/outbound-guard.json`):
 *
 *   {
 *     "internal_labels": ["org-2"],
 *     "internal_org_ids": ["11111111-1111-4111-8111-111111111111"]
 *   }
 *
 * At least one of `internal_labels` or `internal_org_ids` must be an array of
 * non-empty strings. Orgs not matching the allowlist are blocked unless
 * `HXA_CONFIRM_ORG` names the exact resolved label on that command invocation.
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

function validateStringArray(value, fieldName, guardPath) {
  if (!Array.isArray(value)) {
    throw new Error(`${guardPath} "${fieldName}" must be an array`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      throw new Error(`${guardPath} ${fieldName} must contain non-empty strings`);
    }
  }
  return value;
}

/**
 * Read the guard allowlist config.
 *
 * Fail-closed: when the file is absent (`ENOENT`), returns an active
 * default-deny guard with empty allowlists so customer and non-with3 orgs are
 * never sent to by accident. A present but unreadable or malformed file throws
 * so broken configs never silently allow traffic.
 */
export function loadGuardConfig(guardPath = resolveGuardPath()) {
  let raw;
  try {
    raw = fs.readFileSync(guardPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        enabled: true,
        defaultDeny: true,
        path: guardPath,
        internalLabels: [],
        internalOrgIds: [],
      };
    }
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

  const hasLabels = Object.hasOwn(parsed, 'internal_labels');
  const hasOrgIds = Object.hasOwn(parsed, 'internal_org_ids');
  if (!hasLabels && !hasOrgIds) {
    throw new Error(`${guardPath} must have an "internal_labels" or "internal_org_ids" array`);
  }

  const internalLabels = hasLabels
    ? validateStringArray(parsed.internal_labels, 'internal_labels', guardPath)
    : [];
  const internalOrgIds = hasOrgIds
    ? validateStringArray(parsed.internal_org_ids, 'internal_org_ids', guardPath)
    : [];

  return {
    enabled: true,
    defaultDeny: false,
    path: guardPath,
    internalLabels,
    internalOrgIds,
  };
}

/**
 * Decide what to do with one send.
 *
 * Returns one of:
 *   { action: 'allow' }          — org matches allowlist (`internal_labels` or `internal_org_ids`)
 *   { action: 'confirm', ... }   — unlisted org, command-level `HXA_CONFIRM_ORG` matches
 *   { action: 'block', ... }     — unlisted org (or missing guard config), no confirmation
 *
 * Pure: no I/O, no process state, so it is cheap to test.
 */
export function evaluateSend({
  effectiveLabel,
  orgId = null,
  target,
  guard,
  confirmOrg,
  confirmFromEnvFile = false,
}) {
  const effectiveGuard = guard && typeof guard === 'object'
    ? guard
    : { enabled: true, defaultDeny: true, internalLabels: [], internalOrgIds: [] };
  const internalLabels = Array.isArray(effectiveGuard.internalLabels) ? effectiveGuard.internalLabels : [];
  const internalOrgIds = Array.isArray(effectiveGuard.internalOrgIds) ? effectiveGuard.internalOrgIds : [];

  if (internalLabels.includes(effectiveLabel)) {
    return { action: 'allow', guarded: false };
  }
  if (typeof orgId === 'string' && orgId !== '' && internalOrgIds.includes(orgId)) {
    return { action: 'allow', guarded: false };
  }

  const confirmed = !confirmFromEnvFile
    && typeof confirmOrg === 'string'
    && confirmOrg !== ''
    && confirmOrg === effectiveLabel;
  return {
    action: confirmed ? 'confirm' : 'block',
    guarded: true,
    defaultDeny: effectiveGuard.defaultDeny === true,
    guardPath: effectiveGuard.path || null,
    effectiveLabel,
    orgId: typeof orgId === 'string' && orgId !== '' ? orgId : null,
    target,
    internalLabels,
    internalOrgIds,
    // Tells a blocked operator why a value they thought was set did not work.
    ignoredEnvFileConfirmation: !confirmed && confirmFromEnvFile && confirmOrg === effectiveLabel,
  };
}

/**
 * Print the operator-facing lines for a guarded send. Kept next to the
 * decision so the wording and the rule cannot drift apart.
 *
 * The target, org label and org id are the only metadata printed;
 * the body is never echoed, and credentials are never touched.
 */
export function formatGuardMessage(decision) {
  const {
    action,
    target,
    effectiveLabel,
    orgId,
    internalLabels = [],
    internalOrgIds = [],
    defaultDeny = false,
  } = decision;

  if (action === 'block') {
    const lines = defaultDeny
      ? [
          `[hxa-connect] BLOCKED: outbound-guard.json not found — org "${effectiveLabel}" is denied by default (allowlist required) — message not sent`,
        ]
      : [
          `[hxa-connect] BLOCKED: org "${effectiveLabel}" is not in internal_labels / internal_org_ids — message not sent`,
        ];
    lines.push(`[hxa-connect] target: ${target}`);
    lines.push(`[hxa-connect] org label: ${effectiveLabel}`);
    if (orgId) lines.push(`[hxa-connect] org id: ${orgId}`);
    lines.push(`[hxa-connect] internal_labels: ${internalLabels.length ? internalLabels.join(', ') : '(none)'}`);
    if (internalOrgIds.length) {
      lines.push(`[hxa-connect] internal_org_ids: ${internalOrgIds.join(', ')}`);
    }
    if (decision.ignoredEnvFileConfirmation) {
      lines.push(`[hxa-connect] HXA_CONFIRM_ORG=${effectiveLabel} was found in ~/zylos/.env — ignored, pass it on this command instead`);
    }
    lines.push(`[hxa-connect] to send anyway: HXA_CONFIRM_ORG=${effectiveLabel} node send.js ...`);
    return lines.join('\n');
  }

  return `[hxa-connect] CONFIRMED EXTERNAL: org "${effectiveLabel}" approved by HXA_CONFIRM_ORG — target: ${target}`;
}
