/**
 * Tests for the outbound org guard in scripts/send.js.
 *
 * These are process-level tests: each case writes a throwaway HOME with a
 * config.json and (optionally) outbound-guard.json, then runs the real
 * scripts/send.js as a child process and asserts on exit code and output.
 *
 * Two rules hold for every case here:
 *
 *   1. Nothing is sent. `hub_url` points at a local HTTP server that records
 *      requests and answers 200. It never talks to a real hub.
 *   2. No credential is read, printed or asserted on. The fixture tokens are
 *      the literal string "test-token-not-a-real-secret"; the assertions only
 *      look at the target, the org label and the guard wording.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SEND_SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'send.js');
const FIXTURE_TOKEN = 'test-token-not-a-real-secret';

const INTERNAL_ORG_ID = '11111111-1111-4111-8111-111111111111';
const EXTERNAL_ORG_ID = 'b13e6733-50bd-4cb2-a022-d27c935e7d47';

// ─── Local stand-in hub ─────────────────────────────────────────

/** Requests the fake hub received, so we can assert "nothing was sent". */
let sentRequests = [];
let fakeHub;
let fakeHubUrl;

function startFakeHub() {
  return new Promise((resolve) => {
    fakeHub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        sentRequests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: 'msg-fixture' }));
      });
    });
    fakeHub.listen(0, '127.0.0.1', () => {
      const { port } = fakeHub.address();
      fakeHubUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopFakeHub() {
  return new Promise((resolve) => fakeHub.close(resolve));
}

// ─── Fixture workspace ──────────────────────────────────────────

/**
 * Build a throwaway HOME containing the component config the guard reads.
 * `guard` is either `null` (no outbound-guard.json at all) or an object that
 * gets written as-is.
 */
function makeHome({ guard = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-guard-'));
  const componentDir = path.join(home, 'zylos', 'components', 'hxa-connect');
  fs.mkdirSync(componentDir, { recursive: true });

  const config = {
    enabled: true,
    default_hub_url: fakeHubUrl,
    orgs: {
      internal: {
        enabled: true,
        org_id: INTERNAL_ORG_ID,
        agent_id: 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa',
        agent_token: FIXTURE_TOKEN,
        agent_name: 'tester',
        hub_url: fakeHubUrl,
        access: { dmPolicy: 'open', groupPolicy: 'open' },
      },
      'customer-org': {
        enabled: true,
        org_id: EXTERNAL_ORG_ID,
        agent_id: 'bbbb2222-2222-4222-8222-bbbbbbbbbbbb',
        agent_token: FIXTURE_TOKEN,
        agent_name: 'tester-client',
        hub_url: fakeHubUrl,
        access: { dmPolicy: 'open', groupPolicy: 'open' },
      },
    },
  };

  fs.writeFileSync(path.join(componentDir, 'config.json'), JSON.stringify(config, null, 2));

  if (guard !== null) {
    fs.writeFileSync(path.join(componentDir, 'outbound-guard.json'), JSON.stringify(guard, null, 2));
  }

  return home;
}

/** Run send.js with a fixture HOME and capture exit code + output. */
function runSend(home, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SEND_SCRIPT, ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          // Drop any inherited proxy/confirm state so cases are independent.
          HTTPS_PROXY: '',
          HTTP_PROXY: '',
          ...env,
        },
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

// ─── Tests ──────────────────────────────────────────────────────

describe('outbound org guard — scripts/send.js', () => {
  before(startFakeHub);
  after(stopFakeHub);

  it('lets an internal org through (guard present, label listed)', async () => {
    const home = makeHome({ guard: { internal_labels: ['internal'] } });
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:internal|some-bot', 'hello internal']);

      assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
      assert.equal(sentRequests.length, 1, 'the send should reach the hub');
      assert.equal(sentRequests[0].url, '/api/send');

      // An internal org is not announced — no guard line at all.
      assert.ok(!res.stderr.includes('BLOCKED'), `unexpected block line: ${res.stderr}`);
      assert.ok(!res.stdout.includes('BLOCKED'), `unexpected block line: ${res.stdout}`);
      assert.ok(!res.stdout.includes('CONFIRMED EXTERNAL'), 'internal sends must stay quiet');
    } finally {
      cleanup(home);
    }
  });

  it('blocks an external org (non-zero exit, names target and label, sends nothing)', async () => {
    const home = makeHome({ guard: { internal_labels: ['internal'] } });
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:customer-org|some-bot', 'hello customer']);

      assert.notEqual(res.code, 0, 'a blocked send must exit non-zero');
      assert.equal(sentRequests.length, 0, 'a blocked send must not reach the hub');

      const blockLine = res.stderr;
      assert.match(blockLine, /BLOCKED/);
      assert.ok(blockLine.includes('customer-org'), 'the org label must be named');
      assert.ok(blockLine.includes('some-bot'), 'the target must be named');
      assert.ok(blockLine.includes('internal'), 'the allowed labels must be shown');
      // The message body is not echoed into the error path.
      assert.ok(!blockLine.includes('hello customer'), 'the body must not be echoed');
    } finally {
      cleanup(home);
    }
  });

  it('allows the external org when HXA_CONFIRM_ORG names it, and says so', async () => {
    const home = makeHome({ guard: { internal_labels: ['internal'] } });
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:customer-org|some-bot', 'hello customer'], {
        env: { HXA_CONFIRM_ORG: 'customer-org' },
      });

      assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
      assert.equal(sentRequests.length, 1, 'a confirmed send should reach the hub');
      assert.match(res.stdout, /CONFIRMED EXTERNAL/);
      assert.ok(res.stdout.includes('customer-org'), 'the confirmation line must name the org');
      assert.ok(!res.stderr.includes('BLOCKED'), 'a confirmed send is not blocked');
    } finally {
      cleanup(home);
    }
  });

  it('blocks by default when outbound-guard.json is absent (customer and non-with3 orgs denied)', async () => {
    const home = makeHome({ guard: null });
    sentRequests = [];
    try {
      const extRes = await runSend(home, ['org:customer-org|some-bot', 'hello customer']);
      assert.notEqual(extRes.code, 0, 'customer org must be blocked by default without outbound-guard.json');
      assert.equal(sentRequests.length, 0, 'nothing may reach the hub');
      assert.match(extRes.stderr, /BLOCKED/);
      assert.match(extRes.stderr, /outbound-guard\.json not found/);
      assert.ok(!extRes.stderr.includes('hello customer'), 'body must not be echoed');

      const otherRes = await runSend(home, ['org:internal|some-bot', 'hello unlisted']);
      assert.notEqual(otherRes.code, 0, 'unlisted org must also be blocked when no allowlist exists');
      assert.equal(sentRequests.length, 0, 'nothing may reach the hub');
      assert.match(otherRes.stderr, /BLOCKED/);

      // Explicit one-shot command confirmation still works when needed.
      const confirmedRes = await runSend(home, ['org:customer-org|some-bot', 'approved send'], {
        env: { HXA_CONFIRM_ORG: 'customer-org' },
      });
      assert.equal(confirmedRes.code, 0, `expected exit 0, got ${confirmedRes.code}: ${confirmedRes.stderr}`);
      assert.equal(sentRequests.length, 1);
      assert.match(confirmedRes.stdout, /CONFIRMED EXTERNAL/);
    } finally {
      cleanup(home);
    }
  });

  it('allows an org whitelisted by internal_org_ids while blocking customer and non-with3 orgs', async () => {
    const home = makeHome({ guard: { internal_org_ids: [INTERNAL_ORG_ID] } });
    sentRequests = [];
    try {
      const allowedRes = await runSend(home, ['org:internal|some-bot', 'hello with3']);
      assert.equal(allowedRes.code, 0, `expected exit 0, got ${allowedRes.code}: ${allowedRes.stderr}`);
      assert.equal(sentRequests.length, 1);
      assert.ok(!allowedRes.stderr.includes('BLOCKED'));

      const blockedRes = await runSend(home, ['org:customer-org|some-bot', 'hello customer']);
      assert.notEqual(blockedRes.code, 0, 'customer org not in internal_org_ids must be blocked');
      assert.equal(sentRequests.length, 1, 'blocked send must not reach the hub');
      assert.match(blockedRes.stderr, /BLOCKED/);
      assert.ok(blockedRes.stderr.includes(EXTERNAL_ORG_ID), 'blocked output should show org id');
    } finally {
      cleanup(home);
    }
  });

  it('ignores HXA_CONFIRM_ORG set to a different label', async () => {
    const home = makeHome({ guard: { internal_labels: ['internal'] } });
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:customer-org|some-bot', 'hello customer'], {
        env: { HXA_CONFIRM_ORG: 'internal' },
      });

      assert.notEqual(res.code, 0, 'a mismatched confirmation must not unlock the send');
      assert.equal(sentRequests.length, 0);
      assert.match(res.stderr, /BLOCKED/);
    } finally {
      cleanup(home);
    }
  });

  it('fails closed when outbound-guard.json is malformed', async () => {
    const home = makeHome({ guard: null });
    const componentDir = path.join(home, 'zylos', 'components', 'hxa-connect');
    fs.writeFileSync(path.join(componentDir, 'outbound-guard.json'), '{ not json');
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:internal|some-bot', 'hello internal']);

      assert.notEqual(res.code, 0, 'a broken guard must not silently allow sends');
      assert.equal(sentRequests.length, 0);
      assert.match(res.stderr, /outbound-guard\.json/);
    } finally {
      cleanup(home);
    }
  });

  it('ignores HXA_CONFIRM_ORG when it comes from ~/zylos/.env, not the command', async () => {
    // A confirmation left in the env file would approve every later send from
    // this host. The guard must not read that as a decision.
    const home = makeHome({ guard: { internal_labels: ['internal'] } });
    fs.writeFileSync(path.join(home, 'zylos', '.env'), 'HXA_CONFIRM_ORG=customer-org\n');
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:customer-org|some-bot', 'hello customer']);

      assert.notEqual(res.code, 0, 'an env-file confirmation must not unlock the send');
      assert.equal(sentRequests.length, 0, 'nothing may reach the hub');
      assert.match(res.stderr, /BLOCKED/);
      assert.match(res.stderr, /zylos\/\.env/, 'the operator should be told why their value did not apply');
    } finally {
      cleanup(home);
    }
  });

  it('still honours HXA_CONFIRM_ORG passed on the command when .env also has one', async () => {
    const home = makeHome({ guard: { internal_labels: ['internal'] } });
    fs.writeFileSync(path.join(home, 'zylos', '.env'), 'HXA_CONFIRM_ORG=customer-org\n');
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:customer-org|some-bot', 'hello customer'], {
        env: { HXA_CONFIRM_ORG: 'customer-org' },
      });

      assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
      assert.equal(sentRequests.length, 1);
      assert.match(res.stdout, /CONFIRMED EXTERNAL/);
    } finally {
      cleanup(home);
    }
  });

  it('tracks an env-file key the way Node stores it (NUL ends the name)', async () => {
    // Node truncates a name at NUL when assigning process.env. If the loader
    // records the raw slice, "HXA_CONFIRM_ORG\0suffix=x" sets the real
    // variable while the provenance Set holds another string, and the value
    // reads as if the caller passed it.
    const home = makeHome({ guard: { internal_labels: ['internal'] } });
    fs.writeFileSync(
      path.join(home, 'zylos', '.env'),
      'HXA_CONFIRM_ORG\u0000suffix=customer-org\n',
    );
    sentRequests = [];
    try {
      const res = await runSend(home, ['org:customer-org|some-bot', 'hello customer']);

      assert.notEqual(res.code, 0, 'a NUL-suffixed env key must not unlock the send');
      assert.equal(sentRequests.length, 0, 'nothing may reach the hub');
      assert.match(res.stderr, /BLOCKED/);
      assert.match(res.stderr, /zylos\/\.env/);
    } finally {
      cleanup(home);
    }
  });
});
