import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url);
export const COMMON_CONTRACT_SHA256 =
  '581475d80e85cd156c4f6629d0e8e8ee82c2689e89de214c1bb24b404cd10195';
export const COMMON_CONTRACT_PATH = new URL(
  'assistant-reply-contract/v1/common-contract-vectors.json',
  FIXTURE_ROOT,
);

export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(name, FIXTURE_ROOT), 'utf8'));
}

export function loadCommonContractFixture() {
  return JSON.parse(fs.readFileSync(COMMON_CONTRACT_PATH, 'utf8'));
}

export function assertCommonContractDigest() {
  const bytes = fs.readFileSync(COMMON_CONTRACT_PATH);
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, COMMON_CONTRACT_SHA256);
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.contractId, 'zylos.assistant-reply-contract/v1');
  return digest;
}

export function assertRuntimeEventIdentity(event) {
  assert.equal(event.schemaVersion, 1);
  for (const field of [
    'type',
    'eventId',
    'requestId',
    'turnId',
    'traceId',
    'causationId',
    'producer',
    'idempotencyKey',
  ]) {
    assert.equal(typeof event[field], 'string', `${event.type}.${field} must be a string`);
    assert.notEqual(event[field].trim(), '', `${event.type}.${field} must not be empty`);
  }
  assert.ok(Number.isSafeInteger(event.generation) && event.generation > 0);
  assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > 0);
  assert.ok(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload));
}

export function assertReplyOutcome(outcome) {
  assert.equal(outcome.schemaVersion, 1);
  assert.equal(outcome.type, 'ReplyOutcome');
  for (const field of ['outcomeId', 'requestId', 'turnId', 'traceId', 'kind']) {
    assert.equal(typeof outcome[field], 'string', `ReplyOutcome.${field} must be a string`);
    assert.notEqual(outcome[field].trim(), '', `ReplyOutcome.${field} must not be empty`);
  }
  assert.ok(['answer', 'failure', 'silent'].includes(outcome.kind));
  if (outcome.kind === 'answer') {
    assert.equal(outcome.content?.format, 'text');
    assert.equal(typeof outcome.content.text, 'string');
    assert.notEqual(outcome.content.text.trim(), '');
  } else if (outcome.kind === 'failure') {
    assert.equal(typeof outcome.code, 'string');
    assert.notEqual(outcome.code.trim(), '');
    assert.equal(typeof outcome.retryable, 'boolean');
  } else {
    assert.equal(outcome.explicit, true);
  }
}

export function assertReplyIntent(intent, { adapterId = 'hxa-connect' } = {}) {
  assert.equal(intent.schemaVersion, 1);
  assert.equal(intent.type, 'ReplyIntent');
  for (const field of [
    'intentId',
    'requestId',
    'traceId',
    'disposition',
    'contentHash',
    'idempotencyKey',
  ]) {
    assert.equal(typeof intent[field], 'string', `ReplyIntent.${field} must be a string`);
    assert.notEqual(intent[field].trim(), '', `ReplyIntent.${field} must not be empty`);
  }
  assert.ok(intent.cause && typeof intent.cause === 'object');
  assert.ok(['run_terminal', 'task_effect'].includes(intent.cause.kind));
  assert.equal(typeof intent.cause.eventId, 'string');
  assert.deepEqual(Object.keys(intent.route).sort(), ['adapterId', 'targetRef']);
  assert.equal(intent.route.adapterId, adapterId);
  assert.equal(typeof intent.route.targetRef, 'string');
  assert.notEqual(intent.route.targetRef.trim(), '');
  assert.ok(['send', 'failure_notice', 'task_receipt'].includes(intent.disposition));
  assert.ok(intent.payload && typeof intent.payload === 'object');
  assert.equal(intent.idempotencyKey, intent.intentId);
  if (intent.payload.format === 'text') {
    assert.equal(typeof intent.payload.text, 'string');
    assert.notEqual(intent.payload.text.trim(), '');
    assert.equal(intent.contentHash, contentHash(intent.payload.text));
  }
}

export function assertDeliveryReceipt(receipt, { adapterId = 'hxa-connect' } = {}) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.type, 'DeliveryReceipt');
  for (const field of [
    'receiptId',
    'deliveryId',
    'intentId',
    'requestId',
    'attemptId',
    'traceId',
    'adapterId',
    'outcome',
    'observedAt',
  ]) {
    assert.equal(typeof receipt[field], 'string', `DeliveryReceipt.${field} must be a string`);
    assert.notEqual(receipt[field].trim(), '', `DeliveryReceipt.${field} must not be empty`);
  }
  assert.equal(receipt.adapterId, adapterId);
  assert.ok(['platform_accepted', 'unknown', 'reconciled', 'rejected'].includes(receipt.outcome));
  assert.ok(Object.hasOwn(receipt, 'externalRef'));
  if (receipt.outcome === 'unknown') {
    assert.equal(receipt.externalRef, null);
    assert.equal(receipt.nextAction, 'reconcile_before_retry');
  }
  if (receipt.outcome === 'platform_accepted' || receipt.outcome === 'reconciled') {
    assert.equal(typeof receipt.externalRef, 'string');
    assert.notEqual(receipt.externalRef.trim(), '');
  }
  if (receipt.outcome === 'rejected') {
    assert.equal(typeof receipt.errorCode, 'string');
    assert.equal(typeof receipt.retryable, 'boolean');
  }
  assertNoUserReceivedClaim(receipt);
}

export function assertDeliverySettlement(settlement, { adapterId = 'hxa-connect' } = {}) {
  assert.equal(settlement.schemaVersion, 1);
  assert.equal(settlement.type, 'DeliverySettlement');
  for (const field of [
    'settlementId',
    'intentId',
    'deliveryId',
    'requestId',
    'traceId',
    'adapterId',
    'state',
    'basis',
  ]) {
    assert.equal(typeof settlement[field], 'string', `DeliverySettlement.${field} must be a string`);
    assert.notEqual(settlement[field].trim(), '', `DeliverySettlement.${field} must not be empty`);
  }
  assert.equal(settlement.adapterId, adapterId);
  assert.ok(['accepted', 'unpresentable'].includes(settlement.state));
  assert.equal(typeof settlement.presented, 'boolean');
  if (settlement.state === 'unpresentable') {
    assert.equal(settlement.basis, 'retry_exhausted');
    assert.equal(settlement.presented, false);
  } else {
    assert.equal(settlement.presented, true);
  }
  assertNoUserReceivedClaim(settlement);
}

export function contentHash(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

export function canonicalPayloadHash(payload) {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

export function canonicalRouteHash(route) {
  return createHash('sha256').update(canonicalJson(route)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function assertNoUserReceivedClaim(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, 'userReceived');
    assert.notEqual(key, 'userRead');
    assert.notEqual(key, 'userReadClaimed');
    assertNoUserReceivedClaim(child);
  }
}
