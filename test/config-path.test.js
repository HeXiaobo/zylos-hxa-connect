import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

function runNode(source, environment) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(environment)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
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
    "import { getConfigPath } from './src/lib/config.js'; console.log(getConfigPath());",
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

test('config path falls back to HOME/zylos when ZYLOS_DIR is empty', () => {
  assert.equal(
    readConfigPath({ HOME: '/tmp/hxa-config-home', ZYLOS_DIR: '' }),
    path.join('/tmp/hxa-config-home/zylos', 'components/hxa-connect/config.json'),
  );
});

test('config path uses ZYLOS_DIR loaded from HOME/zylos/.env', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-dotenv-home-'));
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-dotenv-root-'));
  const configDir = path.join(zylosDir, 'components/hxa-connect');
  fs.mkdirSync(path.join(homeDir, 'zylos'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'zylos/.env'), `ZYLOS_DIR=${zylosDir}\n`);

  try {
    const child = runNode(
      "import { loadConfig as loadAdminConfig, saveConfig } from './src/lib/config.js'; import { loadConfig as loadRuntimeConfig } from './src/env.js'; saveConfig({ marker: 'dotenv-root' }); console.log(JSON.stringify({ admin: loadAdminConfig(), runtime: loadRuntimeConfig() }));",
      { HOME: homeDir, ZYLOS_DIR: null },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      admin: { marker: 'dotenv-root' },
      runtime: { marker: 'dotenv-root' },
    });
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect/config.json')), false);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('config path remains absolute with ZYLOS_DIR when HOME is missing', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-no-home-root-'));

  try {
    const resolved = readConfigPath({ HOME: null, ZYLOS_DIR: zylosDir });
    assert.equal(resolved, path.join(zylosDir, 'components/hxa-connect/config.json'));
    assert.equal(path.isAbsolute(resolved), true);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('config path falls back to os.homedir when HOME is empty', () => {
  assert.equal(
    readConfigPath({ HOME: '', ZYLOS_DIR: null }),
    path.join(os.homedir(), 'zylos', 'components/hxa-connect/config.json'),
  );
});

test('config path follows the current ZYLOS_DIR instead of an import-time snapshot', () => {
  const child = runNode(
    "import { getConfigPath } from './src/lib/config-path.js'; process.env.ZYLOS_DIR = '/tmp/hxa-config-first'; const first = getConfigPath(); process.env.ZYLOS_DIR = '/tmp/hxa-config-second'; const second = getConfigPath(); console.log(JSON.stringify({ first, second }));",
    { HOME: '/tmp/hxa-config-home' },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    first: path.join('/tmp/hxa-config-first', 'components/hxa-connect/config.json'),
    second: path.join('/tmp/hxa-config-second', 'components/hxa-connect/config.json'),
  });
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
  const original = '{"display_name":"legacy","marker":"keep"}\n';
  fs.writeFileSync(configPath, original);

  try {
    const child = spawnSync(process.execPath, ['hooks/post-upgrade.js'], {
      cwd: ROOT,
      env: { ...process.env, HOME: homeDir, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
    });

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { marker: 'keep' });
    const backups = fs.readdirSync(configDir).filter((name) => name.startsWith('config.json.backup.'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(configDir, backups[0]), 'utf8'), original);
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect/config.json')), false);
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect/config.json.pre-upgrade.bak')), false);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('pre-upgrade backs up the config selected by ZYLOS_DIR', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-pre-upgrade-root-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-pre-upgrade-home-'));
  const configDir = path.join(zylosDir, 'components/hxa-connect');
  const configPath = path.join(configDir, 'config.json');
  const original = '{"org_id":"org-1","agent_token":"token"}\n';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, original);

  try {
    const child = spawnSync(process.execPath, ['hooks/pre-upgrade.js'], {
      cwd: ROOT,
      env: { ...process.env, HOME: homeDir, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
    });

    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.readFileSync(`${configPath}.pre-upgrade.bak`, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect/config.json')), false);
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect/config.json.pre-upgrade.bak')), false);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('post-install uses the config path selected by ZYLOS_DIR', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-post-install-root-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-post-install-home-'));
  const configDir = path.join(zylosDir, 'components/hxa-connect');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ orgs: { default: { agent_token: 'token' } } }) + '\n');

  try {
    const child = spawnSync(process.execPath, ['hooks/post-install.js'], {
      cwd: ROOT,
      env: { ...process.env, HOME: homeDir, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
    });

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /already has orgs with credentials/);
    assert.equal(fs.existsSync(path.join(configDir, 'logs')), true);
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect/config.json')), false);
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect/logs')), false);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('post-install uses ZYLOS_DIR loaded from HOME/zylos/.env', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-post-dotenv-root-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-post-dotenv-home-'));
  const configDir = path.join(zylosDir, 'components/hxa-connect');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(path.join(homeDir, 'zylos'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'zylos/.env'), `ZYLOS_DIR=${zylosDir}\n`);
  fs.writeFileSync(configPath, JSON.stringify({ orgs: { default: { agent_token: 'token' } } }) + '\n');

  try {
    const childEnv = { ...process.env, HOME: homeDir };
    delete childEnv.ZYLOS_DIR;
    const child = spawnSync(process.execPath, ['hooks/post-install.js'], {
      cwd: ROOT,
      env: childEnv,
      encoding: 'utf8',
    });

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /already has orgs with credentials/);
    assert.equal(fs.existsSync(path.join(configDir, 'logs')), true);
    assert.equal(fs.existsSync(path.join(homeDir, 'zylos/components/hxa-connect')), false);
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('post-install uses HXA_CONNECT_PROXY, then HTTPS_PROXY, then HTTP_PROXY', () => {
  const cases = [
    {
      name: 'component proxy',
      environment: {
        HXA_CONNECT_PROXY: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:2',
        HTTP_PROXY: 'http://127.0.0.1:3',
      },
      expected: 'http://127.0.0.1:1',
    },
    {
      name: 'HTTPS proxy fallback',
      environment: {
        HXA_CONNECT_PROXY: null,
        HTTPS_PROXY: 'http://127.0.0.1:2',
        HTTP_PROXY: 'http://127.0.0.1:3',
      },
      expected: 'http://127.0.0.1:2',
    },
    {
      name: 'HTTP proxy fallback',
      environment: {
        HXA_CONNECT_PROXY: null,
        HTTPS_PROXY: null,
        HTTP_PROXY: 'http://127.0.0.1:3',
      },
      expected: 'http://127.0.0.1:3',
    },
  ];

  for (const proxyCase of cases) {
    const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-post-proxy-root-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-post-proxy-home-'));
    try {
      const childEnv = {
        ...process.env,
        HOME: homeDir,
        ZYLOS_DIR: zylosDir,
        HXA_CONNECT_URL: 'http://127.0.0.1:1',
        HXA_CONNECT_ORG_ID: 'org-1',
        HXA_CONNECT_ORG_TICKET: 'ticket-1',
        HXA_CONNECT_AGENT_NAME: 'agent-1',
        ...proxyCase.environment,
      };
      for (const [key, value] of Object.entries(proxyCase.environment)) {
        if (value === null) delete childEnv[key];
      }
      const child = spawnSync(process.execPath, ['hooks/post-install.js'], {
        cwd: ROOT,
        env: childEnv,
        encoding: 'utf8',
        timeout: 5000,
      });

      assert.equal(child.error, undefined, `${proxyCase.name}: ${child.error?.message}`);
      assert.equal(child.status, 1, `${proxyCase.name}: ${child.stderr}`);
      assert.match(child.stdout, new RegExp(`Using proxy: ${proxyCase.expected.replaceAll('.', '\\.').replaceAll(':', '\\:')}`));
    } finally {
      fs.rmSync(zylosDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
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
