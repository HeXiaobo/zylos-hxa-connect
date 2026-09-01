import { createHash } from 'node:crypto';

import {
  AssistantResponseDeliveryStore,
  normalizeHxaTransportReceipt,
  parseHxaResponseEndpoint,
  reconcileHxaResponse,
  sendHxaResponse,
} from './assistant-response-delivery.js';

const ADAPTER_ID = 'hxa-connect';
const TERMINAL_DISPOSITIONS = new Set(['send', 'failure_notice']);
const PROGRESS_EVENTS = new Set(['ProgressUpdated', 'OutputDelta']);
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 422]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(code, message, Type = Error) {
  const error = new Type(message);
  error.code = code;
  throw error;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_DELIVERY_INPUT', `${field} must be a non-empty string`, TypeError);
  }
  return value;
}

function unsupported(errorCode, capability) {
  return Object.freeze({
    handled: false,
    status: 'unsupported',
    errorCode,
    capability,
    receipt: null,
  });
}

function suppressed(reason) {
  return Object.freeze({
    handled: true,
    status: 'suppressed',
    deliveryRequired: false,
    reason,
    receipt: null,
  });
}

function contentHash(text) {
  return `sha256:${sha256(text)}`;
}

function endpointKey(parsed) {
  return parsed.kind === 'thread'
    ? `${parsed.orgLabel}\0thread\0${parsed.threadId}\0${parsed.replyToId || ''}`
    : `${parsed.orgLabel}\0dm\0${parsed.target}\0${parsed.sourceMessageId || ''}`;
}

function normalizeIntent(input, defaultOrgLabel) {
  if (PROGRESS_EVENTS.has(input?.type)) {
    return { result: unsupported('UNSUPPORTED_PROGRESS_CAPABILITY', input.type) };
  }
  if (input?.type === 'ReplyOutcome' && input?.kind === 'silent' && input?.explicit === true) {
    return { result: suppressed('explicit_silent') };
  }
  if (input?.disposition === 'suppress') {
    return { result: suppressed('explicit_suppress_compatibility') };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { result: unsupported('UNSUPPORTED_DELIVERY_INPUT', 'non_object') };
  }
  if (input.type !== 'ReplyIntent' || input.schemaVersion !== 1) {
    return { result: unsupported('UNSUPPORTED_DELIVERY_INPUT', input.type || 'unknown') };
  }
  if (input.route?.adapterId !== ADAPTER_ID) {
    return { result: unsupported('UNSUPPORTED_ROUTE_ADAPTER', input.route?.adapterId || 'missing') };
  }
  if (!TERMINAL_DISPOSITIONS.has(input.disposition)) {
    return { result: unsupported('UNSUPPORTED_DISPOSITION', input.disposition || 'missing') };
  }
  if (input.payload?.format !== 'text') {
    return { result: unsupported('UNSUPPORTED_PAYLOAD_FORMAT', input.payload?.format || 'missing') };
  }

  const text = typeof input.payload.text === 'string' ? input.payload.text : '';
  if (text.trim() === '') fail('MISSING_OUTPUT', 'visible HXA reply text must not be blank');
  const compatibilitySkip = /^\s*\[SKIP\]\s*$/i.test(text);

  const intentId = requireText(input.intentId, 'ReplyIntent.intentId');
  const requestId = requireText(input.requestId, 'ReplyIntent.requestId');
  const traceId = requireText(input.traceId, 'ReplyIntent.traceId');
  const idempotencyKey = requireText(input.idempotencyKey, 'ReplyIntent.idempotencyKey');
  const targetRef = requireText(input.route.targetRef, 'ReplyIntent.route.targetRef');
  if (idempotencyKey !== intentId) {
    fail('IDEMPOTENCY_CONFLICT', 'ReplyIntent idempotencyKey must equal intentId');
  }
  const actualHash = contentHash(text);
  if (input.contentHash !== actualHash) {
    fail('IDEMPOTENCY_CONFLICT', 'ReplyIntent contentHash does not match its text payload');
  }

  let parsed;
  try {
    parsed = parseHxaResponseEndpoint(targetRef, defaultOrgLabel);
  } catch (error) {
    return {
      result: unsupported('UNSUPPORTED_HXA_ROUTE', String(error?.message || error)),
    };
  }

  const deliveryId = `delivery:${intentId}`;
  const identityFacts = {
    deliveryId,
    intentId,
    requestId,
    traceId,
    idempotencyKey,
    disposition: input.disposition,
    contentHash: actualHash,
    endpointKey: endpointKey(parsed),
    targetRef,
  };
  return {
    intent: input,
    parsed,
    text,
    suppressedReason: compatibilitySkip ? 'legacy_skip_marker' : null,
    identity: {
      ...identityFacts,
      identityHash: sha256(JSON.stringify(identityFacts)),
    },
  };
}

function normalizeAttemptContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    fail('INVALID_ATTEMPT_CONTEXT', 'attemptContext must be an object', TypeError);
  }
  return Object.freeze({
    attemptId: requireText(context.attemptId, 'attemptContext.attemptId'),
    ownerId: requireText(context.ownerId, 'attemptContext.ownerId'),
    lockTimeoutMs: Number.isFinite(context.lockTimeoutMs) && context.lockTimeoutMs > 0
      ? context.lockTimeoutMs
      : 5_000,
  });
}

function observedAt(clock) {
  return new Date(clock()).toISOString();
}

function receiptId(deliveryId, attemptId, observation) {
  return `receipt:${sha256(`${deliveryId}\0${attemptId}\0${observation}`)}`;
}

function makeReceipt({
  record,
  attemptId,
  outcome,
  observation,
  clock,
  externalRef = null,
  errorCode,
  retryable,
  nextAction,
}) {
  const receipt = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: receiptId(record.deliveryId, attemptId, observation),
    intentId: record.intentId,
    deliveryId: record.deliveryId,
    requestId: record.requestId,
    attemptId,
    traceId: record.traceId,
    adapterId: ADAPTER_ID,
    outcome,
    externalRef,
    observedAt: observedAt(clock),
  };
  if (nextAction !== undefined) receipt.nextAction = nextAction;
  if (errorCode !== undefined) receipt.errorCode = errorCode;
  if (retryable !== undefined) receipt.retryable = retryable;
  return Object.freeze(receipt);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendReceipt(record, receipt) {
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  const existing = receipts.find(item => item.receiptId === receipt.receiptId);
  if (existing) {
    if (!sameValue(existing, receipt)) {
      fail('IDEMPOTENCY_CONFLICT', `DeliveryReceipt ${receipt.receiptId} changed payload`);
    }
    return receipts;
  }
  return [...receipts, receipt];
}

function latestReceipt(record, predicate = () => true) {
  const receipts = Array.isArray(record.receipts) ? record.receipts : [];
  return receipts.findLast(predicate) || null;
}

function acceptedExternalRef(result) {
  const normalized = normalizeHxaTransportReceipt(result);
  return normalized.hubMessageId ? `opaque:${normalized.hubMessageId}` : null;
}

function classifySendError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (PERMANENT_HTTP_STATUSES.has(status) || error?.retryable === false) {
    return { outcome: 'rejected', errorCode: 'HXA_PLATFORM_REJECTED', retryable: false };
  }
  if (RETRYABLE_HTTP_STATUSES.has(status) || error?.retryable === true) {
    return { outcome: 'rejected', errorCode: 'HXA_PLATFORM_REJECTED', retryable: true };
  }
  return {
    outcome: 'unknown',
    errorCode: 'HXA_TRANSPORT_RESULT_UNKNOWN',
    nextAction: 'reconcile_before_retry',
  };
}

function initialRecord() {
  return {
    recordKind: 'hxa_final_delivery',
    fence: 0,
    receipts: [],
    activeLease: null,
    currentAttemptId: null,
  };
}

async function ensureRecord(store, normalized) {
  try {
    return await store.begin(normalized.identity, initialRecord());
  } catch (error) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') throw error;
    if (/identity collision/i.test(String(error?.message || error))) {
      error.code = 'IDEMPOTENCY_CONFLICT';
    }
    throw error;
  }
}

async function claim(store, record, context, lockToken, kind) {
  const previousFence = record.fence ?? 0;
  const fence = previousFence + 1;
  return store.update(record, {
    status: kind === 'send' ? 'sending' : 'reconciling',
    attempts: kind === 'send' ? record.attempts + 1 : record.attempts,
    currentAttemptId: context.attemptId,
    fence,
    activeLease: {
      kind,
      ownerId: context.ownerId,
      attemptId: context.attemptId,
      token: lockToken,
      fence,
      acquiredAt: record.updatedAt,
    },
    lastError: null,
  }, { expectedFence: previousFence });
}

async function settle(store, record, receipt, status, leaseToken, lastError = null) {
  return store.update(record, {
    status,
    receipts: appendReceipt(record, receipt),
    activeLease: null,
    lastError,
    hubMessageId: receipt.externalRef?.replace(/^opaque:/, '') || record.hubMessageId,
  }, {
    expectedFence: record.fence,
    expectedLeaseToken: leaseToken,
  });
}

