import assert from 'node:assert/strict';
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
