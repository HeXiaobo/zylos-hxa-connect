import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AssistantResponseDeliveryStore } from '../src/lib/assistant-response-delivery.js';
import { createHxaFinalDeliveryAdapter } from '../src/lib/hxa-final-delivery-adapter.js';
import { createHxaFinalDeliveryComposition } from '../src/lib/hxa-final-delivery-composition.js';
import { canonicalPayloadHash, canonicalRouteHash, loadFixture } from './helpers/reply-contract-fixture.js';

const contract = loadFixture('hxa-wt02-c-accepted-v1.json');
const now = Date.parse('2026-09-01T00:00:00.000Z');
const tempDirs = [];

function intent() {
  return structuredClone(contract.intents.answer);
}

function claim(overrides = {}) {
  const value = intent();
  return {
    action: 'send',
    intent: value,
    deliveryId: `delivery:${value.intentId}`,
    attemptId: `attempt:delivery:${value.intentId}:1`,
    claimEpoch: 1,
    leaseOwner: 'core-owner',
    leaseToken: 'lease:1',
    leaseExpiresAt: Math.floor(now / 1000) + 300,
    ...overrides,
  };
}

async function setup() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-composition-'));
  tempDirs.push(directory);
  const store = new AssistantResponseDeliveryStore({ directory, clock: () => now });
  const sends = [];
  const client = {
    async send(target, text) {
      sends.push({ target, text });
      return { message: { id: `hub-${sends.length}` }, channel_id: 'dm-1' };
    },
    async inbox() { return []; },
  };
  const adapter = createHxaFinalDeliveryAdapter({
    store,
    defaultOrgLabel: 'hxa',
    clock: () => now,
    resolveOrg: async () => ({ client, agentId: 'self', agentName: 'agent' }),
    logger: { warn() {} },
  });
  const legacyDelivery = { async deliver() { throw new Error('legacy path used'); } };
  return {
    sends,
    store,
    composition: createHxaFinalDeliveryComposition({ adapter, legacyDelivery }),
  };
}

test.afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
});

test('canonical composition sends one fenced ReplyIntent and duplicate claims do not send twice', async () => {
  const { composition, sends } = await setup();
  const first = await composition.deliver(claim());
  const duplicate = await composition.deliver(claim());
  assert.equal(first.outcome, 'platform_accepted');
  assert.equal(duplicate.outcome, 'platform_accepted');
  assert.deepEqual(sends, [{ target: 'peer-agent', text: 'Exact terminal answer.' }]);
});

test('composition preserves unknown then reconcile-first recovery across restart', async () => {
  const first = await setup();
  const originalSend = first.sends;
  const source = intent();
  const failing = createHxaFinalDeliveryAdapter({
    store: first.store,
    defaultOrgLabel: 'hxa',
    clock: () => now,
    resolveOrg: async () => ({
      client: {
        async send() { originalSend.push('ambiguous'); throw new Error('socket closed'); },
        async inbox() { return []; },
      },
      agentId: 'self', agentName: 'agent',
    }),
    logger: { warn() {} },
  });
  const failingComposition = createHxaFinalDeliveryComposition({
    adapter: failing,
    legacyDelivery: { async deliver() { throw new Error('legacy path used'); } },
  });
  const unknown = await failingComposition.deliver(claim());
  assert.equal(unknown.outcome, 'unknown');
  const restarted = createHxaFinalDeliveryAdapter({
    store: first.store,
    defaultOrgLabel: 'hxa',
    clock: () => now,
    resolveOrg: async () => ({
      client: {
        async send() { throw new Error('must reconcile before retry'); },
        async inbox() { return [
          { id: 'source-message-001', sender_id: 'peer-agent', sender_name: 'peer-agent', content: 'request', channel_id: 'dm-1', created_at: now - 1 },
          { id: 'hub-after-restart', sender_id: 'self', sender_name: 'agent', content: source.payload.text, channel_id: 'dm-1', created_at: now + 1 },
        ]; },
      },
      agentId: 'self', agentName: 'agent',
    }),
    logger: { warn() {} },
  });
  const restartedComposition = createHxaFinalDeliveryComposition({
    adapter: restarted,
    legacyDelivery: { async deliver() { throw new Error('legacy path used'); } },
  });
  const recovered = await restartedComposition.deliver(claim({
    action: 'reconcile',
    claimEpoch: 2,
    leaseToken: 'lease:2',
  }));
  assert.equal(recovered.outcome, 'reconciled');
  assert.equal(originalSend.filter(value => value === 'ambiguous').length, 1);
});

test('canonical composition keeps ambiguous reconciliation unknown instead of claiming acceptance', async () => {
  const { store } = await setup();
  const value = intent();
  const routeHash = canonicalRouteHash(value.route);
  assert.equal(value.intentId, `reply:${value.requestId}:${routeHash}`);
  assert.equal(value.contentHash, canonicalPayloadHash(value.payload));
  let sends = 0;
  const unknownAdapter = createHxaFinalDeliveryAdapter({
    store,
    defaultOrgLabel: 'hxa',
    clock: () => now,
    resolveOrg: async () => ({
      client: {
        async send() { sends += 1; return { channel_id: 'dm-1', message: {} }; },
        async inbox() { return []; },
      },
      agentId: 'self', agentName: 'agent',
    }),
    logger: { warn() {} },
  });
  const unknownComposition = createHxaFinalDeliveryComposition({
    adapter: unknownAdapter,
    legacyDelivery: { async deliver() { throw new Error('legacy path used'); } },
  });
  const result = await unknownComposition.deliver(claim());
  assert.equal(result.outcome, 'unknown');
  const ambiguousAdapter = createHxaFinalDeliveryAdapter({
    store,
    defaultOrgLabel: 'hxa',
    clock: () => now,
    resolveOrg: async () => ({
      client: {
        async send() { throw new Error('must not send while reconciling'); },
        async inbox() { return [
          { id: 'source-message-001', sender_id: 'peer-agent', sender_name: 'peer-agent', content: 'request', channel_id: 'dm-1', created_at: now - 1 },
          { id: 'hub-duplicate-1', sender_id: 'self', sender_name: 'agent', content: value.payload.text, channel_id: 'dm-1', created_at: now + 1 },
          { id: 'hub-duplicate-2', sender_id: 'self', sender_name: 'agent', content: value.payload.text, channel_id: 'dm-1', created_at: now + 2 },
        ]; },
      },
      agentId: 'self', agentName: 'agent',
    }),
    logger: { warn() {} },
  });
  const resultAfterRestart = await createHxaFinalDeliveryComposition({
    adapter: ambiguousAdapter,
    legacyDelivery: { async deliver() { throw new Error('legacy path used'); } },
  }).deliver(claim({ action: 'reconcile', claimEpoch: 2, leaseToken: 'lease:2' }));
  assert.equal(resultAfterRestart.outcome, 'unknown');
  assert.equal(resultAfterRestart.errorCode, 'HXA_RECONCILE_RESULT_UNKNOWN');
  assert.equal(sends, 1);
  const record = await store.read(`delivery:${value.intentId}`);
  assert.equal(record.receipts.length, 2);
});
