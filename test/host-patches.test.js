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
