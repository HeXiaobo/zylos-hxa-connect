import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMMON_CONTRACT_SHA256,
  assertCommonContractDigest,
  assertDeliveryReceipt,
  assertDeliverySettlement,
  assertNoUserReceivedClaim,
  assertReplyIntent,
  assertReplyOutcome,
  assertRuntimeEventIdentity,
  contentHash,
  loadCommonContractFixture,
  loadFixture,
} from './helpers/reply-contract-fixture.js';

const contract = loadFixture('reply-contract-v1.json');
const common = loadCommonContractFixture();
const characterization = loadFixture('hxa-current-behavior-v1.json');

describe('Zylos reply contract v1 for HXA', () => {
  it('declares terminal-only HXA capability without an official-parity claim', () => {
    assert.equal(contract.schemaVersion, 1);
    assert.equal(contract.contractId, 'zylos.assistant-reply-contract/v1');
    assert.deepEqual(contract.commonFixture, {
      file: 'common-contract-vectors.json',
      sha256: COMMON_CONTRACT_SHA256,
    });
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

  it('vendors the frozen common vectors byte-for-byte', () => {
    assert.equal(assertCommonContractDigest(), COMMON_CONTRACT_SHA256);
    assert.equal(common.schemaVersion, 1);
    assert.equal(common.contractId, contract.contractId);
    assert.ok(common.acceptMessage);
    assert.ok(common.cancelRequest);
    assert.ok(common.contextSnapshot);
    assert.ok(common.taskCommand);
    assert.ok(Array.isArray(common.runtimeEventStreams));
  });

  it('retains common event sequencing and terminal semantics', () => {
    const terminalTypes = new Set(['RunCompleted', 'RunFailed', 'RunCancelled']);
    for (const stream of common.runtimeEventStreams) {
      const events = stream.events;
      assert.ok(events.length > 0);
      for (const event of events) assertRuntimeEventIdentity(event);
      assert.equal(events[0].type, 'RunAccepted');
      assert.equal(new Set(events.map(event => event.generation)).size, 1);
      assert.deepEqual(
        events.map(event => event.sequence),
        events.map(event => event.sequence).sort((left, right) => left - right),
      );
      const terminals = events.filter(event => terminalTypes.has(event.type));
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0], events.at(-1));
      if (terminals[0].type === 'RunCancelled') {
        assert.equal(Object.hasOwn(terminals[0].payload, 'outcomeId'), false);
      } else {
        assert.equal(typeof terminals[0].payload.outcomeId, 'string');
      }
    }
    assert.equal(common.semantics.cancelledCreatesReplyIntent, false);
    assert.equal(common.semantics.cancelledFinishesPresence, true);
    assert.equal(common.semantics.silentCreatesReplyIntent, false);
  });

  it('uses the common terminal, outcome, intent, receipt, settlement and silent vector names', () => {
    assert.deepEqual(Object.keys(contract.vectors).sort(), [
      'DeliveryReceipt',
      'DeliverySettlement',
      'ReplyIntent',
      'ReplyOutcome',
      'RunCancelled',
      'RunCompleted',
      'RunFailed',
      'cancelled',
      'silent',
    ]);
  });

  it('keeps complete request, turn, generation, sequence, trace and causation identity on run terminals', () => {
    const { RunCompleted: completed, RunFailed: failed, RunCancelled: cancelled } = contract.vectors;
    const silent = contract.vectors.silent.runEvent;
    for (const event of [completed, failed, cancelled, silent]) assertRuntimeEventIdentity(event);
    assert.equal(completed.payload.outcomeId, contract.vectors.ReplyOutcome.answer.outcomeId);
    assert.equal(failed.payload.outcomeId, contract.vectors.ReplyOutcome.failure.outcomeId);
    assert.equal(silent.payload.outcomeId, contract.vectors.ReplyOutcome.silent.outcomeId);
    assert.equal(Object.hasOwn(completed.payload, 'outcome'), false);
    assert.equal(Object.hasOwn(failed.payload, 'outcome'), false);
    assert.equal(Object.hasOwn(silent.payload, 'outcome'), false);
    assert.equal(cancelled.payload.mode, 'queued');
    assert.equal(contract.vectors.cancelled.replyOutcome, null);
    assert.equal(contract.vectors.cancelled.replyIntent, null);
  });

  it('keeps ReplyOutcome separate from execution terminal events', () => {
    const outcomes = contract.vectors.ReplyOutcome;
    for (const outcome of [outcomes.answer, outcomes.failure, outcomes.silent]) {
      assertReplyOutcome(outcome);
      assertNoUserReceivedClaim(outcome);
    }
    assert.equal(outcomes.answer.kind, 'answer');
    assert.equal(outcomes.failure.kind, 'failure');
    assert.equal(outcomes.silent.kind, 'silent');
    assert.equal(outcomes.answer.traceId, contract.vectors.RunCompleted.traceId);
    assert.equal(outcomes.failure.traceId, contract.vectors.RunFailed.traceId);
    assert.equal(outcomes.silent.traceId, contract.vectors.silent.outcome.traceId);
  });

  it('keeps HXA route targetRef opaque and derives intents only from run terminals', () => {
    const { answer, failure_notice: failureNotice } = contract.vectors.ReplyIntent;
    for (const intent of [answer, failureNotice]) {
      assertReplyIntent(intent);
      assertNoUserReceivedClaim(intent);
    }
    assert.equal(answer.traceId, contract.vectors.ReplyOutcome.answer.traceId);
    assert.equal(failureNotice.traceId, contract.vectors.ReplyOutcome.failure.traceId);
    assert.equal(answer.cause.eventId, contract.vectors.RunCompleted.eventId);
    assert.equal(failureNotice.cause.eventId, contract.vectors.RunFailed.eventId);
    assert.equal(answer.disposition, 'send');
    assert.equal(failureNotice.disposition, 'failure_notice');
    assert.equal(contract.vectors.silent.replyIntent, null);
    assert.equal(Object.hasOwn(contract.vectors.ReplyIntent, 'task_receipt'), false);
  });

  it('makes silence and cancellation explicit without fabricating an HXA send intent', () => {
    const { silent, cancelled } = contract.vectors;
    assertReplyOutcome(silent.outcome);
    assert.equal(silent.runEvent.payload.outcomeId, silent.outcome.outcomeId);
    assert.equal(silent.outcome.explicit, true);
    assert.equal(silent.replyIntent, null);
    assert.equal(silent.settlement, null);
    assert.equal(silent.deliveryRequired, false);
    assert.equal(cancelled.replyOutcome, null);
    assert.equal(cancelled.replyIntent, null);
    assert.equal(cancelled.presence, 'not_applicable_hxa_terminal_only');
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

  it('separates platform acceptance, reconciliation and final settlement from user-read claims', () => {
    const receipts = contract.vectors.DeliveryReceipt;
    assert.deepEqual(Object.keys(receipts).sort(), [
      'platformAccepted',
      'reconciled',
      'rejected',
      'unknown',
    ]);
    for (const receipt of Object.values(receipts)) assertDeliveryReceipt(receipt);
    assert.equal(receipts.unknown.nextAction, 'reconcile_before_retry');
    assert.equal(receipts.platformAccepted.outcome, 'platform_accepted');
    assert.equal(receipts.reconciled.outcome, 'reconciled');
    assert.equal(receipts.rejected.outcome, 'rejected');
    assert.equal(Object.hasOwn(receipts, 'dead_letter'), false);

    const settlements = contract.vectors.DeliverySettlement;
    assert.deepEqual(Object.keys(settlements).sort(), [
      'accepted',
      'reconciled',
      'unpresentable',
    ]);
    for (const settlement of Object.values(settlements)) assertDeliverySettlement(settlement);
    assert.equal(settlements.accepted.basis, 'platform_accepted');
    assert.equal(settlements.reconciled.basis, 'reconciled');
    assert.equal(settlements.unpresentable.basis, 'retry_exhausted');
    assert.equal(settlements.unpresentable.presented, false);
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
    assert.equal(scenarios.dead_letter_isolation.failedReceiptOutcome, 'rejected');
    assert.equal(scenarios.dead_letter_isolation.failedSettlementState, 'unpresentable');
    assert.equal(scenarios.dead_letter_isolation.deadLettered, true);
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

  it('keeps the HXA content hash vector stable', () => {
    assert.equal(
      contract.vectors.ReplyIntent.answer.contentHash,
      contentHash(contract.vectors.ReplyIntent.answer.payload.text),
    );
    assert.equal(
      contract.vectors.ReplyIntent.failure_notice.contentHash,
      contentHash(contract.vectors.ReplyIntent.failure_notice.payload.text),
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
