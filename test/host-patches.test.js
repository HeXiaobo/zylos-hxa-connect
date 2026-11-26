/**
 * Ported host patches — pinned so a future upstream merge cannot drop them.
 *
 * These three patches lived only on individual hosts (mini, the Mylos box) and
 * were never in the fork's git history. The upstream 1.7.4 – 1.7.10 merge
 * rewrote the exact functions they touch (bot.js connection lifecycle,
 * send.js send paths), so without these tests a future merge could quietly
 * remove them again.
 *
 *   1. Connection diagnostics (mini) — one structured log line per socket
 *      lifecycle event, allowlisted fields only.
 *   2. C4 reply receipt (mini) — `C4_RECEIPT {json}` on stdout, carrying the
 *      Hub message id back to core.
 *   3. Outbound media (Mylos box) — `[MEDIA:image|file]<abs path>` prefix.
 *
 * 2 and 3 are process-level tests against a loopback stub hub, like
 * outbound-guard.test.js: nothing leaves the machine.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOT_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
const SEND_SCRIPT = path.join(ROOT, 'scripts', 'send.js');

// ─── 1. Connection diagnostics stays in bot.js ──────────────────────────────

describe('connection diagnostics (mini patch)', () => {
  it('still wraps every socket lifecycle event and emits allowlisted fields', () => {
    // The patch is the thing that makes "connected but silent" vs "socket gone"
    // distinguishable. Assert the shape, not a log string, so wording can move.
    for (const event of ['pong', 'close', 'reconnecting', 'reconnected', 'reconnect_failed']) {
      assert.match(
        BOT_SOURCE,
        new RegExp(`client\\.on\\('${event}'`),
        `bot.js no longer observes the '${event}' socket event`,
      );
    }
    assert.match(BOT_SOURCE, /function createConnectionDiagnostics\(client, label\)/);
    assert.match(BOT_SOURCE, /Connection \$\{JSON\.stringify\(\{/, 'the structured Connection line is gone');
    // Allowlist discipline: these must never be logged from the diagnostics.
    const fn = BOT_SOURCE.slice(
      BOT_SOURCE.indexOf('function createConnectionDiagnostics'),
      BOT_SOURCE.indexOf('function escapeXml'),
    );
    for (const forbidden of ['agent_token', 'agentToken', 'token:', 'reason', 'payload', 'data:']) {
      assert.ok(!fn.includes(forbidden), `diagnostics must not log "${forbidden}" (credentials/opaque payloads)`);
    }
  });

  it('reports the successful connect from the real connect path', () => {
    assert.match(BOT_SOURCE, /const diagnostics = createConnectionDiagnostics\(client, label\);/);
    assert.match(BOT_SOURCE, /await client\.connect\(\);\s*\n\s*console\.log\(`\$\{lp\} WebSocket connected`\);\s*\n\s*diagnostics\.connected\(\);/);
  });
});

// ─── 2 + 3. Process-level: stub hub ─────────────────────────────────────────

const FIXTURE_TOKEN = 'test-token-not-a-real-secret';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

let received = [];
let hub;
let hubUrl;

function startHub() {
  return new Promise((resolve) => {
    hub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // A stable, distinct id per send so the receipt can be asserted on.
        res.end(JSON.stringify({ ok: true, id: `hub-msg-${received.length}`, message: { id: `hub-msg-${received.length}` } }));
      });
    });
    hub.listen(0, '127.0.0.1', () => {
      hubUrl = `http://127.0.0.1:${hub.address().port}`;
      resolve();
    });
  });
}

function stopHub() {
  return new Promise((resolve) => hub.close(resolve));
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-hostpatch-'));
  const dir = path.join(home, 'zylos', 'components', 'hxa-connect');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    enabled: true,
    default_hub_url: hubUrl,
    orgs: {
      default: {
        enabled: true,
        org_id: ORG_ID,
        agent_id: 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa',
        agent_token: FIXTURE_TOKEN,
        agent_name: 'fixture-bot',
        hub_url: hubUrl,
      },
    },
  }, null, 2));
  fs.writeFileSync(
    path.join(dir, 'outbound-guard.json'),
    JSON.stringify({ internal_labels: ['default'] }, null, 2),
  );
  return home;
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function runSend(home, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SEND_SCRIPT, ...args],
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
  });
}

function receiptLine(stdout) {
  const line = stdout.split('\n').find(l => l.startsWith('C4_RECEIPT '));
  return line ? JSON.parse(line.slice('C4_RECEIPT '.length)) : null;
}

before(startHub);
after(stopHub);

describe('C4 reply receipt (mini patch)', () => {
  it('prints C4_RECEIPT with the Hub message id when the caller supplies a token', async () => {
    const home = makeHome();
    received = [];
    try {
      const res = await runSend(home, ['some-bot', 'hello'], {
        env: { ZYLOS_REPLY_RECEIPT_TOKEN: 'receipt-token-fixture' },
      });

      assert.equal(res.code, 0, res.stderr);
      const receipt = receiptLine(res.stdout);
      assert.ok(receipt, `no C4_RECEIPT line on stdout:\n${res.stdout}`);
      assert.equal(receipt.receiptToken, 'receipt-token-fixture');
      assert.equal(typeof receipt.platformMessageId, 'string');
      assert.ok(receipt.platformMessageId.length > 0);
      assert.equal(receiptLine(res.stdout) !== null, true);
    } finally {
      cleanup(home);
    }
  });

  it('emits no receipt when the caller supplies no token', async () => {
    const home = makeHome();
    received = [];
    try {
      const res = await runSend(home, ['some-bot', 'hello']);

      assert.equal(res.code, 0, res.stderr);
      assert.equal(receiptLine(res.stdout), null, 'a receipt without a token pair is not usable');
      assert.equal(received.length, 1, 'the message itself still went out');
    } finally {
      cleanup(home);
    }
  });
});

describe('outbound media (Mylos box patch)', () => {
  it('rejects a malformed [MEDIA:] prefix instead of sending the path as text', async () => {
    const home = makeHome();
    received = [];
    try {
      const res = await runSend(home, ['some-bot', '[MEDIA:video]/tmp/nope.mp4']);

      assert.notEqual(res.code, 0, 'a bad media type must fail loudly');
      assert.equal(received.length, 0, 'nothing may reach the hub');
      assert.doesNotMatch(res.stdout, /Sent to/);
    } finally {
      cleanup(home);
    }
  });

  it('rejects a relative media path without contacting the hub', async () => {
    const home = makeHome();
    received = [];
    try {
      const res = await runSend(home, ['some-bot', '[MEDIA:file]relative/path.txt']);

      assert.notEqual(res.code, 0);
      assert.equal(received.length, 0);
    } finally {
      cleanup(home);
    }
  });

  it('rejects a missing file without contacting the hub', async () => {
    const home = makeHome();
    received = [];
    try {
      const res = await runSend(home, ['some-bot', '[MEDIA:file]/definitely/not/here.txt']);

      assert.notEqual(res.code, 0);
      assert.equal(received.length, 0);
    } finally {
      cleanup(home);
    }
  });
});

// ─── review round 1 regressions ─────────────────────────────────────────────

describe('round-1 review findings stay fixed', () => {
  it('P0: diagnostics is passed into connectOrg, not referenced across a block boundary', () => {
    // `diagnostics` is declared inside the per-org loop; `connectOrg()` is
    // defined outside it. Reading it there threw ReferenceError on every
    // successful connect, which the retry handler then turned into a
    // disconnect loop that never started the recovery paths.
    assert.match(
      BOT_SOURCE,
      /connections\.set\(label, \{[^}]*\bdiagnostics\b[^}]*\}\)/,
      'the connection record must carry diagnostics',
    );
    assert.match(
      BOT_SOURCE,
      /async function connectOrg\(label, \{[^}]*\bdiagnostics\b[^}]*\}\)/,
      'connectOrg must destructure diagnostics instead of closing over the loop scope',
    );
  });

  it('P1: the catch-up DM path goes through processDm, so the policy gate and identity apply', () => {
    const catchup = BOT_SOURCE.slice(
      BOT_SOURCE.indexOf('deliverMessage: async ({ kind, message, channelId, threadId }) => {'),
      BOT_SOURCE.indexOf('deliverSummary:'),
    );
    assert.match(catchup, /await processDm\(\s*\{[^}]*channel_id[^}]*\},\s*'catchup',/,
      'a replayed DM must enter the same intake seam as the socket path');
    assert.doesNotMatch(catchup, /await deliverDm\(\{/,
      'calling deliverDm directly would skip the DM policy gate and the stable C4 identity');
  });

  it('P1: an id in flight elsewhere is deferred, but the caller\'s own reservation is not', () => {
    // A plain isInFlight() check would make the catch-up runner defer to ITSELF:
    // it calls gate.begin(id) before invoking the intake path.
    assert.match(BOT_SOURCE, /gate\.isHeldByOther\(message\.id, ownReservations\)/);
    assert.match(BOT_SOURCE, /reason: 'in_flight_elsewhere'/);
    assert.match(
      BOT_SOURCE,
      /ownReservations: message\?\.id \? \[message\.id\] : \[\]/,
      'the catch-up caller must declare its own reservation as its own',
    );
  });
});

describe('C4 spool completion markers', () => {
  it('P1: a delivered id is still recognised after a restart', async () => {
    const { C4DeliveryQueue } = await import('../src/lib/c4-delivery-queue.js');
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-spool-'));
    const calls = [];
    const execFileFn = (cmd, args, opts, cb) => { calls.push(args); cb(null, '{}', ''); };
    const opts = {
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn,
      retryMs: 5,
      maxRetryMs: 10,
    };
    try {
      const first = new C4DeliveryQueue(opts);
      await first.start();
      await first.enqueue({ id: 'hxa:p1:m1', args: ['--content', 'one'], preview: 'one' });
      await first.waitForIdle(2000);
      const afterFirst = calls.length;
      first.stop();

      assert.equal(afterFirst, 1, 'the first enqueue must reach C4 exactly once');
      assert.equal(await first.pendingCount(), 0, 'the pending record is gone');

      // Simulate a restart before the caller persisted its handled-id.
      const second = new C4DeliveryQueue(opts);
      await second.start();
      const receipt = await second.enqueue({ id: 'hxa:p1:m1', args: ['--content', 'one'], preview: 'one' });
      await second.waitForIdle(2000);
      second.stop();

      assert.equal(receipt.delivered, true, 'a completed id must not be re-queued');
      assert.equal(calls.length, afterFirst, 'and must not reach C4 a second time');
    } finally {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });
});

describe('malformed [MEDIA:] never leaks a path as text', () => {
  for (const bad of ['[MEDIA:]/tmp/x.pdf', '[MEDIA:image ]/tmp/x.pdf', '[media:image]/tmp/x.pdf', '[ MEDIA : image]/tmp/x.pdf']) {
    it(`rejects ${JSON.stringify(bad)} without contacting the hub`, async () => {
      const home = makeHome();
      received = [];
      try {
        const res = await runSend(home, ['some-bot', bad]);
        assert.notEqual(res.code, 0, `${bad} must fail loudly, got exit 0:\n${res.stdout}`);
        assert.equal(received.length, 0, 'nothing may reach the hub');
        assert.doesNotMatch(res.stdout, /Sent to/, 'the path must never be sent as chat text');
      } finally {
        cleanup(home);
      }
    });
  }
});

describe('connectOrg startup path (P0 regression, executed not grepped)', () => {
  it('runs a successful connect without a ReferenceError and starts both recovery paths', async () => {
    const vm = await import('node:vm');
    const start = BOT_SOURCE.indexOf('async function connectOrg(');
    assert.notEqual(start, -1);
    // Take the whole function body up to the top-level await that follows it.
    const end = BOT_SOURCE.indexOf('\nawait Promise.allSettled(', start);
    assert.notEqual(end, -1, 'connectOrg must be followed by the top-level connect loop');

    const events = [];
    const ctx = vm.createContext({
      console: { log() {}, error() {}, warn() {} },
      logPrefix: () => '[t]',
      MAX_CONNECT_ATTEMPTS: 1,
      // Needed by the success log line. Without it the line throws, connectOrg
      // catches the error, disconnects and deletes the connection — which the
      // old four-event assertion could not see.
      DM_RECONCILE_INTERVAL_MS: 15_000,
      connections: new Map(),
      setTimeout,
      Promise,
      redactSecrets: s => String(s),
      catchupState: { markGap() {}, scheduleSave() {} },
      client: null,
      threadCtx: null,
      catchup: null,
      dmReconciler: null,
      // Deliberately NO `diagnostics` here: it must arrive as a parameter. A
      // global would mask exactly the scoping bug this test exists to catch.
    });
    // `return` inside the vm only leaves the extracted function; the surrounding
    // loop belongs to bot.js. Cap the loop so the test measures ONE pass, which
    // is what the bug broke, without spinning 20 times with real backoff sleeps.
    ctx.MAX_CONNECT_ATTEMPTS = 1;
    vm.runInContext(
      `${BOT_SOURCE.slice(start, end)}\nglobalThis.connectOrg = connectOrg;`,
      ctx,
    );

    // A client that connects on the first attempt.
    const conn = {
      client: {
        connect: async () => { events.push('client.connect'); },
        disconnect: () => { events.push('client.disconnect'); },
      },
      threadCtx: { start: async () => { events.push('threadCtx.start'); } },
      catchup: { run: () => { events.push('catchup.run'); return Promise.resolve(); } },
      dmReconciler: { start: async () => { events.push('dmReconciler.start'); } },
      // `diagnostics` reaches connectOrg through the connection record (that is
      // the fix). It is NOT a sandbox global, so a version that closes over the
      // loop-scoped variable instead would throw ReferenceError here.
      diagnostics: { connected: () => events.push('diagnostics.connected') },
      config: { agentName: 'fixture-bot', hubUrl: 'http://127.0.0.1:1', orgId: 'org-fixture' },
    };

    await ctx.connectOrg('default', conn);

    // The real `while (attempt < MAX_CONNECT_ATTEMPTS)` loop keeps going because
    // this fixture's `return` path depends on process-level state; assert on the
    // FIRST successful pass, which is what the bug broke.
    assert.deepEqual(events.slice(0, 5), [
      'client.connect',
      'diagnostics.connected',
      'threadCtx.start',
      'catchup.run',
      'dmReconciler.start',
    ], `a successful connect must reach every step, got: ${JSON.stringify(events.slice(0, 5))}`);

    // And the happy path must COMPLETE: no error-driven disconnect, and the
    // connection must stay registered. Without DM_RECONCILE_INTERVAL_MS in this
    // context the success log line threw, connectOrg caught it, disconnected and
    // deleted the connection — while a prefix-only assertion still saw just the
    // first pass and went green.
    assert.deepEqual(events, [
      'client.connect',
      'diagnostics.connected',
      'threadCtx.start',
      'catchup.run',
      'dmReconciler.start',
    ], `a successful connect must not disconnect or retry: ${JSON.stringify(events)}`);
  });
});

// ─── review round 2 regressions ─────────────────────────────────────────────

describe('round-2 review findings stay fixed', () => {
  it('the catch-up runner does not defer to its own in-flight reservation', async () => {
    // The runner does gate.begin(id) BEFORE calling back. A plain isInFlight()
    // check therefore made every recovered DM defer to itself, forever.
    const { CatchupRunner, DeliveryGate } = await import('../src/lib/catchup.js');
    const { CatchupStateStore } = await import('../src/lib/catchup-state.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-selfres-'));
    const state = new CatchupStateStore({ filePath: path.join(dir, 's.json') }).load();
    const T = Date.now() - 60_000;
    state.setEventsSince('default', T);
    state.markGap('default');
    const gate = new DeliveryGate({ state, label: 'default' });

    const delivered = [];
    const client = {
      async catchup() {
        return { events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: T + 1000 }], has_more: false };
      },
      async getMessages() { return [{ id: 'm1', sender_id: 'peer', created_at: T + 1000, content: 'x' }]; },
      async getThreadMessages() { return []; },
    };
    const runner = new CatchupRunner({
      client, state, label: 'default', gate, now: () => T + 30_000,
      limits: { batchDelayMs: 0 }, log: () => {},
      deliverMessage: async ({ message }) => {
        // Mimic the real intake check with the runner's reservation declared.
        if (gate.isHeldByOther(message.id, [message.id])) {
          throw new Error('deferred to itself');
        }
        delivered.push(message.id);
        gate.mark(message.id, T + 1000);
      },
    });
    try {
      await runner.run();
      runner.dispose();
      assert.deepEqual(delivered, ['m1'], 'the reserved message must be delivered, not deferred to itself');
    } finally {
      runner.dispose?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catch-up summary and event notices cannot escape as unhandled rejections', () => {
    const catchupCfg = BOT_SOURCE.slice(
      BOT_SOURCE.indexOf('deliverSummary: async (text) => {'),
      BOT_SOURCE.indexOf('deliverEvent: async (event) => {'),
    );
    assert.match(catchupCfg, /await sendToC4\(/, 'the summary enqueue must be awaited');
    assert.match(catchupCfg, /catch \(err\)/, 'and its failure logged, not left unhandled');

    const eventCfg = BOT_SOURCE.slice(
      BOT_SOURCE.indexOf('deliverEvent: async (event) => {'),
      BOT_SOURCE.indexOf("client.on('close'", BOT_SOURCE.indexOf('deliverEvent: async (event) => {')),
    );
    assert.match(eventCfg, /await sendToC4\(/, 'the event notice enqueue must be awaited');
    assert.match(eventCfg, /catch \(err\)/);
  });

  it('expiring a completion marker drops its pending record first', async () => {
    const { C4DeliveryQueue } = await import('../src/lib/c4-delivery-queue.js');
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-marker-'));
    const calls = [];
    const opts = {
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn: (c, a, o, cb) => { calls.push(a); cb(null, '{}', ''); },
      // Expire markers immediately, so startup prunes.
      doneRetentionMs: 0,
    };
    try {
      const id = 'hxa:p1:marker';
      const q1 = new C4DeliveryQueue(opts);
      await q1.start();
      await q1.enqueue({ id, args: ['--content', 'x'], preview: 'x' });
      await q1.waitForIdle(2000);
      q1.stop();
      assert.equal(calls.length, 1);

      // Recreate the crash window: marker present AND its pending record still
      // there. With the old prune order the marker went first and the record
      // was re-sent.
      const files = fs.readdirSync(spoolDir);
      const marker = files.find(f => f.endsWith('.done'));
      assert.ok(marker, 'a completion marker must exist');
      const record = path.join(spoolDir, marker.slice(0, -'.done'.length));
      fs.writeFileSync(record, JSON.stringify({
        schemaVersion: 1, id, args: ['--content', 'x'], preview: 'x',
        enqueuedAt: Date.now(), attempts: 0, availableAt: Date.now(), lastError: null,
      }));
      // Backdate the marker so `doneRetentionMs: 0` prunes it on start.
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(path.join(spoolDir, marker), old, old);

      const q2 = new C4DeliveryQueue(opts);
      await q2.start();
      await q2.waitForIdle(2000);
      q2.stop();

      assert.equal(calls.length, 1, 'an expired marker must take its pending record with it, not re-send');
      assert.equal(await q2.pendingCount(), 0);
    } finally {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it('a completed assistant-response replay still yields the Hub message id', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'assistant-response-delivery.js'), 'utf8');
    const replay = source.slice(
      source.indexOf("if (record.status === 'delivered' || record.status === 'suppressed')"),
      source.indexOf("if (suppressSkip"),
    );
    assert.match(replay, /hubMessageId: record\.hubMessageId/,
      'the ordinary completed-replay branch must return the stored Hub id for the receipt');
  });
});

describe('round-3 review findings stay fixed', () => {
  it('a replayed DM is not throttled by the realtime token bucket', () => {
    // The bucket is a socket-burst throttle. A replay is paced by the runner's
    // batches; applying the bucket there stranded a finite backlog until refill
    // and then threw, ending the run.
    const processDm = BOT_SOURCE.slice(
      BOT_SOURCE.indexOf('async function processDm(raw, source'),
      BOT_SOURCE.indexOf('const dmReconciler = new DmInboxReconciler'),
    );
    assert.match(processDm, /if \(source === 'websocket'\) \{[\s\S]*getRateLimiter/,
      'the rate limit must be scoped to the socket source');
    assert.match(processDm, /reason: 'rate_limit'/);
  });

  it('an unresolved replayed DM does not abort the whole replay run', () => {
    const catchup = BOT_SOURCE.slice(
      BOT_SOURCE.indexOf("deliverMessage: async ({ kind, message, channelId, threadId }) => {"),
      BOT_SOURCE.indexOf('deliverSummary:'),
    );
    // A throw here propagates to CatchupRunner's scan loop, which ends message
    // scanning for the run: a later deliverable thread would never be visited.
    assert.doesNotMatch(catchup, /throw err;\s*\}\s*\n\s*\}\s*,\s*\n\s*\/\/ One notice line/,
      'the retry path must not throw out of the catch-up callback');
    assert.match(catchup, /left unresolved/, 'it should log and continue');
  });

  it('completion markers are swept during continuous operation, not only at startup', async () => {
    const { C4DeliveryQueue } = await import('../src/lib/c4-delivery-queue.js');
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-sweep-'));
    const calls = [];
    const q = new C4DeliveryQueue({
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn: (c, a, o, cb) => { calls.push(a); cb(null, '{}', ''); },
      doneRetentionMs: 0,
    });
    try {
      await q.start();
      await q.enqueue({ id: 'hxa:sweep:a', args: ['--content', 'a'], preview: 'a' });
      await q.waitForIdle(2000);
      // First delivery triggers a sweep (lastPruneAt was set at start, so force
      // the hourly gate open to observe the sweep running mid-life).
      q.lastPruneAt = 0;
      await q.enqueue({ id: 'hxa:sweep:b', args: ['--content', 'b'], preview: 'b' });
      await q.waitForIdle(2000);
      q.stop();

      assert.equal(calls.length, 2);
      // With doneRetentionMs 0 and a sweep after the second delivery, the first
      // marker is candidates for removal — the point is that a sweep RAN without
      // a restart, so the directory does not grow for weeks.
      const markers = fs.readdirSync(spoolDir).filter(f => f.endsWith('.done'));
      assert.ok(markers.length <= 1, `stale markers must be swept mid-life, found ${markers.length}`);
    } finally {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });
});
