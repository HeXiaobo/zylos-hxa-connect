/**
 * Resolve the hxa-connect config.json path for the current Zylos directory.
 *
 * A caller may point a runtime at an isolated Zylos directory with ZYLOS_DIR;
 * normal installations continue to use HOME/zylos.
 */
import path from 'node:path';

const ZYLOS_ROOT = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');

export const CONFIG_PATH = path.join(
  ZYLOS_ROOT,
  'components',
  'hxa-connect',
  'config.json',
);
