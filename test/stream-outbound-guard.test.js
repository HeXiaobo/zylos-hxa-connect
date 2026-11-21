/**
 * Regression: `scripts/stream.js` must obey the outbound org guard.
 *
 * The terminal auto-delivery entry is a real outbound send. `scripts/send.js`
 * refuses to build a client for an org outside `internal_labels` unless
 * `HXA_CONFIRM_ORG` names it on this invocation (a value from ~/zylos/.env never
 * counts). The stream entry used to skip that check entirely and delivered to
 * any configured org.
 *
 * Each case below runs the real `scripts/stream.js` as a child process against a
 * throwaway HOME whose `hub_url` is a local HTTP server that records requests.
 * Nothing is sent anywhere real; no credential is printed or asserted on — the
 * fixture token is the literal string "test-token-not-a-real-secret".
 *
 * Both delivery modes are exercised end to end:
 *   - legacy   : the event batch goes straight through `reconcile`/`send`;
 *   - canonical: a Core claim fence is passed through the composition root, so
 *                the run reaches `sendHxaResponse()` and is blocked there.
 * For a blocked external org the assertions are: non-zero exit, no successful
 * delivery receipt on stdout, and zero send requests on the wire.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const STREAM_SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'stream.js');
const FIXTURE_TOKEN = 'test-token-not-a-real-secret';
const INTERNAL_ORG_ID = '11111111-1111-4111-8111-111111111111';
const EXTERNAL_ORG_ID = 'b13e6733-50bd-4cb2-a022-d27c935e7d47';
const INTERNAL_AGENT_ID = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa';
const EXTERNAL_AGENT_ID = 'bbbb2222-2222-4222-8222-bbbbbbbbbbbb';

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
        res.end(JSON.stringify({
          ok: true,
          channel_id: 'dm-channel-1',
          message: {
            id: 'hub-message-1',
            channel_id: 'dm-channel-1',
            sender_id: 'self-agent',
            sender_name: 'self-agent',
            content: 'fixture',
            created_at: Date.now(),
          },
        }));
      });
    });
    fakeHub.listen(0, '127.0.0.1', () => {
      fakeHubUrl = `http://127.0.0.1:${fakeHub.address().port}`;
      resolve();
    });
  });
}

function stopFakeHub() {
  return new Promise(resolve => fakeHub.close(resolve));
}

function makeHome({ guard = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-stream-guard-'));
  const componentDir = path.join(home, 'zylos', 'components', 'hxa-connect');
  fs.mkdirSync(componentDir, { recursive: true });

  const config = {
    enabled: true,
    default_hub_url: fakeHubUrl,
    orgs: {
      internal: {
        enabled: true,
        org_id: INTERNAL_ORG_ID,
        agent_id: INTERNAL_AGENT_ID,
        agent_token: FIXTURE_TOKEN,
        agent_name: 'tester',
        hub_url: fakeHubUrl,
        access: { dmPolicy: 'open', groupPolicy: 'open' },
      },
      'customer-org': {
        enabled: true,
        org_id: EXTERNAL_ORG_ID,
        agent_id: EXTERNAL_AGENT_ID,
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

function runStream(home, payload, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [STREAM_SCRIPT],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          HTTPS_PROXY: '',
          HTTP_PROXY: '',
          ...env,
        },
        timeout: 20_000,
      },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function legacyPayload(label) {
  return {
    schemaVersion: 1,
    requestId: `hxa.dm.${label}.stream-guard`,
    route: { channel: 'hxa-connect', endpointId: `org:${label}|peer-agent|msg:source-message-1` },
    events: [{
      requestId: `hxa.dm.${label}.stream-guard`,
      type: 'RunCompleted',
      sequence: 5,
      payload: { output: 'terminal answer from the stream entry' },
    }],
  };
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

/** A Core-style claim around a frozen-v1 ReplyIntent for this org. */
function canonicalPayload(label, attemptNumber = 1) {
  const route = { adapterId: 'hxa-connect', targetRef: `org:${label}|peer-agent|msg:source-message-1` };
  const payload = { format: 'text', text: 'canonical terminal answer from the stream entry' };
  const requestId = `request-${label}-${attemptNumber}`;
  const intentId = `reply:${requestId}:${createHash('sha256').update(canonicalJson(route)).digest('hex')}`;
  const intent = {
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId,
    requestId,
    traceId: `trace-${label}-${attemptNumber}`,
    cause: { kind: 'run_terminal', eventId: `event-${label}-${attemptNumber}` },
    route,
    disposition: 'send',
    payload,
    contentHash: `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`,
    idempotencyKey: intentId,
  };
  return {
    // The Core claim wraps the intent; it must not carry the intent's `type`
    // at the top level or the composition root treats the wrapper as the intent.
    action: 'send',
    deliveryId: `delivery:${intentId}`,
    attemptId: `attempt:${intentId}:${attemptNumber}`,
    claimEpoch: attemptNumber,
    leaseOwner: 'stream-guard-test',
    leaseToken: `lease:${attemptNumber}`,
    leaseExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    intent,
  };
}

