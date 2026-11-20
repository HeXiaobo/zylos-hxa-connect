/**
 * Tests for src/lib/redact.js.
 *
 * The component writes error text into PM2 logs. Those logs are read by
 * people and kept around, so a credential that appears inside a network
 * error must never reach them verbatim. These are unit tests on the pure
 * redaction function; no network, no config, no credentials.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/lib/redact.js';

const TOKEN = 'bot_2a00b360dc6e016eb1aa5aa929f6b383b21849ee3d2e849b';
const TICKET = 'tkt_9f8e7d6c5b4a39281706f5e4d3c2b1a0';

describe('redactSecrets', () => {
  it('redacts an agent_token inside a JSON body', () => {
    const out = redactSecrets(`request failed: {"agent_token":"${TOKEN}"}`);
    assert.ok(!out.includes(TOKEN), out);
    assert.ok(out.includes('[REDACTED]'), out);
  });

  it('redacts an Authorization header', () => {
    const out = redactSecrets(`headers: Authorization: Bearer ${TOKEN}`);
    assert.ok(!out.includes(TOKEN), out);
    assert.ok(out.includes('[REDACTED]'), out);
  });

  it('redacts a bare bearer token', () => {
    const out = redactSecrets(`sent with bearer ${TOKEN} rejected`);
    assert.ok(!out.includes(TOKEN), out);
  });

  it('redacts a ticket in a query string', () => {
    const out = redactSecrets(`GET /api/auth/register?ticket=${TICKET}&x=1 failed`);
    assert.ok(!out.includes(TICKET), out);
  });

  it('redacts a ticket field', () => {
    const out = redactSecrets(`body {"ticket":"${TICKET}"}`);
    assert.ok(!out.includes(TICKET), out);
  });

  it('redacts any agent_ prefixed secret', () => {
    const out = redactSecrets(`orphan value ${TOKEN} in text`);
    assert.ok(!out.includes(TOKEN), out);
  });

  it('leaves ordinary text untouched', () => {
    const msg = 'Error sending to dabao: connect ECONNREFUSED 127.0.0.1:18899';
    assert.equal(redactSecrets(msg), msg);
  });

  it('does not throw on null or undefined', () => {
    assert.equal(redactSecrets(null), '');
    assert.equal(redactSecrets(undefined), '');
  });

  it('keeps non-secret words that start like a token', () => {
    const msg = 'agent_id is required for org "org-1"';
    assert.equal(redactSecrets(msg), msg);
  });
});

describe('execFile-style failure text (catch-up replay path)', () => {
  it('redacts a bot_ token embedded in a long --content argument', () => {
    const tok = 'bot_' + 'a1b2c3d4'.repeat(6);
    const msg = 'catchup delivery failed (Command failed: node c4-receive.js --channel hxa --content ' + 'x'.repeat(200) + ' ' + tok + ' tail) — will retry next run';
    const out = redactSecrets(msg);
    assert.ok(!out.includes(tok));
  });
});
