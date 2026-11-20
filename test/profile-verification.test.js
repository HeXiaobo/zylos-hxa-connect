import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyOrgScopedProfile } from '../src/lib/profile-verification.js';

test('verifies the exact runtime profile inside the requested org', () => {
  const report = verifyOrgScopedProfile({
    orgLabel: '3ai',
    expectedOrgId: '976cb4e2-1d2a-4f7b-b2ca-8115ad4e3410',
    expectedProfileId: '789ef6a8-3b8b-4a9e-97c6-34e672496233',
    expectedProfileName: 'xiaochen',
    expectedHostname: 'vultr.guest',
    actualHostname: 'vultr.guest',
    observedAt: '2026-08-28T16:39:42.000Z',
    profile: {
      id: '789ef6a8-3b8b-4a9e-97c6-34e672496233',
      name: 'xiaochen',
      org_id: '976cb4e2-1d2a-4f7b-b2ca-8115ad4e3410',
    },
  });

  assert.deepEqual(report, {
    schema: 'zylos.hxa-org-profile-verification/v1',
    status: 'PASS',
    org: '3ai',
    expected: {
      orgId: '976cb4e2-1d2a-4f7b-b2ca-8115ad4e3410',
      profileId: '789ef6a8-3b8b-4a9e-97c6-34e672496233',
      profileName: 'xiaochen',
      hostname: 'vultr.guest',
    },
    observed: {
      profileId: '789ef6a8-3b8b-4a9e-97c6-34e672496233',
      profileName: 'xiaochen',
      orgId: '976cb4e2-1d2a-4f7b-b2ca-8115ad4e3410',
      hostname: 'vultr.guest',
      observedAt: '2026-08-28T16:39:42.000Z',
    },
    failures: [],
  });
});

test('holds mismatched profile and hostname without comparing another org', () => {
  const report = verifyOrgScopedProfile({
    orgLabel: '3ai',
    expectedOrgId: 'org-3ai',
    expectedProfileId: 'profile-3ai',
    expectedProfileName: 'xiaochen',
    expectedHostname: 'vultr.guest',
    actualHostname: 'other-host',
    observedAt: '2026-08-28T16:40:00.000Z',
    profile: {
      id: 'profile-default',
      name: 'xiaochen',
      org_id: 'org-3ai',
    },
  });

  assert.equal(report.status, 'HOLD');
  assert.equal(report.org, '3ai');
  assert.deepEqual(report.failures, [
    'PROFILE_ID_MISMATCH',
    'HOSTNAME_MISMATCH',
  ]);
});

test('holds a profile returned for the wrong org or configured Agent name', () => {
  const report = verifyOrgScopedProfile({
    orgLabel: 'default',
    expectedOrgId: 'org-default',
    expectedProfileId: 'profile-default',
    expectedProfileName: 'xiaochen-default',
    expectedHostname: 'vultr',
    actualHostname: 'vultr',
    observedAt: '2026-08-28T16:41:00.000Z',
    profile: {
      id: 'profile-default',
      name: 'xiaochen-3ai',
      org_id: 'org-3ai',
    },
  });

  assert.equal(report.status, 'HOLD');
  assert.deepEqual(report.failures, [
    'ORG_ID_MISMATCH',
    'PROFILE_NAME_MISMATCH',
  ]);
});
