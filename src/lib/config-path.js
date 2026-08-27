/**
 * Resolve the hxa-connect config.json path for the current Zylos directory.
 *
 * A caller may point a runtime at an isolated Zylos directory with ZYLOS_DIR;
 * normal installations continue to use HOME/zylos.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function nonEmpty(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function getHomeDir(env = process.env) {
  const configuredHome = nonEmpty(env.HOME);
  let fallbackHome = nonEmpty(os.homedir());
  if (!fallbackHome) {
    try {
      fallbackHome = nonEmpty(os.userInfo().homedir);
    } catch {
      fallbackHome = null;
    }
  }
  if (!configuredHome && !fallbackHome) {
    throw new Error('Unable to resolve an absolute home directory');
  }
  return path.resolve(configuredHome || fallbackHome);
}

function getZylosEnvPath(env = process.env) {
  return path.join(getHomeDir(env), 'zylos', '.env');
}

/**
 * Load the installation .env without overriding an explicitly configured
 * process environment. The loader is intentionally callable at runtime so a
 * config path never becomes an import-time snapshot.
 */
export function loadZylosEnv() {
  const envPath = getZylosEnvPath();
  if (!fs.existsSync(envPath)) return process.env;

  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1);
    if (key && !nonEmpty(process.env[key])) process.env[key] = value;
  }

  return process.env;
}

function getZylosDir() {
  loadZylosEnv();
  const configuredRoot = nonEmpty(process.env.ZYLOS_DIR);
  return path.resolve(configuredRoot || path.join(getHomeDir(), 'zylos'));
}

export function getConfigPath() {
  return path.join(
    getZylosDir(),
    'components',
    'hxa-connect',
    'config.json',
  );
}
