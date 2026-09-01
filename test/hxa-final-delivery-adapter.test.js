import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { AssistantResponseDeliveryStore } from '../src/lib/assistant-response-delivery.js';
import { createHxaFinalDeliveryAdapter } from '../src/lib/hxa-final-delivery-adapter.js';
import {
  assertDeliveryReceipt,
  contentHash,
  loadFixture,
} from './helpers/reply-contract-fixture.js';

const contract = loadFixture('reply-contract-v1.json');
const phaseA = loadFixture('hxa-final-delivery-phase-a-v1.json');
const tempDirs = [];
const NOW = Date.parse('2026-09-01T00:00:00.000Z');

function clone(value) {
  return structuredClone(value);
}

function answerIntent() {
  return clone(contract.vectors.ReplyIntent.answer);
}

function failureIntent() {
  return clone(contract.vectors.ReplyIntent.failure_notice);
}

function attempt(attemptId = phaseA.attemptContext.attemptId, ownerId = phaseA.attemptContext.ownerId) {
  return { attemptId, ownerId };
}

async function createStore(directory = null) {
  const target = directory || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-final-adapter-'));
  if (!directory) tempDirs.push(target);
  return new AssistantResponseDeliveryStore({ directory: target, clock: () => NOW });
}

function createAdapter({ store, client, resolveOrg, logger } = {}) {
  return createHxaFinalDeliveryAdapter({
    store,
    defaultOrgLabel: 'hxa',
    clock: () => NOW,
    resolveOrg: resolveOrg || (async label => {
      assert.equal(label, 'hxa');
      return { client, agentId: 'self-agent-id', agentName: 'self-agent' };
    }),
    logger: logger || { warn() {}, error() {} },
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

describe('HxaFinalDeliveryAdapter Phase A', () => {
  it('uses an adapter-private Phase A seam without guessing the pending WT02-C API', () => {
    assert.equal(phaseA.scope, 'adapter_private_phase_a');
    assert.deepEqual(phaseA.upstreamControl, {
      repository: 'openmaxai/zylos-hxa-connect',
      sha: '160dbaeac86f503b2d1889343354c5aee3b57785',
      relationship: 'exact_merge_base_12_fork_commits_ahead',
      retained: [
        'channel_name_fixed_to_hxa-connect',
        'org_routing_inside_endpoint',
        'explicit_dm_and_thread_routes',
        'bare_uuid_thread_detection_with_dm_404_fallback',
        'thread_reply_to_with_missing_message_fallback',
      ],
    });
    assert.deepEqual(phaseA.externalReview, {
      issue: 'HeXiaobo/zylos-hxa-connect#20',
      pullRequest: 'HeXiaobo/zylos-hxa-connect#21',
      reviewedHead: '359e3b6c4e619f2104cce7257226f74eaf72c77b',
      phaseADecision: 'adopt_invisible_content_detection_as_missing_output',
      excludedLegacyFiles: [
        'CHANGELOG.md',
        'scripts/send.js',
        'src/lib/silent-response.js',
      ],
    });
    assert.deepEqual(phaseA.capability.acceptedDispositions, ['send', 'failure_notice']);
    assert.equal(phaseA.integrationSeam.status, 'TODO_WAIT_FOR_WT02_C_ACCEPTANCE');
  });

  it('delivers the frozen answer ReplyIntent to the exact DM route', async () => {
    const store = await createStore();
    const sends = [];
    const adapter = createAdapter({
      store,
      client: {
        async send(target, text) {
          sends.push({ target, text });
          return { channel_id: 'dm-channel-1', message: { id: 'hub-answer-1' } };
        },
      },
    });

    const receipt = await adapter.deliver(answerIntent(), attempt());

    assertDeliveryReceipt(receipt);
    assert.equal(receipt.outcome, 'platform_accepted');
    assert.equal(receipt.externalRef, 'opaque:hub-answer-1');
    assert.deepEqual(sends, [{
      target: 'peer-agent',
      text: 'Exact terminal answer.',
    }]);
  });

  it('delivers an explicit failure_notice inside the exact thread and reply target', async () => {
    const store = await createStore();
    const sends = [];
    const adapter = createAdapter({
      store,
      client: {
        async sendThreadMessage(threadId, text, options) {
          sends.push({ threadId, text, options });
          return { id: 'hub-failure-1' };
        },
      },
    });

    const receipt = await adapter.deliver(failureIntent(), attempt('attempt:failure:1'));

    assertDeliveryReceipt(receipt);
    assert.equal(receipt.outcome, 'platform_accepted');
    assert.deepEqual(sends, [{
      threadId: 'thread-002',
      text: 'The assistant could not complete this request.',
      options: { reply_to: 'source-message-002' },
    }]);
  });

  it('preserves the HXA reply-to fallback when the source thread message disappeared', async () => {
    const store = await createStore();
    const calls = [];
    const adapter = createAdapter({
      store,
      client: {
        async sendThreadMessage(threadId, text, options) {
          calls.push({ threadId, text, options });
          if (options?.reply_to) {
            const error = new Error('reply target not found');
            error.status = 400;
            throw error;
          }
          return { id: 'hub-thread-fallback-1' };
        },
      },
    });

    const receipt = await adapter.deliver(failureIntent(), attempt('attempt:failure-fallback:1'));

    assert.equal(receipt.outcome, 'platform_accepted');
    assert.equal(receipt.externalRef, 'opaque:hub-thread-fallback-1');
    assert.deepEqual(calls.map(call => call.options), [
      { reply_to: 'source-message-002' },
      undefined,
    ]);
  });

  it('suppresses explicit silent, suppress compatibility, and [SKIP] without transport effects', async () => {
    const store = await createStore();
    let resolved = 0;
    const adapter = createAdapter({
      store,
      resolveOrg: async () => {
        resolved += 1;
        throw new Error('transport must not be resolved');
      },
    });
    const silent = clone(contract.vectors.silent.outcome);
    const suppress = answerIntent();
    suppress.disposition = 'suppress';
    const skip = answerIntent();
    skip.payload.text = '  [SKIP]  ';
    skip.contentHash = contentHash(skip.payload.text);

    for (const result of [
      await adapter.deliver(silent),
      await adapter.deliver(suppress),
      await adapter.deliver(skip),
    ]) {
      assert.equal(result.status, 'suppressed');
      assert.equal(result.normalizedAction, 'suppress');
      assert.equal(result.deliveryRequired, false);
      assert.equal(result.receipt, null);
      assert.notEqual(result.outcome, 'platform_accepted');
    }
    assert.equal(resolved, 0);
    const records = (await fs.promises.readdir(store.directory).catch(() => []))
      .filter(name => name.endsWith('.json'));
    assert.equal(records.length, 1, '[SKIP] keeps a durable compatibility identity');
  });

  it('rejects blank visible send content with MISSING_OUTPUT and creates no success record', async () => {
    const store = await createStore();
    let resolved = 0;
    const adapter = createAdapter({
      store,
      resolveOrg: async () => {
        resolved += 1;
        throw new Error('transport must not be resolved');
      },
    });
    const invisibleOnlyInputs = [
      ' \n\t ',
      '\u200B',
      '\u200C',
      '\u200D',
      '\u2060',
      '\uFEFF',
      ' \t\u200B\u200C\u200D\u2060\uFEFF\n',
    ];
    for (const text of invisibleOnlyInputs) {
      const intent = answerIntent();
      intent.payload.text = text;
      intent.contentHash = contentHash(text);
      await assert.rejects(
        adapter.deliver(intent, attempt()),
        error => error.code === 'MISSING_OUTPUT',
      );
    }
    assert.equal(resolved, 0);
    assert.deepEqual(await fs.promises.readdir(store.directory).catch(() => []), []);
  });

  it('does not emit a second bot-to-bot message for a closing turn followed by invisible output', async () => {
    const store = await createStore();
    const sent = [];
    const adapter = createAdapter({
      store,
      client: {
        async send(target, text) {
          sent.push({ target, text });
          return { message: { id: `hub-loop-${sent.length}` } };
        },
      },
    });
    const closing = answerIntent();
    closing.payload.text = phaseA.botLoopRegression.closingTurnText;
    closing.contentHash = contentHash(closing.payload.text);
    const empty = answerIntent();
    empty.intentId = 'reply:req:hxa:dm:message-loop-empty:hxa-route-001';
    empty.idempotencyKey = empty.intentId;
    empty.requestId = 'req:hxa:dm:message-loop-empty';
    empty.traceId = 'trace:hxa:dm:message-loop-empty';
    empty.payload.text = phaseA.botLoopRegression.emptyTurnText;
    empty.contentHash = contentHash(empty.payload.text);

    const first = await adapter.deliver(closing, attempt('attempt:loop:1'));
    await assert.rejects(
      adapter.deliver(empty, attempt('attempt:loop:2')),
      error => error.code === phaseA.botLoopRegression.emptyTurnExpectedError,
    );

    assert.equal(first.outcome, 'platform_accepted');
    assert.equal(sent.length, phaseA.botLoopRegression.expectedHubMessages);
    assert.equal(sent.some(item => item.text === phaseA.botLoopRegression.forbiddenReplacement), false);
  });

  it('returns explicit unsupported results for progress, output deltas, task receipts, media, and foreign routes', async () => {
    const store = await createStore();
    let resolved = 0;
    const adapter = createAdapter({
      store,
      resolveOrg: async () => {
        resolved += 1;
        throw new Error('transport must not be resolved');
      },
    });
    const taskReceipt = answerIntent();
    taskReceipt.disposition = 'task_receipt';
    const media = answerIntent();
    media.payload = { format: 'media', refs: ['opaque:file-1'] };
    const foreign = answerIntent();
    foreign.route.adapterId = 'feishu';
    const legacyChannel = answerIntent();
    legacyChannel.route.targetRef = 'org:hxa|channel:legacy-group';

    for (const input of [
      { schemaVersion: 1, type: 'ProgressUpdated' },
      { schemaVersion: 1, type: 'OutputDelta' },
      taskReceipt,
      media,
      foreign,
      legacyChannel,
    ]) {
      const result = await adapter.deliver(input, attempt());
      assert.equal(result.status, 'unsupported');
      assert.equal(result.handled, false);
      assert.equal(result.receipt, null);
      assert.match(result.errorCode, /^UNSUPPORTED_/);
    }
    assert.equal(resolved, 0);
  });

  it('replays the same intent and repeated attempt without a second external message', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-final-restart-'));
    tempDirs.push(directory);
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        return { message: { id: 'hub-replay-1' }, channel_id: 'dm-channel-1' };
      },
    };
    const first = createAdapter({ store: await createStore(directory), client });
    const receipt = await first.deliver(answerIntent(), attempt());
    const replay = await first.deliver(answerIntent(), attempt());
    const restarted = createAdapter({ store: await createStore(directory), client });
    const afterRestart = await restarted.deliver(answerIntent(), attempt('attempt:new-owner:2', 'owner-b'));

    assert.deepEqual(replay, receipt);
    assert.deepEqual(afterRestart, receipt);
    assert.equal(sends, 1);
  });

  it('fails closed on same intent identity with different payload, hash, or route', async () => {
    const store = await createStore();
    let sends = 0;
    const adapter = createAdapter({
      store,
      client: {
        async send() {
          sends += 1;
          return { message: { id: 'hub-original-1' } };
        },
      },
    });
    await adapter.deliver(answerIntent(), attempt());

    const payloadConflict = answerIntent();
    payloadConflict.payload.text = 'Different answer.';
    payloadConflict.contentHash = contentHash(payloadConflict.payload.text);
    const hashConflict = answerIntent();
    hashConflict.contentHash = contentHash('not the payload');
    const routeConflict = answerIntent();
    routeConflict.route.targetRef = 'org:hxa|different-peer';
    const skipConflict = answerIntent();
    skipConflict.payload.text = '[SKIP]';
    skipConflict.contentHash = contentHash(skipConflict.payload.text);

    for (const conflict of [payloadConflict, hashConflict, routeConflict, skipConflict]) {
      await assert.rejects(
        adapter.deliver(conflict, attempt('attempt:conflict')),
        error => error.code === 'IDEMPOTENCY_CONFLICT',
      );
    }
    assert.equal(sends, 1);
  });

  it('returns unknown on timeout, blocks direct retry, then reconciles to accepted without a duplicate send', async () => {
    const store = await createStore();
    const inbox = [{
      id: 'source-message-001',
      channel_id: 'dm-channel-1',
      sender_id: 'peer-id',
      sender_name: 'peer-agent',
      content: 'request',
      created_at: NOW - 100,
    }];
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        inbox.push({
          id: 'hub-ambiguous-1',
          channel_id: 'dm-channel-1',
          sender_id: 'self-agent-id',
          sender_name: 'self-agent',
          content: 'Exact terminal answer.',
          created_at: NOW + 10,
        });
        const error = new Error('request timed out after write');
        error.code = 'ETIMEDOUT';
        throw error;
      },
      async inbox() { return inbox; },
    };
    const adapter = createAdapter({ store, client });

    const unknown = await adapter.deliver(answerIntent(), attempt('attempt:timeout:1'));
    const blockedRetry = await adapter.deliver(answerIntent(), attempt('attempt:timeout:2'));
    const reconciled = await adapter.reconcile(answerIntent(), attempt('attempt:timeout:1'));

    assertDeliveryReceipt(unknown);
    assert.equal(unknown.outcome, 'unknown');
    assert.equal(unknown.nextAction, 'reconcile_before_retry');
    assert.deepEqual(blockedRetry, unknown);
    assertDeliveryReceipt(reconciled);
    assert.equal(reconciled.outcome, 'reconciled');
    assert.equal(reconciled.externalRef, 'opaque:hub-ambiguous-1');
    assert.equal(sends, 1);
  });

  it('recovers a crash-left sending record after restart by reconciling before any resend', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-final-crash-'));
    tempDirs.push(directory);
    const inbox = [{
      id: 'source-message-001',
      channel_id: 'dm-channel-1',
      sender_id: 'peer-id',
      sender_name: 'peer-agent',
      content: 'request',
      created_at: NOW - 100,
    }];
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        inbox.push({
          id: 'hub-crash-accepted-1',
          channel_id: 'dm-channel-1',
          sender_id: 'self-agent-id',
          sender_name: 'self-agent',
          content: 'Exact terminal answer.',
          created_at: NOW + 10,
        });
        return { message: { id: 'hub-crash-accepted-1' } };
      },
      async inbox() { return inbox; },
    };
    const store = await createStore(directory);
    const first = createAdapter({ store, client });
    const accepted = await first.deliver(answerIntent(), attempt('attempt:crash:1', 'owner-before-crash'));
    const record = await store.read(accepted.deliveryId);
    await store.update(record, {
      status: 'sending',
      receipts: [],
      hubMessageId: null,
      currentAttemptId: 'attempt:crash:1',
      activeLease: {
        kind: 'send',
        ownerId: 'owner-before-crash',
        attemptId: 'attempt:crash:1',
        token: 'stale-dead-owner-token',
        fence: record.fence,
      },
    }, { expectedFence: record.fence });

    const restarted = createAdapter({
      store: await createStore(directory),
      client,
    });
    const reconciled = await restarted.reconcile(
      answerIntent(),
      attempt('attempt:crash:1', 'owner-after-restart'),
    );

    assert.equal(reconciled.outcome, 'reconciled');
    assert.equal(reconciled.externalRef, 'opaque:hub-crash-accepted-1');
    assert.equal(sends, 1);
  });

  it('reconciles not-found before allowing a new attempt to retry', async () => {
    const store = await createStore();
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        if (sends === 1) {
          const error = new Error('socket result unknown');
          error.code = 'ECONNRESET';
          throw error;
        }
        return { message: { id: 'hub-retry-2' } };
      },
      async inbox() {
        return [{
          id: 'source-message-001',
          channel_id: 'dm-channel-1',
          sender_id: 'peer-id',
          sender_name: 'peer-agent',
          content: 'request',
          created_at: NOW - 100,
        }];
      },
    };
    const adapter = createAdapter({ store, client });

    const unknown = await adapter.deliver(answerIntent(), attempt('attempt:not-found:1'));
    const notFound = await adapter.reconcile(answerIntent(), attempt('attempt:not-found:1'));
    const accepted = await adapter.deliver(answerIntent(), attempt('attempt:not-found:2'));

    assert.equal(unknown.outcome, 'unknown');
    assert.equal(notFound.outcome, 'rejected');
    assert.equal(notFound.errorCode, 'HXA_RECONCILE_NOT_FOUND');
    assert.equal(notFound.retryable, true);
    assert.equal(accepted.outcome, 'platform_accepted');
    assert.equal(sends, 2);
  });

  it('does not claim platform acceptance when the HXA process result lacks a real message identity', async () => {
    const store = await createStore();
    const adapter = createAdapter({
      store,
      client: { async send() { return {}; } },
    });

    const receipt = await adapter.deliver(answerIntent(), attempt('attempt:no-receipt:1'));

    assertDeliveryReceipt(receipt);
    assert.equal(receipt.outcome, 'unknown');
    assert.equal(receipt.externalRef, null);
  });

  it('classifies a permanent HXA rejection without pretending it was accepted', async () => {
    const store = await createStore();
    let sends = 0;
    const adapter = createAdapter({
      store,
      client: {
        async send() {
          sends += 1;
          const error = new Error('forbidden');
          error.status = 403;
          throw error;
        },
      },
    });

    const receipt = await adapter.deliver(answerIntent(), attempt('attempt:permanent:1'));
    const replay = await adapter.deliver(answerIntent(), attempt('attempt:permanent:2'));

    assertDeliveryReceipt(receipt);
    assert.equal(receipt.outcome, 'rejected');
    assert.equal(receipt.retryable, false);
    assert.equal(receipt.errorCode, 'HXA_PLATFORM_REJECTED');
    assert.deepEqual(replay, receipt);
    assert.equal(sends, 1);
  });

  it('serializes concurrent owners and persists intent, content hash, lease fence, attempts, and receipt', async () => {
    const store = await createStore();
    let sends = 0;
    const adapter = createAdapter({
      store,
      client: {
        async send() {
          sends += 1;
          await new Promise(resolve => setTimeout(resolve, 40));
          return { message: { id: 'hub-concurrent-1' } };
        },
      },
    });

    const [first, second] = await Promise.all([
      adapter.deliver(answerIntent(), attempt('attempt:concurrent:1', 'owner-a')),
      adapter.deliver(answerIntent(), attempt('attempt:concurrent:2', 'owner-b')),
    ]);

    assert.deepEqual(second, first);
    assert.equal(sends, 1);
    const record = await store.read(first.deliveryId);
    assert.equal(record.intentId, answerIntent().intentId);
    assert.equal(record.contentHash, answerIntent().contentHash);
    assert.equal(record.status, 'accepted');
    assert.equal(record.fence, 1);
    assert.equal(record.attempts, 1);
    assert.equal(record.receipts.length, 1);
    await assert.rejects(
      store.update(record, { status: 'corrupted' }, { expectedFence: 0 }),
      error => error.code === 'HXA_DELIVERY_FENCE_LOST',
    );
  });

  it('preserves the official bare UUID endpoint compatibility while keeping route parsing inside HXA', async () => {
    const store = await createStore();
    const intent = answerIntent();
    intent.route.targetRef = 'org:hxa|11111111-2222-3333-4444-555555555555';
    intent.contentHash = contentHash(intent.payload.text);
    const sends = [];
    const adapter = createAdapter({
      store,
      client: {
        async getThread(threadId) { return { id: threadId }; },
        async sendThreadMessage(threadId, text) {
          sends.push({ threadId, text });
          return { id: 'hub-uuid-thread-1' };
        },
      },
    });

    const receipt = await adapter.deliver(intent, attempt('attempt:uuid:1'));

    assert.equal(receipt.outcome, 'platform_accepted');
    assert.deepEqual(sends, [{
      threadId: '11111111-2222-3333-4444-555555555555',
      text: 'Exact terminal answer.',
    }]);
  });
});
