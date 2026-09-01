import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url);

export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(name, FIXTURE_ROOT), 'utf8'));
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
  assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > 0);
}

export function contentHash(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
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