async function recoverInterruptedAttempt(store, record, clock) {
  const attemptId = record.currentAttemptId;
  if (!attemptId) fail('HXA_DELIVERY_STATE_INVALID', 'interrupted delivery is missing attemptId');
  const existing = latestReceipt(record, receipt => (
    receipt.attemptId === attemptId && receipt.outcome === 'unknown'
  ));
  if (existing) {
    const next = record.status === 'unknown' && record.activeLease === null
      ? record
      : await store.update(record, {
        status: 'unknown',
        activeLease: null,
      }, { expectedFence: record.fence ?? 0 });
    return { record: next, receipt: existing };
  }
  const receipt = makeReceipt({
    record,
    attemptId,
    outcome: 'unknown',
    observation: `recovered-interrupted:${record.fence ?? 0}`,
    clock,
    nextAction: 'reconcile_before_retry',
    errorCode: 'HXA_PROCESS_RESULT_UNKNOWN',
  });
  const next = await store.update(record, {
    status: 'unknown',
    receipts: appendReceipt(record, receipt),
    activeLease: null,
    lastError: 'interrupted owner left an ambiguous external result',
  }, { expectedFence: record.fence ?? 0 });
  return { record: next, receipt };
}

function buildHxaFinalDeliveryAdapter({
  store,
  resolveOrg,
  defaultOrgLabel = 'default',
  clock = () => Date.now(),
  logger = console,
} = {}) {
  // Phase B TODO: map the accepted WT02-C claim/receipt seam onto this
  // adapter-private attempt context. Do not promote ownerId or lockTimeoutMs
  // into the cross-repository v1 contract from this Phase A module.
  if (!(store instanceof AssistantResponseDeliveryStore)) {
    throw new TypeError('HXA final delivery requires AssistantResponseDeliveryStore');
  }
  if (typeof resolveOrg !== 'function') {
    throw new TypeError('HXA final delivery requires an org resolver');
  }

  async function deliver(input, attemptContext) {
    const normalized = normalizeIntent(input, defaultOrgLabel);
    if (normalized.result) return normalized.result;
    if (normalized.suppressedReason) {
      return store.withLock(normalized.identity.deliveryId, async () => {
        const record = await ensureRecord(store, normalized);
        if (record.status !== 'suppressed') {
          await store.update(record, {
            status: 'suppressed',
            lastError: null,
          }, { expectedFence: record.fence ?? 0 });
        }
        return suppressed(normalized.suppressedReason);
      });
    }
    const context = normalizeAttemptContext(attemptContext);

    return store.withLock(normalized.identity.deliveryId, async ({ lockToken }) => {
      let record = await ensureRecord(store, normalized);
      const terminal = latestReceipt(record, receipt => (
        receipt.outcome === 'platform_accepted'
        || receipt.outcome === 'reconciled'
        || (receipt.outcome === 'rejected' && receipt.retryable === false)
      ));
      if (terminal) return terminal;

      if (record.status === 'sending' || record.status === 'reconciling') {
        return (await recoverInterruptedAttempt(store, record, clock)).receipt;
      }
      if (record.status === 'unknown') {
        return latestReceipt(record, receipt => receipt.outcome === 'unknown');
      }
      if (record.status === 'retryable') {
        const replay = latestReceipt(record, receipt => receipt.attemptId === context.attemptId);
        if (replay) return replay;
      }

      record = await claim(store, record, context, lockToken, 'send');
      let org;
      try {
        org = await resolveOrg(normalized.parsed.orgLabel);
        if (!org?.client || typeof org.client !== 'object') {
          throw new TypeError('HXA response org must provide a client');
        }
      } catch (error) {
        const receipt = makeReceipt({
          record,
          attemptId: context.attemptId,
          outcome: 'rejected',
          observation: `route-rejected:${record.fence}`,
          clock,
          errorCode: 'HXA_ROUTE_MISMATCH',
          retryable: false,
        });
        await settle(store, record, receipt, 'rejected', lockToken, String(error?.message || error));
        return receipt;
      }

      try {
        const result = await sendHxaResponse({
          parsed: normalized.parsed,
          client: org.client,
          content: normalized.text,
        });
        const externalRef = acceptedExternalRef(result);
        if (!externalRef) {
          const receipt = makeReceipt({
            record,
            attemptId: context.attemptId,
            outcome: 'unknown',
            observation: `send-unknown:${record.fence}`,
            clock,
            nextAction: 'reconcile_before_retry',
            errorCode: 'HXA_RESULT_AMBIGUOUS',
          });
          await settle(store, record, receipt, 'unknown', lockToken, 'HXA result lacked a message identity');
          return receipt;
        }
        const receipt = makeReceipt({
          record,
          attemptId: context.attemptId,
          outcome: 'platform_accepted',
          observation: `send-accepted:${record.fence}`,
          clock,
          externalRef,
        });
        await settle(store, record, receipt, 'accepted', lockToken);
        return receipt;
      } catch (error) {
        const classification = classifySendError(error);
        const receipt = makeReceipt({
          record,
          attemptId: context.attemptId,
          observation: `send-error:${record.fence}`,
          clock,
          ...classification,
        });
        const status = classification.outcome === 'unknown'
          ? 'unknown'
          : (classification.retryable ? 'retryable' : 'rejected');
        await settle(store, record, receipt, status, lockToken, String(error?.message || error));
        if (classification.outcome === 'unknown') {
          logger.warn?.('[hxa-connect] Final delivery result is ambiguous; reconcile before retry', {
            intentId: record.intentId,
            attemptId: context.attemptId,
          });
        }
        return receipt;
      }
    }, { timeoutMs: context.lockTimeoutMs });
  }

  async function reconcile(input, attemptContext) {
    const normalized = normalizeIntent(input, defaultOrgLabel);
    if (normalized.result) return normalized.result;
    if (normalized.suppressedReason) return deliver(input, attemptContext);
    const context = normalizeAttemptContext(attemptContext);

    return store.withLock(normalized.identity.deliveryId, async ({ lockToken }) => {
      let record = await ensureRecord(store, normalized);
      const terminal = latestReceipt(record, receipt => (
        receipt.outcome === 'platform_accepted'
        || receipt.outcome === 'reconciled'
        || (receipt.outcome === 'rejected' && receipt.retryable === false)
      ));
      if (terminal) return terminal;

      if (record.status === 'sending' || record.status === 'reconciling') {
        record = (await recoverInterruptedAttempt(store, record, clock)).record;
      }
      if (record.status === 'retryable') {
        return latestReceipt(record, receipt => receipt.outcome === 'rejected' && receipt.retryable === true);
      }
      const unknown = latestReceipt(record, receipt => receipt.outcome === 'unknown');
      if (!unknown) {
        fail('HXA_RECONCILE_NOT_REQUIRED', 'delivery has no ambiguous attempt to reconcile');
      }

      const reconcileContext = {
        ...context,
        attemptId: unknown.attemptId,
      };
      record = await claim(store, record, reconcileContext, lockToken, 'reconcile');
      let org;
      try {
        org = await resolveOrg(normalized.parsed.orgLabel);
        if (!org?.client || typeof org.client !== 'object') {
          throw new TypeError('HXA response org must provide a client');
        }
      } catch (error) {
        const receipt = makeReceipt({
          record,
          attemptId: unknown.attemptId,
          outcome: 'rejected',
          observation: `reconcile-route-rejected:${record.fence}`,
          clock,
          errorCode: 'HXA_ROUTE_MISMATCH',
          retryable: false,
        });
        await settle(store, record, receipt, 'rejected', lockToken, String(error?.message || error));
        return receipt;
      }

      try {
        const existing = await reconcileHxaResponse({
          parsed: normalized.parsed,
          client: org.client,
          org,
          content: normalized.text,
          startedAt: record.startedAt,
        });
        if (existing) {
          const externalRef = acceptedExternalRef(existing);
          if (!externalRef) {
            fail('HXA_RECONCILE_RESULT_AMBIGUOUS', 'reconciled HXA message lacks an identity');
          }
          const receipt = makeReceipt({
            record,
            attemptId: unknown.attemptId,
            outcome: 'reconciled',
            observation: `reconciled:${record.fence}`,
            clock,
            externalRef,
          });
          await settle(store, record, receipt, 'reconciled', lockToken);
          return receipt;
        }
        const receipt = makeReceipt({
          record,
          attemptId: unknown.attemptId,
          outcome: 'rejected',
          observation: `reconcile-not-found:${record.fence}`,
          clock,
          errorCode: 'HXA_RECONCILE_NOT_FOUND',
          retryable: true,
        });
        await settle(store, record, receipt, 'retryable', lockToken, 'ambiguous message not found during reconciliation');
        return receipt;
      } catch (error) {
        const receipt = makeReceipt({
          record,
          attemptId: unknown.attemptId,
          outcome: 'unknown',
          observation: `reconcile-unknown:${record.fence}`,
          clock,
          errorCode: 'HXA_RECONCILE_RESULT_UNKNOWN',
          nextAction: 'reconcile_before_retry',
        });
        await settle(store, record, receipt, 'unknown', lockToken, String(error?.message || error));
        return receipt;
      }
    }, { timeoutMs: context.lockTimeoutMs });
  }

  return Object.freeze({ deliver, reconcile });
}

export class HxaFinalDeliveryAdapter {
  #implementation;

  constructor(options = {}) {
    this.#implementation = buildHxaFinalDeliveryAdapter(options);
  }

  deliver(intent, attemptContext) {
    return this.#implementation.deliver(intent, attemptContext);
  }

  reconcile(intent, attemptContext) {
    return this.#implementation.reconcile(intent, attemptContext);
  }
}

export function createHxaFinalDeliveryAdapter(options = {}) {
  return new HxaFinalDeliveryAdapter(options);
}
