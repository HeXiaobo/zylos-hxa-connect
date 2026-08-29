import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('profile-verify refuses legacy config without migrating or writing a backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-hxa-profile-readonly-'));
  try {
    const configDir = path.join(root, 'components', 'hxa-connect');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');
    const legacy = {
      org_id: 'org-default',
      agent_id: 'profile-default',
      agent_token: 'secret-test-token',
      agent_name: 'xiaochen',
      hub_url: 'https://hub.invalid',
    };
    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    fs.writeFileSync(configPath, original, { mode: 0o600 });

    const result = spawnSync(process.execPath, [
      path.resolve('scripts/cli.js'),
      'profile-verify',
      '--org', 'default',
      '--profile-id', 'profile-default',
      '--hostname', 'host-one',
    ], {
      encoding: 'utf8',
      env: { ...process.env, ZYLOS_DIR: root, HXA_CONNECT_PROXY: '' },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Config not in multi-org format/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert.equal(fs.existsSync(`${configPath}.bak`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
