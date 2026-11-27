import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isLocalEndpoint, localEndpoint } from '../src/lib/local-endpoint.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noConfig = { ...process.env, HOME: path.join(repoRoot, '.test-no-home') };

test('local notices use a prefixed marker, never a bare bot name', () => {
  assert.equal(localEndpoint('admin'), 'local:admin');
  assert.equal(isLocalEndpoint('local:admin'), true);
  // A real hub bot may legitimately be called `admin`; it must stay remote.
  assert.equal(isLocalEndpoint('admin'), false);
  assert.equal(isLocalEndpoint('adai'), false);
});

test('local notice endpoint is recorded but not delivered to the hub', () => {
  // No config, no token, no network: the local branch must exit before the
  // client is built. A hub lookup would fail here, so exit 0 proves no send.
  const out = execFileSync(process.execPath, ['scripts/send.js', 'org:org-2|local:admin', 'ping'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: noConfig,
  });

  assert.match(out, /local endpoint local:admin: recorded, not sent/);
});

test('a real bot named admin still takes the normal send path', () => {
  // Same CLI, bare `admin`: it must not match the local branch. With no config
  // the normal path exits non-zero before any network call.
  const result = spawnSync(process.execPath, ['scripts/send.js', 'org:org-2|admin', 'ping'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: noConfig,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read config|org "org-2" not found/);
  assert.doesNotMatch(result.stdout, /recorded, not sent/);
});
