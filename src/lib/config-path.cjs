/**
 * Canonical runtime path and .env resolver.
 *
 * A non-empty ZYLOS_DIR selects the canonical `${ZYLOS_DIR}/.env`. A present
 * but empty ZYLOS_DIR is preserved as an explicit process value, while path
 * selection treats it as unset and uses the fallback. When the process does
 * not provide a non-empty ZYLOS_DIR, HOME/zylos/.env is read once as a
 * compatibility discovery file; if it supplies ZYLOS_DIR, that directory's
 * .env is then read. We deliberately stop after that second file so a chain
 * of .env files cannot recursively move the runtime root.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function getFallbackZylosDir(env = process.env) {
  return path.resolve(getHomeDir(env), 'zylos');
}

function getConfiguredZylosDir(env = process.env) {
  const configuredRoot = nonEmpty(env.ZYLOS_DIR);
  return configuredRoot ? path.resolve(configuredRoot) : null;
}

function getZylosEnvPath(env = process.env) {
  return path.join(getConfiguredZylosDir(env) || getFallbackZylosDir(env), '.env');
}

function unescapeDoubleQuoted(value) {
  return value.replace(/\\([\\"'nrt])/g, (match, escaped) => {
    switch (escaped) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return escaped;
    }
  });
}

/**
 * Parse the small dotenv subset needed by the component: KEY=value, quoted
 * values, and CRLF line endings. Shell expansion and recursive dotenv loading
 * are intentionally not supported.
 */
function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (value.length < 2 || !['"', "'"].includes(value[0])) return value;

  const quote = value[0];
  let closingIndex = -1;
  for (let index = 1; index < value.length; index++) {
    if (value[index] !== quote || value[index - 1] === '\\') continue;
    closingIndex = index;
    break;
  }
  if (closingIndex === -1) return value;

  const trailing = value.slice(closingIndex + 1).trim();
  if (trailing && !trailing.startsWith('#')) return value;

  const unquoted = value.slice(1, closingIndex);
  return quote === '"' ? unescapeDoubleQuoted(unquoted) : unquoted.replace(/\\'/g, "'");
}

function loadEnvFile(envPath, target = process.env) {
  if (!fs.existsSync(envPath)) return;

  // split handles both LF and CRLF without leaving a carriage return in keys.
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = parseEnvValue(trimmed.slice(eqIdx + 1));

    // Presence, rather than truthiness, is the override contract. An empty
    // process value is explicit and must not be replaced by the .env file.
    if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = value;
  }
}

function loadZylosEnv() {
  const explicitRoot = getConfiguredZylosDir(process.env);
  const discoveryPath = explicitRoot
    ? null
    : path.join(getFallbackZylosDir(process.env), '.env');

  if (discoveryPath) loadEnvFile(discoveryPath);

  // If discovery populated ZYLOS_DIR, load exactly that directory's canonical
  // .env. No further file is followed during this invocation.
  const canonicalPath = getZylosEnvPath(process.env);
  if (canonicalPath !== discoveryPath) loadEnvFile(canonicalPath);

  return process.env;
}

function getZylosDir() {
  loadZylosEnv();
  return getConfiguredZylosDir(process.env) || getFallbackZylosDir(process.env);
}

function buildRuntimePaths(zylosDir) {
  const skillDir = path.join(zylosDir, '.claude', 'skills', 'hxa-connect');
  const dataDir = path.join(zylosDir, 'components', 'hxa-connect');
  const logsDir = path.join(dataDir, 'logs');

  return {
    zylosDir,
    skillDir,
    configPath: path.join(dataDir, 'config.json'),
    c4ReceivePath: path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-receive.js'),
    dataDir,
    c4SpoolDir: path.join(dataDir, 'c4-spool'),
    dmInboxStatePath: path.join(dataDir, 'dm-inbox-state.json'),
    dmPolicyRejectionDir: path.join(dataDir, 'dm-policy-rejections'),
    mediaBaseDir: path.join(zylosDir, 'media', 'hxa-connect'),
    assistantResponseDir: path.join(dataDir, 'assistant-response-deliveries'),
    logsDir,
    errorLogPath: path.join(logsDir, 'error.log'),
    outLogPath: path.join(logsDir, 'out.log'),
  };
}

function getRuntimePaths() {
  return buildRuntimePaths(getZylosDir());
}

function getConfigPath() {
  return getRuntimePaths().configPath;
}

module.exports = {
  getConfigPath,
  getHomeDir,
  getRuntimePaths,
  getZylosDir,
  getZylosEnvPath,
  loadZylosEnv,
};
