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
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

test('loads the canonical .env under an explicit ZYLOS_DIR with dotenv quotes and CRLF', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-runtime-home-'));
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-runtime-root-'));
  fs.writeFileSync(
    path.join(zylosDir, '.env'),
    'HXA_CONNECT_PROXY="http://explicit-proxy.example:8080"\r\nHXA_CONNECT_EMPTY=""\r\n',
  );

  try {
    const child = runNode(
      "import { getRuntimePaths, loadZylosEnv } from './src/lib/config-path.js'; loadZylosEnv(); console.log(JSON.stringify({ proxy: process.env.HXA_CONNECT_PROXY, empty: process.env.HXA_CONNECT_EMPTY, root: getRuntimePaths().zylosDir }));",
      {
        HOME: homeDir,
        ZYLOS_DIR: zylosDir,
        HXA_CONNECT_PROXY: null,
        HXA_CONNECT_EMPTY: null,
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      proxy: 'http://explicit-proxy.example:8080',
      empty: '',
      root: zylosDir,
    });
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('selects a proxy from the canonical .env without making a network request', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-proxy-root-'));
  fs.writeFileSync(path.join(zylosDir, '.env'), 'HXA_CONNECT_PROXY="http://canonical-proxy.example:8080"\r\n');

  try {
    const child = runNode(
      "import { PROXY_URL } from './src/env.js'; console.log(PROXY_URL);",
      {
        HOME: '/tmp/old-hxa-home',
        ZYLOS_DIR: zylosDir,
        HXA_CONNECT_PROXY: null,
        HTTPS_PROXY: null,
        HTTP_PROXY: null,
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'http://canonical-proxy.example:8080');
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('uses one fallback discovery pass before loading the discovered canonical .env', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-discovery-home-'));
  const zylosDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-discovery-root-')), 'root with spaces');
  const chainedDir = path.join(zylosDir, 'second-root');
  fs.mkdirSync(zylosDir, { recursive: true });
  fs.mkdirSync(chainedDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'zylos'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, 'zylos', '.env'),
    `ZYLOS_DIR="${zylosDir}"\r\nDISCOVERY_ONLY="fallback"\r\n`,
  );
  fs.writeFileSync(
    path.join(zylosDir, '.env'),
    `HXA_CONNECT_PROXY='http://canonical-proxy.example:8080'\r\nZYLOS_DIR=${chainedDir}\r\n`,
  );
  fs.writeFileSync(path.join(chainedDir, '.env'), 'CHAIN_ONLY=must-not-load\r\n');

  try {
    const child = runNode(
      "import { getRuntimePaths, loadZylosEnv } from './src/lib/config-path.js'; loadZylosEnv(); console.log(JSON.stringify({ proxy: process.env.HXA_CONNECT_PROXY, discovery: process.env.DISCOVERY_ONLY, chain: process.env.CHAIN_ONLY || null, root: getRuntimePaths().zylosDir }));",
      {
        HOME: homeDir,
        ZYLOS_DIR: null,
        HXA_CONNECT_PROXY: null,
        DISCOVERY_ONLY: null,
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      proxy: 'http://canonical-proxy.example:8080',
      discovery: 'fallback',
      chain: null,
      root: zylosDir,
    });
  } finally {
    fs.rmSync(path.dirname(zylosDir), { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('preserves present process environment values, including empty strings', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-empty-home-'));
  const fallbackDir = path.join(homeDir, 'zylos');
  const discoveredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-empty-discovered-'));
  fs.mkdirSync(fallbackDir, { recursive: true });
  fs.writeFileSync(path.join(fallbackDir, '.env'), `ZYLOS_DIR=${discoveredDir}\nHXA_CONNECT_PROXY=from-file\n`);

  try {
    const child = runNode(
      "import { getRuntimePaths, loadZylosEnv } from './src/lib/config-path.js'; loadZylosEnv(); console.log(JSON.stringify({ root: getRuntimePaths().zylosDir, proxy: process.env.HXA_CONNECT_PROXY, zylos: process.env.ZYLOS_DIR }));",
      {
        HOME: homeDir,
        ZYLOS_DIR: '',
        HXA_CONNECT_PROXY: '',
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      root: fallbackDir,
      proxy: '',
      zylos: '',
    });
  } finally {
    fs.rmSync(discoveredDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('derives every runtime path from the selected Zylos directory', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-paths-root-'));
  try {
    const child = runNode(
      "import { getRuntimePaths } from './src/lib/config-path.js'; console.log(JSON.stringify(getRuntimePaths()));",
      { HOME: '/tmp/old-hxa-home', ZYLOS_DIR: zylosDir },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      zylosDir,
      skillDir: path.join(zylosDir, '.claude', 'skills', 'hxa-connect'),
      configPath: path.join(zylosDir, 'components', 'hxa-connect', 'config.json'),
      c4ReceivePath: path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-receive.js'),
      dataDir: path.join(zylosDir, 'components', 'hxa-connect'),
      c4SpoolDir: path.join(zylosDir, 'components', 'hxa-connect', 'c4-spool'),
      dmInboxStatePath: path.join(zylosDir, 'components', 'hxa-connect', 'dm-inbox-state.json'),
      mediaBaseDir: path.join(zylosDir, 'media', 'hxa-connect'),
      assistantResponseDir: path.join(zylosDir, 'components', 'hxa-connect', 'assistant-response-deliveries'),
      logsDir: path.join(zylosDir, 'components', 'hxa-connect', 'logs'),
      errorLogPath: path.join(zylosDir, 'components', 'hxa-connect', 'logs', 'error.log'),
      outLogPath: path.join(zylosDir, 'components', 'hxa-connect', 'logs', 'out.log'),
    });
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('media seam follows a custom ZYLOS_DIR at call time', () => {
  const child = runNode(
    "import { getMediaBaseDir } from './src/lib/media.js'; const first = getMediaBaseDir(); process.env.ZYLOS_DIR = '/tmp/second-hxa-root'; const second = getMediaBaseDir(); console.log(JSON.stringify({ first, second }));",
    { HOME: '/tmp/old-hxa-home', ZYLOS_DIR: '/tmp/first-hxa-root' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    first: '/tmp/first-hxa-root/media/hxa-connect',
    second: '/tmp/second-hxa-root/media/hxa-connect',
  });
});

test('ecosystem config resolves cwd and logs from custom ZYLOS_DIR', () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-ecosystem-root-'));
  try {
    const child = spawnSync(
      process.execPath,
      ['--input-type=commonjs', '-e', "console.log(JSON.stringify(require('./ecosystem.config.cjs').apps[0]))"],
      {
        cwd: ROOT,
        env: { ...process.env, HOME: '/tmp/old-hxa-home', ZYLOS_DIR: zylosDir },
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const app = JSON.parse(child.stdout);
    assert.equal(app.cwd, path.join(zylosDir, '.claude', 'skills', 'hxa-connect'));
    assert.equal(app.error_file, path.join(zylosDir, 'components', 'hxa-connect', 'logs', 'error.log'));
    assert.equal(app.out_file, path.join(zylosDir, 'components', 'hxa-connect', 'logs', 'out.log'));
  } finally {
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('runtime callers consume the shared path seam instead of legacy HOME/zylos paths', () => {
  for (const relativePath of ['src/bot.js', 'src/lib/media.js', 'scripts/cli.js', 'scripts/send.js', 'scripts/stream.js']) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(source, /process\.env\.HOME|os\.homedir|\bHOME\b/,
      `${relativePath} still contains a legacy HOME-derived runtime path`);
    assert.match(source, /getRuntimePaths|getMediaBaseDir/,
      `${relativePath} does not use the shared runtime path seam`);
  }
});
