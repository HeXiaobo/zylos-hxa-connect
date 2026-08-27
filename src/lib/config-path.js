/**
 * ESM facade for the canonical runtime path resolver.
 *
 * The CommonJS implementation is also consumed by ecosystem.config.cjs, so
 * PM2 and the application use the same .env semantics and path calculations.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimePaths = require('./config-path.cjs');

export const {
  getConfigPath,
  getHomeDir,
  getRuntimePaths,
  getZylosDir,
  getZylosEnvPath,
  loadZylosEnv,
} = runtimePaths;
