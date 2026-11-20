import fs from 'node:fs';
import path from 'node:path';

/**
 * Reports the age of the newest record in a delivery store directory.
 *
 * The assistant-response delivery store writes one JSON file per delivery and
 * uses atomic rename, so the newest file mtime is the last time a delivery was
 * attempted. A store that stops receiving writes is how #26 (streamed-reply
 * delivery silently stopping) first presented, and this check turns that
 * silence into an observable signal at startup.
 */
export function newestDeliveryAgeMs({ directory, clock = () => Date.now() } = {}) {
  if (typeof directory !== 'string' || directory === '') {
    throw new TypeError('delivery store directory is required');
  }
  let newestMtimeMs = null;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { hasRecords: false, newestMtimeMs: null, ageMs: null };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const { mtimeMs } = fs.statSync(path.join(directory, entry.name));
      if (newestMtimeMs === null || mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (newestMtimeMs === null) return { hasRecords: false, newestMtimeMs: null, ageMs: null };
  return { hasRecords: true, newestMtimeMs, ageMs: Math.max(0, clock() - newestMtimeMs) };
}
