import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { newestDeliveryAgeMs } from '../src/lib/delivery-health.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-health-'));
}

test('reports no records for a missing directory', () => {
  const result = newestDeliveryAgeMs({ directory: path.join(makeTempDir(), 'nope') });
  assert.deepEqual(result, { hasRecords: false, newestMtimeMs: null, ageMs: null });
});

test('reports no records for an empty directory', () => {
  const result = newestDeliveryAgeMs({ directory: makeTempDir() });
  assert.deepEqual(result, { hasRecords: false, newestMtimeMs: null, ageMs: null });
});

test('reports the age of the newest record', () => {
  const dir = makeTempDir();
  const now = 1_700_000_000_000;
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'b.json'), '{}');
  fs.utimesSync(path.join(dir, 'a.json'), new Date(now - 60_000), new Date(now - 60_000));
  fs.utimesSync(path.join(dir, 'b.json'), new Date(now - 10_000), new Date(now - 10_000));
  const result = newestDeliveryAgeMs({ directory: dir, clock: () => now });
  assert.equal(result.hasRecords, true);
  assert.equal(result.ageMs, 10_000);
});

test('ignores non-JSON files (locks and temp files)', () => {
  const dir = makeTempDir();
  const now = 1_700_000_000_000;
  fs.writeFileSync(path.join(dir, 'x.lock'), '{}');
  fs.writeFileSync(path.join(dir, 'y.tmp.123'), '{}');
  const result = newestDeliveryAgeMs({ directory: dir, clock: () => now });
  assert.equal(result.hasRecords, false);
});

test('throws for a missing directory argument', () => {
  assert.throws(() => newestDeliveryAgeMs({}), /delivery store directory is required/);
});
