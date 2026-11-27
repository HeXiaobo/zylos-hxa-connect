import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isLocalEndpoint } from '../src/lib/local-endpoint.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('admin is a local endpoint', () => {
  assert.equal(isLocalEndpoint('admin'), true);
  assert.equal(isLocalEndpoint('adai'), false);
  assert.equal(isLocalEndpoint('thread:abc'), false);
});

test('admin pseudo endpoint is recorded but not delivered to the hub', () => {
  // No config, no token, no network: the local branch must exit before the
  // client is built. A hub lookup would fail here, so exit 0 proves no send.
  const out = execFileSync(process.execPath, ['scripts/send.js', 'org:org-2|admin', 'ping'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: path.join(repoRoot, '.test-no-home') },
  });

  assert.match(out, /local endpoint admin: recorded, not sent/);
});
