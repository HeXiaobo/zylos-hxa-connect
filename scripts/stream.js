#!/usr/bin/env node

import { HxaConnectClient } from '@coco-xyz/hxa-connect-sdk';
import { migrateConfig, resolveOrgs, setupFetchProxy } from '../src/env.js';
import { getRuntimePaths } from '../src/lib/config-path.js';
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
    const labels = Object.keys(resolved.orgs);
    const defaultOrgLabel = resolved.orgs.default ? 'default' : labels[0];
    const clients = new Map();
    const resolveOrg = async label => {
      const org = resolved.orgs[label];
      if (!org) throw new Error(`HXA response org not found: ${label}`);
      if (!org.hubUrl) throw new Error(`HXA response org has no hub URL: ${label}`);
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
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`[hxa-connect] Assistant response stream delivery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
