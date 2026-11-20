import { HxaFinalDeliveryAdapter } from './hxa-final-delivery-adapter.js';

const ACTIONS = new Set(['send', 'reconcile']);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function canonicalClaim(input) {
  const claim = requireRecord(input, 'HXA delivery claim');
  const intent = claim.type === 'ReplyIntent' || claim.type === 'ReplyOutcome'
    ? claim
    : requireRecord(claim.intent, 'HXA delivery claim.intent');
  if (intent.type === 'ReplyOutcome' && intent.kind === 'silent' && intent.explicit === true) {
    return { claim, intent, action: 'send', attemptContext: undefined };
  }
  if (intent.type !== 'ReplyIntent' || intent.schemaVersion !== 1) {
    throw new TypeError('HXA delivery claim must contain a v1 ReplyIntent');
  }
  const action = claim.action || 'send';
  if (!ACTIONS.has(action)) throw new TypeError(`unsupported HXA delivery action: ${action}`);
  const deliveryId = requireText(claim.deliveryId, 'HXA delivery claim.deliveryId');
  const attemptContext = {
    action,
    deliveryId,
    attemptId: requireText(claim.attemptId, 'HXA delivery claim.attemptId'),
    claimEpoch: claim.claimEpoch,
    leaseOwner: requireText(claim.leaseOwner, 'HXA delivery claim.leaseOwner'),
    leaseToken: requireText(claim.leaseToken, 'HXA delivery claim.leaseToken'),
    leaseExpiresAt: claim.leaseExpiresAt,
  };
  return { claim, intent, action, attemptContext };
}

/**
 * Composition root for the HXA terminal adapter. Core owns claims and
 * DeliverySettlement; this seam only invokes the accepted adapter and returns
 * its DeliveryReceipt. The legacy event-batch entry remains available behind
 * the explicit `mode: 'legacy'` option for rollback.
 */
export function createHxaFinalDeliveryComposition({
  adapter,
  legacyDelivery,
  mode = 'canonical',
} = {}) {
  if (!(adapter instanceof HxaFinalDeliveryAdapter)) {
    throw new TypeError('HXA composition requires HxaFinalDeliveryAdapter');
  }
  if (!legacyDelivery || typeof legacyDelivery.deliver !== 'function') {
    throw new TypeError('HXA composition requires a legacy delivery fallback');
  }
  if (!['canonical', 'legacy'].includes(mode)) {
    throw new TypeError('HXA composition mode must be canonical or legacy');
  }

  return Object.freeze({
    async deliver(input) {
      if (mode === 'legacy') return legacyDelivery.deliver(input);
      const claim = canonicalClaim(input);
      if (claim.intent.type === 'ReplyOutcome') return adapter.deliver(claim.intent);
      return claim.action === 'reconcile'
        ? adapter.reconcile(claim.intent, claim.attemptContext)
        : adapter.deliver(claim.intent, claim.attemptContext);
    },
  });
}

export function isCanonicalHxaDelivery(input) {
  return Boolean(input && typeof input === 'object' && (
    input.type === 'ReplyIntent'
    || input.type === 'ReplyOutcome'
    || input.intent?.type === 'ReplyIntent'
    || input.intent?.type === 'ReplyOutcome'
  ));
}
