#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';

import { HxaConnectClient } from '@coco-xyz/hxa-connect-sdk';
import { migrateConfig, resolveOrgs, setupFetchProxy } from '../src/env.js';
import {
  AssistantResponseDeliveryStore,
  createAssistantResponseDelivery,
} from '../src/lib/assistant-response-delivery.js';

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
    await setupFetchProxy();
    const resolved = resolveOrgs(migrateConfig());
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
    const home = process.env.HOME || os.homedir();
    const store = new AssistantResponseDeliveryStore({
      directory: path.join(home, 'zylos/components/hxa-connect/assistant-response-deliveries'),
    });
    const delivery = createAssistantResponseDelivery({ store, resolveOrg, defaultOrgLabel });
    const result = await delivery.deliver(JSON.parse(await readStdin()));
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`[hxa-connect] Assistant response stream delivery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
