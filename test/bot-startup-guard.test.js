import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_ENTRY = fileURLToPath(new URL('../src/bot.js', import.meta.url));
const SPAWN_TIMEOUT_MS = 10_000;

/**
 * Spawn the real PM2 entrypoint (src/bot.js) against an isolated ZYLOS_DIR so
 * no developer/runtime .env or config.json can leak into the test. The guard
 * runs before any file access, so the missing-secret case exits without ever
 * touching the filesystem; with the secret set, startup proceeds past the
 * guard and deterministically exits in loadConfig() ("Cannot read config"),
 * because the isolated root has no config.json.
 */
function spawnBot({ env: extraEnv = {}, dropSecret = false } = {}) {
  const isolatedDir = mkdtempSync(path.join(os.tmpdir(), 'hxa-bot-startup-guard-'));
  const env = {
    ...process.env,
    ZYLOS_DIR: isolatedDir,
    ...extraEnv,
  };
  if (dropSecret) delete env.HXA_DM_POLICY_NOTICE_SECRET;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOT_ENTRY], { env, cwd: isolatedDir });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`bot.js did not exit within ${SPAWN_TIMEOUT_MS}ms\nstderr: ${stderr}`));
    }, SPAWN_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('missing HXA_DM_POLICY_NOTICE_SECRET exits loudly before any connection setup', async () => {
  const { code, stderr } = await spawnBot({ dropSecret: true });
  assert.equal(code, 1, `expected exit code 1, stderr:\n${stderr}`);
  assert.match(stderr, /HXA_DM_POLICY_NOTICE_SECRET is required/);
  assert.match(stderr, /\.env/, 'error must point at the .env configuration location');
  assert.match(stderr, /pm2 restart/, 'error must include the restart remediation step');
});

test('blank HXA_DM_POLICY_NOTICE_SECRET is rejected the same as a missing one', async () => {
  const { code, stderr } = await spawnBot({
    env: { HXA_DM_POLICY_NOTICE_SECRET: '   ' },
  });
  assert.equal(code, 1, `expected exit code 1, stderr:\n${stderr}`);
  assert.match(stderr, /HXA_DM_POLICY_NOTICE_SECRET is required/);
});

test('set HXA_DM_POLICY_NOTICE_SECRET passes the guard and startup proceeds to config loading', async () => {
  const { code, stderr } = await spawnBot({
    env: { HXA_DM_POLICY_NOTICE_SECRET: 'startup-guard-test-secret' },
  });
  // The isolated ZYLOS_DIR has no config.json, so a successful guard is
  // observable as startup reaching loadConfig() and failing there instead.
  assert.match(stderr, /Cannot read config at/);
  assert.doesNotMatch(stderr, /HXA_DM_POLICY_NOTICE_SECRET is required/);
  assert.equal(code, 1, 'startup should stop at the (expected) missing-config error in isolation');
});
