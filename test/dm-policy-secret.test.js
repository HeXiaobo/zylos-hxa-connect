import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCurrentNoticeSecret } from '../src/lib/dm-policy-rejection.js';

test('returns the secret when non-empty', () => {
  assert.equal(requireCurrentNoticeSecret('abc123'), 'abc123');
});

test('throws HXA_DM_POLICY_NOTICE_SECRET_REQUIRED when missing', () => {
  assert.throws(
    () => requireCurrentNoticeSecret(undefined),
    error => error.code === 'HXA_DM_POLICY_NOTICE_SECRET_REQUIRED',
  );
});

test('throws HXA_DM_POLICY_NOTICE_SECRET_REQUIRED when blank', () => {
  assert.throws(
    () => requireCurrentNoticeSecret('   '),
    error => error.code === 'HXA_DM_POLICY_NOTICE_SECRET_REQUIRED',
  );
});
