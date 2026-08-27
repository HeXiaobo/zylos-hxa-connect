/**
 * Config loader/saver for zylos-hxa-connect.
 * Used by admin CLI and auth module.
 */

import fs from 'fs';
import { getConfigPath } from './config-path.js';

export { getConfigPath };

export function loadConfig() {
  const configPath = getConfigPath();
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('[hxa-connect] Failed to load config:', err.message);
    process.exit(1);
  }
}

export function saveConfig(config) {
  const configPath = getConfigPath();
  try {
    const tmpPath = configPath + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    console.error('[hxa-connect] Failed to save config:', err.message);
    return false;
  }
}
