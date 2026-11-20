#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath } from '../src/lib/config-path.js';

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.backup.${timestampSuffix()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function atomicWriteJSON(filePath, obj) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

const LOG_PREFIX = '[hxa-connect post-upgrade]';
const configPath = getConfigPath();

if (!fs.existsSync(configPath)) {
  console.log(`${LOG_PREFIX} No config file found, nothing to migrate.`);
  console.log(`${LOG_PREFIX} Complete!`);
  process.exit(0);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const migrations = [];
  let migrated = false;

  // Migration: remove deprecated display_name field
  if (config.display_name !== undefined) {
    delete config.display_name;
    migrations.push('Removed deprecated display_name');
    migrated = true;
  }

  if (migrated) {
    const backupPath = backupConfigFile(configPath);
    if (backupPath) console.log(`${LOG_PREFIX} Backed up config to ${path.basename(backupPath)}`);
    atomicWriteJSON(configPath, config);
    console.log(`${LOG_PREFIX} Config migrated:`);
    migrations.forEach((m) => console.log(`  - ${m}`));
  } else {
    console.log(`${LOG_PREFIX} No migrations needed.`);
  }
} catch (err) {
  console.error(`${LOG_PREFIX} post-upgrade failed:`, err.message);
  process.exit(1);
}

console.log(`${LOG_PREFIX} Complete!`);
