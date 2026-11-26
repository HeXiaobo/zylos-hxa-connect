#!/usr/bin/env node

import { HxaConnectClient } from '@coco-xyz/hxa-connect-sdk';
import { cameFromEnvFile, migrateConfig, resolveOrgs, setupFetchProxy } from '../src/env.js';
import { getRuntimePaths } from '../src/lib/config-path.js';
import {
  CONFIRM_ENV, evaluateSend, formatGuardMessage, loadGuardConfig,
} from '../src/lib/outbound-guard.js';
import { redactSecrets } from '../src/lib/redact.js';
import {
  AssistantResponseDeliveryStore,
  createAssistantResponseDelivery,
  resolveFinalDeliveryMode,
} from '../src/lib/assistant-response-delivery.js';
import { createHxaFinalDeliveryAdapter } from '../src/lib/hxa-final-delivery-adapter.js';
import {
  createHxaFinalDeliveryComposition,
  isCanonicalHxaDelivery,
} from '../src/lib/hxa-final-delivery-composition.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

/**
 * Refuse to build a client for an org the outbound guard blocks.
 *
 * The terminal auto-delivery path is a real outbound send, so it obeys exactly
 * the rule `scripts/send.js` applies: an org outside `internal_labels` needs
 * `HXA_CONFIRM_ORG` on THIS invocation, and a value that came from
 * ~/zylos/.env never counts. A blocked call throws before a client exists and
 * therefore never returns a success receipt — the caller gets a non-zero exit
 * and an explicit "not delivered" line.
 */
function enforceOutboundGuard({ guard, label, orgId }) {
  const decision = evaluateSend({
    effectiveLabel: label,
    orgId,
    target: label,
    guard,
    confirmOrg: process.env[CONFIRM_ENV],
    confirmFromEnvFile: cameFromEnvFile(CONFIRM_ENV),
  });
  if (decision.action === 'allow') return;
  const line = formatGuardMessage(decision);
  if (decision.action === 'confirm') {
    console.error(line);
    return;
  }
  const error = new Error(`${line}\n[hxa-connect] not delivered: blocked by the outbound org guard`);
  error.code = 'HXA_OUTBOUND_GUARD_BLOCKED';
  error.delivered = false;
  throw error;
}

async function main() {
  try {
    const mode = resolveFinalDeliveryMode(process.env);
    const input = JSON.parse(await readStdin());
    console.error(`[hxa-connect] stream delivery mode=${mode} requestId=${input?.requestId ?? '(none)'}`);

    // 'off' (default): the component never auto-delivers terminal events.
    // Consume the stream and exit successfully so the supervisor acknowledges
    // the deliveries and core records the terminal request state; every
    // outbound message must come from an explicit c4-send invocation instead.
    if (mode === 'off') {
      process.stdout.write(`${JSON.stringify({ ok: true, mode, status: 'suppressed' })}\n`);
      return;
    }

    await setupFetchProxy();
    const resolved = resolveOrgs(migrateConfig());
    const { assistantResponseDir } = getRuntimePaths();
    // Fail closed before anything is created: a malformed guard stops the run
    // instead of silently allowing every org through.
    const guard = loadGuardConfig();
    const labels = Object.keys(resolved.orgs);
    const defaultOrgLabel = resolved.orgs.default ? 'default' : labels[0];
    const clients = new Map();
    const resolveOrg = async label => {
      const org = resolved.orgs[label];
      if (!org) throw new Error(`HXA response org not found: ${label}`);
      if (!org.hubUrl) throw new Error(`HXA response org has no hub URL: ${label}`);
      enforceOutboundGuard({ guard, label, orgId: org.orgId });
      if (!clients.has(label)) {
        clients.set(label, new HxaConnectClient({
          url: org.hubUrl,
          token: org.agentToken,
          ...(org.orgId && { orgId: org.orgId }),
        }));
      }
      return {
        client: clients.get(label),
        agentId: org.agentId,
        agentName: org.agentName,
      };
    };
    const store = new AssistantResponseDeliveryStore({
      directory: assistantResponseDir,
    });
    const legacyDelivery = createAssistantResponseDelivery({ store, resolveOrg, defaultOrgLabel });
    const adapter = createHxaFinalDeliveryAdapter({ store, resolveOrg, defaultOrgLabel });
    const delivery = createHxaFinalDeliveryComposition({ adapter, legacyDelivery, mode });
    const result = mode === 'legacy' || !isCanonicalHxaDelivery(input)
      ? await legacyDelivery.deliver(input)
      : await delivery.deliver(input);
    // A delivery receipt is not a delivery: the `ok` flag here only says the
    // adapter ran. `status`/`outcome` carry whether the message actually left.
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    // A failure never looks like a delivery. The receipt shape stays the same
    // (one JSON line on stdout) so a caller that parses it sees ok:false, and
    // the machine-readable code survives — HXA_OUTBOUND_GUARD_BLOCKED must not
    // degrade into a generic send error.
    process.stderr.write(`[hxa-connect] Assistant response stream delivery failed: ${redactSecrets(String(error?.message || error))}\n`);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 'not_delivered',
      errorCode: typeof error?.code === 'string' ? error.code : 'HXA_STREAM_DELIVERY_FAILED',
    })}\n`);
    process.exitCode = 1;
  }
}

main();
