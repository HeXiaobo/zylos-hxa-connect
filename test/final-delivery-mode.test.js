import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveFinalDeliveryMode } from '../src/lib/assistant-response-delivery.js';

const STREAM = fileURLToPath(new URL('../scripts/stream.js', import.meta.url));

test('resolveFinalDeliveryMode defaults to off', () => {
  assert.equal(resolveFinalDeliveryMode({}), 'off');
  assert.equal(resolveFinalDeliveryMode({ HXA_FINAL_DELIVERY_MODE: 'nonsense' }), 'off');
  assert.equal(resolveFinalDeliveryMode(), 'off');
});

test('resolveFinalDeliveryMode honors explicit modes', () => {
  assert.equal(resolveFinalDeliveryMode({ HXA_FINAL_DELIVERY_MODE: 'off' }), 'off');
  assert.equal(resolveFinalDeliveryMode({ HXA_FINAL_DELIVERY_MODE: 'legacy' }), 'legacy');
  assert.equal(resolveFinalDeliveryMode({ HXA_FINAL_DELIVERY_MODE: 'canonical' }), 'canonical');
});

test('stream adapter in off mode consumes the stream, exits 0, and needs no config or transport', () => {
  const payload = {
    schemaVersion: 1,
    requestId: 'hxa.dm.smoke',
    route: { channel: 'hxa-connect', endpointId: 'peer-bot|msg:00000000-0000-4000-8000-000000000000' },
    events: [{ sequence: 1, type: 'RunCompleted', payload: { output: 'hello' } }],
  };
  const result = spawnSync(process.execPath, [STREAM], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.mode, 'off');
  assert.equal(response.status, 'suppressed');
});

function makeIsolatedStreamDir(prefix) {
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

test('stream adapter in legacy mode suppresses an empty RunCompleted output as durable silence (#20)', () => {
  const isolatedDir = makeIsolatedStreamDir('hxa-stream-empty-');
  const payload = {
    schemaVersion: 1,
    requestId: 'hxa.dm.issue20-stream-empty',
    route: { channel: 'hxa-connect', endpointId: 'org:hxa|peer-bot|msg:00000000-0000-4000-8000-000000000000' },
    events: [{ requestId: 'hxa.dm.issue20-stream-empty', type: 'RunCompleted', sequence: 5, payload: { output: ' \u200B ' } }],
  };
  const result = spawnSync(process.execPath, [STREAM], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: isolatedDir, HXA_FINAL_DELIVERY_MODE: 'legacy' },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.status, 'suppressed', 'empty output must terminate as suppressed, not delivered');
  assert.equal(response.eventType, 'RunCompleted');
  assert.equal(response.terminal, true);

  const ledgerDir = path.join(isolatedDir, 'components', 'hxa-connect', 'assistant-response-deliveries');
  const records = fs.readdirSync(ledgerDir).filter(name => name.endsWith('.json'));
  assert.equal(records.length, 1, 'the suppression must leave exactly one durable ledger record');
  const record = JSON.parse(fs.readFileSync(path.join(ledgerDir, records[0]), 'utf8'));
  assert.equal(record.status, 'suppressed');
});
