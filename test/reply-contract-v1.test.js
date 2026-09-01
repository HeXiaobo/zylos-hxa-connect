import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertNoUserReceivedClaim,
  assertRuntimeEventIdentity,
  contentHash,
  loadFixture,
} from './helpers/reply-contract-fixture.js';

const contract = loadFixture('reply-contract-v1.json');
const characterization = loadFixture('hxa-current-behavior-v1.json');

describe('Zylos reply contract v1 for HXA', () => {
  it('declares terminal-only HXA capability without an official-parity claim', () => {
    assert.equal(contract.schemaVersion, 1);
    assert.equal(contract.contract, 'zylos.reply/v1');
    assert.equal(contract.adapterId, 'hxa-connect');
    assert.deepEqual(contract.capabilities, {
      deliveryMode: 'terminal_only',
      progressSubscription: false,
      cardKit: false,
      replyPresence: false,
      physicalStoreOwner: 'hxa-connect',
      sharesPhysicalStoreWithFeishu: false,
    });
    assert.equal(characterization.officialPeer.verified, false);
    assert.equal(characterization.officialPeer.repository, null);
    assert.match(characterization.officialPeer.claim, /no upstream-parity claim/i);
  });

  it('uses the common RunCompleted, RunFailed, ReplyIntent, DeliveryReceipt and silent vector names', () => {
    assert.deepEqual(Object.keys(contract.vectors).sort(), [
      'DeliveryReceipt',
      'ReplyIntent',
      'RunCompleted',
      'RunFailed',
      'silent',
    ]);
  });

  it('keeps complete request, turn, sequence, trace and causation identity on run terminals', () => {
    const completed = contract.vectors.RunCompleted;
    const failed = contract.vectors.RunFailed;
    const silent = contract.vectors.silent.runEvent;
    for (const event of [completed, failed, silent]) assertRuntimeEventIdentity(event);
    assert.equal(completed.payload.outcome.kind, 'answer');
    assert.equal(failed.payload.outcome.kind, 'failure');
    assert.equal(silent.payload.outcome.kind, 'silent');
  });

  it('keeps HXA route targetRef opaque and derives intents only from run terminals', () => {
    const { answer, failure_notice: failureNotice } = contract.vectors.ReplyIntent;
    for (const intent of [answer, failureNotice]) {
      assert.equal(intent.schemaVersion, 1);
      assert.equal(intent.type, 'ReplyIntent');
      assert.equal(intent.cause.kind, 'run_terminal');
      assert.equal(intent.route.adapterId, 'hxa-connect');
      assert.deepEqual(Object.keys(intent.route).sort(), ['adapterId', 'targetRef']);
      assert.equal(intent.idempotencyKey, intent.intentId);
      assert.equal(intent.contentHash, contentHash(intent.payload.text));
    }
    assert.equal(answer.cause.eventId, contract.vectors.RunCompleted.eventId);
    assert.equal(failureNotice.cause.eventId, contract.vectors.RunFailed.eventId);
    assert.equal(answer.disposition, 'send');
    assert.equal(failureNotice.disposition, 'failure_notice');
  });

  it('makes silence explicit and creates no HXA send intent', () => {
    const { silent } = contract.vectors;
    assert.equal(silent.runEvent.payload.outcome.kind, 'silent');
    assert.equal(silent.replyIntent, null);
    assert.deepEqual(silent.settlement, {
      status: 'suppressed',
      deliveryRequired: false,
    });
    assert.deepEqual(contract.normalization.skipCompatibilityInput.normalizedOutcome, {
      kind: 'silent',
      reason: 'legacy_skip_marker',
    });
    assert.equal(contract.normalization.skipCompatibilityInput.expectedHubMessages, 0);
  });

  it('rejects an empty visible answer instead of manufacturing success text', () => {
    assert.equal(contract.normalization.emptyVisibleAnswer.input, '');
    assert.equal(contract.normalization.emptyVisibleAnswer.expectedError, 'MISSING_OUTPUT');
  });

  it('does not project progress, CardKit or Reply Presence into HXA', () => {
    assert.deepEqual(contract.terminalOnlyInputs, [
      { type: 'ProgressUpdated', expectedHubMessages: 0 },
      { type: 'OutputDelta', expectedHubMessages: 0 },
    ]);
    assert.equal(contract.capabilities.cardKit, false);
    assert.equal(contract.capabilities.replyPresence, false);
  });

  it('separates platform acceptance and reconciliation from user-read claims', () => {
    const receipts = contract.vectors.DeliveryReceipt;
    assert.deepEqual(Object.keys(receipts).sort(), [
      'dead_letter',
      'platform_accepted',
      'reconciled',
      'unknown',
    ]);
    for (const receipt of Object.values(receipts)) {
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.type, 'DeliveryReceipt');
      assert.equal(receipt.adapterId, 'hxa-connect');
      assertNoUserReceivedClaim(receipt);
    }
    assert.equal(receipts.unknown.nextAction, 'reconcile');
  });

  it('freezes duplicate, conflict, reconcile, DLQ, redrive and restart invariants', () => {
    const scenarios = contract.deliveryScenarios;
    assert.equal(scenarios.duplicate.expectedHubMessages, 1);
    assert.equal(scenarios.payload_conflict.expectedError, 'IDEMPOTENCY_CONFLICT');
    assert.notEqual(
      scenarios.payload_conflict.originalContentHash,
      scenarios.payload_conflict.replayedContentHash,
    );
    assert.deepEqual(scenarios.unknown_then_reconcile.transitions, [
      'sending',
      'unknown',
      'reconcile',
      'reconciled',
    ]);
    assert.equal(scenarios.unknown_then_reconcile.retryBeforeReconcile, false);
    assert.deepEqual(scenarios.unknown_then_retry.transitions, [
      'sending',
      'unknown',
      'reconcile',
      'retrying',
      'sending',
      'platform_accepted',
    ]);
    assert.equal(scenarios.unknown_then_retry.reconcileBeforeRetry, true);
    assert.equal(scenarios.dead_letter_isolation.batchContinues, true);
    assert.equal(scenarios.dead_letter_isolation.runOutcomeAfterDeliveryFailure, 'completed');
    assert.equal(scenarios.redrive.originalIntentId, scenarios.redrive.redriveIntentId);
    assert.equal(scenarios.redrive.originalDeliveryId, scenarios.redrive.redriveDeliveryId);
    assert.equal(
      scenarios.restart_recovery.beforeRestartIntentId,
      scenarios.restart_recovery.afterRestartIntentId,
    );
    assert.equal(
      scenarios.restart_recovery.beforeRestartDeliveryId,
      scenarios.restart_recovery.afterRestartDeliveryId,
    );
  });
});