function sentCount() {
  return sentRequests.filter(request => request.url === '/api/send').length;
}

function assertNotDelivered(result) {
  assert.notEqual(result.code, 0, `a blocked delivery must fail: ${result.stdout}${result.stderr}`);
  const stdout = result.stdout.trim();
  if (stdout) {
    for (const line of stdout.split('\n')) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      assert.notEqual(parsed.ok, true, 'a blocked delivery must not print a success receipt');
    }
  }
}

const GUARD = { internal_labels: ['internal'] };

describe('outbound org guard — scripts/stream.js', () => {
  before(startFakeHub);
  after(stopFakeHub);

  it('legacy mode blocks an external org before any send', async () => {
    const home = makeHome({ guard: GUARD });
    sentRequests = [];
    try {
      const result = await runStream(home, legacyPayload('customer-org'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'legacy' },
      });

      assertNotDelivered(result);
      assert.equal(sentCount(), 0, 'nothing may reach the hub');
      assert.match(result.stderr, /BLOCKED/);
      assert.match(result.stderr, /customer-org/);
    } finally {
      cleanup(home);
    }
  });

  it('canonical mode blocks an external org at sendHxaResponse', async () => {
    const home = makeHome({ guard: GUARD });
    sentRequests = [];
    try {
      const result = await runStream(home, canonicalPayload('customer-org'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'canonical' },
      });

      assertNotDelivered(result);
      assert.equal(sentCount(), 0, 'nothing may reach the hub');
      assert.match(result.stderr, /BLOCKED/);
      assert.match(result.stderr, /customer-org/);
    } finally {
      cleanup(home);
    }
  });

  it('legacy mode still delivers for an internal org', async () => {
    const home = makeHome({ guard: GUARD });
    sentRequests = [];
    try {
      const result = await runStream(home, legacyPayload('internal'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'legacy' },
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(sentCount(), 1);
      assert.equal(JSON.parse(result.stdout.trim().split('\n').pop()).ok, true);
    } finally {
      cleanup(home);
    }
  });

  it('canonical mode still delivers for an internal org', async () => {
    const home = makeHome({ guard: GUARD });
    sentRequests = [];
    try {
      const result = await runStream(home, canonicalPayload('internal'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'canonical' },
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(sentCount(), 1);
      assert.equal(JSON.parse(result.stdout.trim().split('\n').pop()).ok, true);
    } finally {
      cleanup(home);
    }
  });

  it('ignores HXA_CONFIRM_ORG when it comes from ~/zylos/.env, not the command', async () => {
    const home = makeHome({ guard: GUARD });
    fs.writeFileSync(path.join(home, 'zylos', '.env'), 'HXA_CONFIRM_ORG=customer-org\n');
    sentRequests = [];
    try {
      const result = await runStream(home, legacyPayload('customer-org'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'legacy' },
      });

      assertNotDelivered(result);
      assert.equal(sentCount(), 0);
      assert.match(result.stderr, /zylos\/\.env/);
    } finally {
      cleanup(home);
    }
  });

  it('allows the external org when HXA_CONFIRM_ORG names it on the command', async () => {
    const home = makeHome({ guard: GUARD });
    sentRequests = [];
    try {
      const result = await runStream(home, legacyPayload('customer-org'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'legacy', HXA_CONFIRM_ORG: 'customer-org' },
      });

      assert.equal(result.code, 0, result.stderr);
      assert.equal(sentCount(), 1);
      assert.match(result.stderr, /CONFIRMED EXTERNAL/);
    } finally {
      cleanup(home);
    }
  });

  it('fails closed on a malformed guard', async () => {
    const home = makeHome({ guard: null });
    fs.writeFileSync(path.join(home, 'zylos', 'components', 'hxa-connect', 'outbound-guard.json'), '{not json');
    sentRequests = [];
    try {
      const result = await runStream(home, legacyPayload('internal'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'legacy' },
      });

      assert.notEqual(result.code, 0);
      assert.equal(sentCount(), 0);
      assert.match(result.stderr, /outbound-guard\.json/);
    } finally {
      cleanup(home);
    }
  });
});
