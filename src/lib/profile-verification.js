const REPORT_SCHEMA = 'zylos.hxa-org-profile-verification/v1';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function verifyOrgScopedProfile(input) {
  const request = requireRecord(input, 'profile verification input');
  const orgLabel = requireText(request.orgLabel, 'orgLabel');
  const expectedOrgId = requireText(request.expectedOrgId, 'expectedOrgId');
  const expectedProfileId = requireText(request.expectedProfileId, 'expectedProfileId');
  const expectedProfileName = requireText(request.expectedProfileName, 'expectedProfileName');
  const expectedHostname = requireText(request.expectedHostname, 'expectedHostname');
  const actualHostname = requireText(request.actualHostname, 'actualHostname');
  const observedAt = requireText(request.observedAt, 'observedAt');
  const profile = requireRecord(request.profile, 'profile');
  const profileId = requireText(profile.id, 'profile.id');
  const profileName = requireText(profile.name, 'profile.name');
  const orgId = requireText(profile.org_id, 'profile.org_id');

  const failures = [];
  if (orgId !== expectedOrgId) failures.push('ORG_ID_MISMATCH');
  if (profileId !== expectedProfileId) failures.push('PROFILE_ID_MISMATCH');
  if (profileName !== expectedProfileName) failures.push('PROFILE_NAME_MISMATCH');
  if (actualHostname !== expectedHostname) failures.push('HOSTNAME_MISMATCH');

  return Object.freeze({
    schema: REPORT_SCHEMA,
    status: failures.length === 0 ? 'PASS' : 'HOLD',
    org: orgLabel,
    expected: Object.freeze({
      orgId: expectedOrgId,
      profileId: expectedProfileId,
      profileName: expectedProfileName,
      hostname: expectedHostname,
    }),
    observed: Object.freeze({
      profileId,
      profileName,
      orgId,
      hostname: actualHostname,
      observedAt,
    }),
    failures: Object.freeze(failures),
  });
}
