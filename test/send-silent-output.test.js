import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SEND = fileURLToPath(new URL('../scripts/send.js', import.meta.url));

test('send exits silently before initializing transport for an exact [SKIP] response', () => {
  const result = spawnSync(process.execPath, [
    SEND,
    'org:hxa|ss|msg:source-message',
    '  [SKIP]  ',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
