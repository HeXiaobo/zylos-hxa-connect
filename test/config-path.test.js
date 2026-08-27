import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

function runNode(source, environment) {
  const env = { ...process.env, ...environment };
  if (environment.ZYLOS_DIR === undefined) delete env.ZYLOS_DIR;
  delete env.HXA_CONFIG_PATH;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      source,
    ],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
}

function readConfigPath(environment) {
  const child = runNode(
    "import { CONFIG_PATH } from './src/lib/config.js'; console.log(CONFIG_PATH);",
    environment,
  );
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test('config path prefers ZYLOS_DIR over HOME/zylos', () => {
  assert.equal(
    readConfigPath({
      HOME: '/tmp/hxa-config-home',
      ZYLOS_DIR: '/tmp/hxa-config-root',
    }),
    path.join('/tmp/hxa-config-root', 'components/hxa-connect/config.json'),
  );
});

test('config path falls back to HOME/zylos when ZYLOS_DIR is absent', () => {
  assert.equal(
    readConfigPath({ HOME: '/tmp/hxa-config-home' }),
    path.join('/tmp/hxa-config-home/zylos', 'components/hxa-connect/config.json'),
  );
});

test('admin config writer and readers use the same ZYLOS_DIR config', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-config-root-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-config-home-'));
  const configDir = path.join(zylosDir, 'components/hxa-connect');
  fs.mkdirSync(configDir, { recursive: true });

  try {
    const child = runNode(
      "import { loadConfig as loadAdminConfig, saveConfig } from './src/lib/config.js'; import { loadConfig as loadRuntimeConfig } from './src/env.js'; saveConfig({ marker: 'shared' }); console.log(JSON.stringify({ admin: loadAdminConfig(), runtime: loadRuntimeConfig() }));",
      { HOME: homeDir, ZYLOS_DIR: zylosDir },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      admin: { marker: 'shared' },
      runtime: { marker: 'shared' },
    });
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('post-upgrade migrates the config selected by ZYLOS_DIR', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-hook-root-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-hook-home-'));
  const configDir = path.join(zylosDir, 'components/hxa-connect');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, '{"display_name":"legacy","marker":"keep"}\n');

  try {
    const child = spawnSync(process.execPath, ['hooks/post-upgrade.js'], {
      cwd: ROOT,
      env: { ...process.env, HOME: homeDir, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
    });

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { marker: 'keep' });
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('HXA_CONNECT_PROXY takes precedence over generic proxy variables', () => {
  const child = runNode(
    "import { PROXY_URL } from './src/env.js'; console.log(PROXY_URL);",
    {
      HOME: '/tmp/hxa-proxy-home',
      HXA_CONNECT_PROXY: 'http://hxa-proxy.example:8080',
      HTTPS_PROXY: 'http://https-proxy.example:8080',
      HTTP_PROXY: 'http://http-proxy.example:8080',
    },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'http://hxa-proxy.example:8080');
});
