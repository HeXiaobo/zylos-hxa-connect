import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SEND = fileURLToPath(new URL('../scripts/send.js', import.meta.url));

const LEDGER_DIR_NAMES = ['components', 'hxa-connect', 'assistant-response-deliveries'];

function makeIsolatedDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(dir, 'components', 'hxa-connect');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), `${JSON.stringify({
    default_hub_url: null,
    orgs: {
      default: {
        enabled: true,
        org_id: 'org-1',
        agent_id: 'agent-1',
        agent_token: 'token-1',
        agent_name: 'agent',
        hub_url: 'http://127.0.0.1:9',
        access: { dmPolicy: 'open', groupPolicy: 'open' },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

function ledgerRecords(isolatedDir) {
  const ledgerDir = path.join(isolatedDir, ...LEDGER_DIR_NAMES);
  if (!fs.existsSync(ledgerDir)) return [];
  return fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json'));
}

function spawnSend(args, { env: extraEnv = {} } = {}) {
  const isolatedDir = makeIsolatedDir('hxa-send-silent-');
  const result = spawnSync(process.execPath, [SEND, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: isolatedDir, ...extraEnv },
  });
  return { result, isolatedDir };
}

test('send exits silently before initializing transport for an exact [SKIP] response', () => {
  const { result, isolatedDir } = spawnSend([
    'org:hxa|ss|msg:source-message',
    '  [SKIP]  ',
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(ledgerRecords(isolatedDir).length, 0, 'the exact [SKIP] fast path leaves no ledger record');
});

test('send refuses blank or invisible-only content in explicit mode with MISSING_OUTPUT', () => {
  for (const content of ['', '   ', '\u200B']) {
    const { result, isolatedDir } = spawnSend(['org:hxa|ss|msg:source-message', content]);
    assert.equal(result.status, 1, `expected exit 1 for ${JSON.stringify(content)}`);
    assert.match(result.stderr, /MISSING_OUTPUT/);
    assert.equal(
      ledgerRecords(isolatedDir).length,
      0,
      'the refusal must not fabricate a ledger record',
    );
  }
});

test('send records durable silence for an invisible-only assistant response (issue #20)', () => {
  const { result, isolatedDir } = spawnSend(
    ['org:default|ss|msg:source-message', '\u200B'],
    { env: { C4_ASSISTANT_REQUEST_ID: 'hxa.dm.issue20-empty' } },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /mode=assistant-response/);
  assert.match(result.stderr, /Suppressed silent assistant response/);

  const records = ledgerRecords(isolatedDir);
  assert.equal(records.length, 1, 'the suppression must leave exactly one ledger record');
  const record = JSON.parse(fs.readFileSync(path.join(isolatedDir, ...LEDGER_DIR_NAMES, records[0]), 'utf8'));
  assert.equal(record.status, 'suppressed');
  assert.equal(record.requestId, 'hxa.dm.issue20-empty');
});

test('send still delivers visible assistant responses verbatim', () => {
  // No hub is listening on the dummy port; a visible response must attempt
  // the transport (and fail with a connection error), which proves the
  // content passed the visibility gate and was not suppressed.
  const { result, isolatedDir } = spawnSend(
    ['org:default|ss|msg:source-message', '.'],
    { env: { C4_ASSISTANT_REQUEST_ID: 'hxa.dm.issue20-visible' } },
  );

  assert.equal(result.status, 1, 'the dummy hub must refuse the connection');
  assert.match(result.stdout, /mode=assistant-response/);
  assert.match(result.stderr, /Error sending assistant response/);
  assert.doesNotMatch(result.stderr, /Suppressed silent assistant response/);
  assert.equal(
    ledgerRecords(isolatedDir).filter(record => record.endsWith('.json')).every(record => {
      const parsed = JSON.parse(fs.readFileSync(path.join(isolatedDir, ...LEDGER_DIR_NAMES, record), 'utf8'));
      return parsed.status === 'uncertain';
    }),
    true,
    'a visible response must go to the transport, not be suppressed',
  );
});
