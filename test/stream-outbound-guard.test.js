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
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const STREAM_SCRIPT = path.join(REPO_ROOT, 'scripts', 'stream.js');
const LEGACY_COMMIT = '9835fc721c1ccf52bb530a8021228a8857cbfd3a';
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

function runStream(home, payload, { env = {}, script = STREAM_SCRIPT } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [script],
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

function claimFor(label) {
  return canonicalPayload(label);
}

/**
 * The reconcile claim for a delivery that was ALREADY attempted.
 *
 * It must point at the same delivery: same intent, same attemptId. Only the
 * Core claim fields move (a newer epoch, its token, action=reconcile).
 * Rebuilding the payload with another attempt number would mint a different
 * intentId/deliveryId/attemptId and quietly reconcile some other delivery,
 * which is exactly the coverage gap this helper must not have.
 */
function reconcileClaimFor(label, claimEpoch = 2) {
  const send = canonicalPayload(label);
  return {
    ...send,
    action: 'reconcile',
    claimEpoch,
    leaseToken: `lease:${claimEpoch}`,
    leaseExpiresAt: Math.floor(Date.now() / 1_000) + 3_600,
  };
}

function stdoutCodes(result) {
  return result.stdout.split('\n').filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * One blocked step. The strict reading — `ok:false` carrying
 * HXA_OUTBOUND_GUARD_BLOCKED on stdout — is what the fix must produce. An older
 * head only met the weaker part (non-zero exit, no `ok:true`), so a step that
 * fails the strict check is reported as such instead of hiding the exact
 * regression these tests exist for.
 */
function assertBlockedStep(result, step) {
  const codes = stdoutCodes(result);
  const summary = `${step}: exit=${result.code} stdout=${result.stdout.trim() || '(empty)'}`;
  assert.equal(codes.some(entry => entry.ok === true), false, `must not print ok:true — ${summary}`);
  assert.notEqual(result.code, 0, `a blocked delivery must exit non-zero — ${summary}`);
  const failure = codes.find(entry => entry.ok === false);
  assert.ok(failure, `stdout must carry an ok:false receipt — ${summary}`);
  assert.equal(failure.errorCode, 'HXA_OUTBOUND_GUARD_BLOCKED', `guard code must survive — ${summary}`);
  assert.equal(failure.status, 'not_delivered', `status must say not delivered — ${summary}`);
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

  it('fails closed when outbound-guard.json is absent (default-deny for legacy and canonical)', async () => {
    const home = makeHome({ guard: null });
    sentRequests = [];
    try {
      const legacyRes = await runStream(home, legacyPayload('customer-org'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'legacy' },
      });
      assertBlockedStep(legacyRes, 'legacy default-deny');

      const canonicalRes = await runStream(home, canonicalPayload('customer-org'), {
        env: { HXA_FINAL_DELIVERY_MODE: 'canonical' },
      });
      assertBlockedStep(canonicalRes, 'canonical default-deny');

      assert.equal(sentCount(), 0, 'nothing may reach the hub when outbound-guard.json is absent');
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

/**
 * A blocked canonical delivery must not leave a fake "sending" record behind.
 *
 * If the guard ran after the claim was persisted, a replay of the same claim
 * hit the interrupted-send recovery and reported `ok:true` with
 * `outcome=unknown`, and the reconcile entry turned the same refusal into
 * `rejected / HXA_ROUTE_MISMATCH`. Both hid the fact that nothing was sent.
 * The chain below runs the real stream entry three times: send, replay of the
 * same claim, reconcile under a newer epoch.
 */
describe('outbound org guard — canonical replay and reconcile stay hard failures', () => {
  before(startFakeHub);
  after(stopFakeHub);


  it('three steps (send, replay, reconcile) each exit non-zero and keep the guard code', async () => {
    const home = makeHome({ guard: GUARD });
    const env = { HXA_FINAL_DELIVERY_MODE: 'canonical' };
    sentRequests = [];
    try {
      // All three steps run before any assertion, so a failing log shows the
      // whole chain (exit codes and stdout of each step), not just step 1.
      const steps = [
        ['send', await runStream(home, claimFor('customer-org'), { env })],
        ['replay', await runStream(home, claimFor('customer-org'), { env })],
        ['reconcile', await runStream(home, reconcileClaimFor('customer-org', 2), { env })],
      ];
      const summary = steps.map(([name, result]) => `${name}: exit=${result.code} stdout=${result.stdout.trim() || '(empty)'}`).join(' | ');

      for (const [name, result] of steps) {
        try {
          assertBlockedStep(result, name);
        } catch (error) {
          error.message = `${error.message} — ${summary}`;
          throw error;
        }
        assert.equal(stdoutCodes(result).some(entry => entry.errorCode === 'HXA_ROUTE_MISMATCH'), false,
          `${name}: a guard block must not become a route mismatch — ${summary}`);
      }

      assert.equal(sentCount(), 0, 'no step may reach /api/send');
    } finally {
      cleanup(home);
    }
  });

  it('a blocked send persists no sending claim, so a replay stays a refusal', async () => {
    const home = makeHome({ guard: GUARD });
    const env = { HXA_FINAL_DELIVERY_MODE: 'canonical' };
    sentRequests = [];
    try {
      const send = await runStream(home, claimFor('customer-org'), { env });
      const dir = path.join(home, 'zylos', 'components', 'hxa-connect', 'assistant-response-deliveries');
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(name => name.endsWith('.json'))
        : [];
      for (const file of files) {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        assert.notEqual(record.status, 'sending', 'a refused org must not leave a sending claim');
        assert.notEqual(record.status, 'reconciling', 'a refused org must not leave a reconcile claim');
        assert.equal(record.attempts ?? 0, 0, 'a refused org must not count as an attempt');
      }

      const replay = await runStream(home, claimFor('customer-org'), { env });
      assertBlockedStep(replay, 'replay');
      assert.equal(stdoutCodes(replay).some(entry => entry.status === 'unknown'), false,
        'a refusal must not be replayed as an ambiguous send');
      assert.notEqual(replay.code, 0, 'a refused replay must exit non-zero');
    } finally {
      cleanup(home);
    }
  });
});

/**
 * A delivery record written by an OLDER build must not outrank the guard.
 *
 * The previous round fixed new records but left this hole: `deliver()` and
 * `reconcile()` returned a historical receipt (or recovered a `sending` record
 * into `unknown`) before the org was checked, so replaying a claim that an
 * older build had already failed returned `ok:true` with exit 0 — an `unknown`
 * or a route-rejected receipt presented as success, for an org the guard
 * refuses.
 *
 * The chain below reproduces the reviewer's steps without hand-editing any
 * record: the legacy head (`HXA_LEGACY_STREAM`, default `9835fc72`) runs first
 * and writes its own leftovers, then this head replays the identical claims
 * against the same store. Both heads also see a legacy `rejected /
 * HXA_ROUTE_MISMATCH` record produced through a genuine routing failure.
 */
describe('outbound org guard — records left by an older build', () => {
  let legacyTempDir = null;
  let legacyStreamPath = process.env.HXA_LEGACY_STREAM || '';

  before(async () => {
    await startFakeHub();
    if (!legacyStreamPath) {
      // Materialize the real 9835fc72 checkout from local git history so clean
      // clones and CI exercise the exact historical script without weakening.
      try {
        execFileSync('git', ['rev-parse', '--verify', LEGACY_COMMIT], { cwd: REPO_ROOT, stdio: 'ignore' });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-legacy-9835fc72-'));
        const tarBuf = execFileSync('git', ['archive', LEGACY_COMMIT], {
          cwd: REPO_ROOT,
          maxBuffer: 20 * 1024 * 1024,
        });
        execFileSync('tar', ['-xf', '-', '-C', dir], { input: tarBuf });
        const repoModules = path.join(REPO_ROOT, 'node_modules');
        if (fs.existsSync(repoModules)) {
          fs.symlinkSync(repoModules, path.join(dir, 'node_modules'), 'dir');
        }
        legacyTempDir = dir;
        legacyStreamPath = path.join(dir, 'scripts', 'stream.js');
      } catch {
        legacyStreamPath = '';
      }
    }
  });

  after(async () => {
    await stopFakeHub();
    if (legacyTempDir) {
      fs.rmSync(legacyTempDir, { recursive: true, force: true });
      legacyTempDir = null;
    }
  });

  const legacyAvailable = () => legacyStreamPath !== '' && fs.existsSync(legacyStreamPath);

  function storeDir(home) {
    return path.join(home, 'zylos', 'components', 'hxa-connect', 'assistant-response-deliveries');
  }

  function records(home) {
    const dir = storeDir(home);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  }

  it('replaying an older build\'s unknown/rejected record is still a refusal', async () => {
    if (!legacyAvailable()) {
      // Without the legacy script the historical record cannot be produced, and
      // a self-made one would not prove the reported case. Fail loudly rather
      // than pass on a substitute.
      assert.fail(`HXA_LEGACY_STREAM must point at a checkout of 9835fc72 (got "${legacyStreamPath}")`);
    }
    const home = makeHome({ guard: GUARD });
    const env = { HXA_FINAL_DELIVERY_MODE: 'canonical' };
    const claim = canonicalPayload('customer-org');
    sentRequests = [];
    try {
      // Step 1-2: the legacy build refuses the send after writing a `sending`
      // claim, then mistakes it for an interrupted send.
      await runStream(home, claim, { env, script: legacyStreamPath });
      await runStream(home, claim, { env, script: legacyStreamPath });
      const legacyRecords = records(home);
      assert.equal(legacyRecords.length, 1, 'the legacy build must have left exactly one record');
      assert.ok(
        legacyRecords[0].receipts?.some(receipt => receipt.outcome === 'unknown'),
        `the legacy build must leave an unknown receipt, got ${JSON.stringify(legacyRecords[0].status)}`,
      );

      // Step 3: this head replays the same claim. The guard must win over the
      // historical receipt.
      const replay = await runStream(home, claim, { env });
      assertBlockedStep(replay, 'replay of a legacy unknown record');
      assert.equal(sentCount(), 0, 'nothing may reach /api/send');
    } finally {
      cleanup(home);
    }
  });

  it('replaying an older build\'s route-rejected reconcile claim is still a refusal', async () => {
    if (!legacyAvailable()) {
      assert.fail(`HXA_LEGACY_STREAM must point at a checkout of 9835fc72 (got "${legacyStreamPath}")`);
    }
    const home = makeHome({ guard: GUARD });
    const env = { HXA_FINAL_DELIVERY_MODE: 'canonical' };
    const claim = canonicalPayload('customer-org');
    const reconcileClaim = reconcileClaimFor('customer-org', 2);
    sentRequests = [];
    try {
      // Step 4: the legacy build records the refusal as rejected/ROUTE_MISMATCH.
      await runStream(home, claim, { env, script: legacyStreamPath });
      await runStream(home, reconcileClaim, { env, script: legacyStreamPath });
      const legacyRecords = records(home);
      assert.equal(legacyRecords.length, 1);
      assert.ok(
        legacyRecords[0].receipts?.some(receipt => receipt.errorCode === 'HXA_ROUTE_MISMATCH'),
        'the legacy build must leave a rejected/ROUTE_MISMATCH receipt',
      );

      // Step 5: this head replays the identical reconcile claim.
      const replay = await runStream(home, reconcileClaim, { env });
      assertBlockedStep(replay, 'replay of a legacy rejected record');
      assert.equal(sentCount(), 0, 'nothing may reach /api/send');
    } finally {
      cleanup(home);
    }
  });

  it('a genuine routing failure stays rejected/ROUTE_MISMATCH, not a guard refusal', async () => {
    // `ghost` is listed as internal, so the guard allows it, but no config entry
    // exists: the resolver rejects it. That must stay a rejected receipt.
    const home = makeHome({ guard: { internal_labels: ['internal', 'ghost'] } });
    const env = { HXA_FINAL_DELIVERY_MODE: 'canonical' };
    const claim = canonicalPayload('ghost');
    sentRequests = [];
    try {
      const result = await runStream(home, claim, { env });
      const codes = stdoutCodes(result);
      const receipt = codes.find(entry => entry.outcome === 'rejected');
      assert.ok(receipt, `expected a rejected receipt, got ${result.stdout.trim()}`);
      assert.equal(receipt.errorCode, 'HXA_ROUTE_MISMATCH');
      assert.equal(receipt.retryable, false);
      assert.equal(codes.some(entry => entry.errorCode === 'HXA_OUTBOUND_GUARD_BLOCKED'), false,
        'a routing failure must not be reported as a guard refusal');
      assert.equal(sentCount(), 0);
    } finally {
      cleanup(home);
    }
  });
});