describe('HXA reply contract target gaps', () => {
  const gaps = new Set(characterization.targetGaps.map(gap => gap.id));

  it('records every currently unimplemented target behavior', () => {
    assert.deepEqual([...gaps].sort(), [
      'HXA_DLQ_REDRIVE',
      'HXA_EXPLICIT_SILENT',
      'HXA_FAILURE_NOTICE',
      'HXA_IDEMPOTENCY_CONFLICT',
      'HXA_MISSING_OUTPUT',
      'HXA_RECEIPT_V1',
      'HXA_REPLY_INTENT_V1',
    ]);
  });

  it.todo('HXA_REPLY_INTENT_V1: accept the common ReplyIntent envelope directly');
  it.todo('HXA_MISSING_OUTPUT: reject empty visible answers with MISSING_OUTPUT');
  it.todo('HXA_IDEMPOTENCY_CONFLICT: expose the common payload-conflict error code');
  it.todo('HXA_FAILURE_NOTICE: deliver an explicit failure_notice intent');
  it.todo('HXA_EXPLICIT_SILENT: consume explicit silent without relying on [SKIP]');
  it.todo('HXA_RECEIPT_V1: persist common attempt and DeliveryReceipt outcomes');
  it.todo('HXA_DLQ_REDRIVE: isolate dead letters and redrive with the original identities');
});
