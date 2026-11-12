/**
 * Persistent catch-up state for zylos-hxa-connect.
 *
 * One record per org label:
 *   watermark       — boundary for the next catch-up query. Only advanced by a
 *                     *completed* catch-up run, or by realtime delivery while
 *                     the connection is known to be gap-free (`dirty === false`).
 *   lastDeliveredAt — newest message that went through the delivery pipeline
 *                     (informational; also the target watermark after a run).
 *   dirty           — true while a delivery gap may exist (process start,
 *                     disconnect, unfinished replay). While dirty, realtime
 *                     traffic must NOT move the watermark, otherwise messages
 *                     missed during the gap would be skipped forever.
 *   recentIds       — ids of recently handled messages, used to de-duplicate
 *                     replays against messages already delivered in real time.
 *
 * The file is written atomically (tmp file + fsync + rename) with mode 0600 so
 * a crash or power loss can never leave a half-written state file behind.
 */

import fs from 'fs';
import path from 'path';

export const CATCHUP_STATE_VERSION = 2;
export const DEFAULT_MAX_RECENT_IDS = 2000;

export const CATCHUP_STATE_FILENAME = 'catchup-state.json';

/**
 * Default location: <home>/zylos/components/hxa-connect/catchup-state.json
 * (component data dir — same directory as config.json).
 */
export function resolveCatchupStatePath({ home = process.env.HOME } = {}) {
  if (!home) throw new Error('HOME is not set — cannot resolve catchup state path');
  return path.join(home, 'zylos/components/hxa-connect', CATCHUP_STATE_FILENAME);
}

function emptyOrg() {
  return { watermark: 0, lastDeliveredAt: 0, dirty: false, recentIds: [] };
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeOrg(raw, maxRecentIds) {
  const org = emptyOrg();
  if (!raw || typeof raw !== 'object') return org;

  org.watermark = toPositiveInt(raw.watermark);
  org.lastDeliveredAt = toPositiveInt(raw.lastDeliveredAt);
  // v1 files only had lastDeliveredAt: treat it as the watermark and mark the
  // org dirty so the first run re-checks the window instead of trusting it.
  if (!org.watermark && org.lastDeliveredAt) {
    org.watermark = org.lastDeliveredAt;
    org.dirty = true;
  }
  org.dirty = raw.dirty === true;
  org.dirtyRevision = toPositiveInt(raw.dirtyRevision);
  if (Array.isArray(raw.recentIds)) {
    const ids = raw.recentIds.filter(id => typeof id === 'string' && id.length > 0);
    org.recentIds = org.dirty ? ids : ids.slice(-maxRecentIds);
  }
  if (raw.scan && typeof raw.scan === 'object') org.scan = raw.scan;
  return org;
}

export class CatchupStateStore {
  constructor({ filePath, maxRecentIds = DEFAULT_MAX_RECENT_IDS, log = () => {} } = {}) {
    if (!filePath) throw new Error('CatchupStateStore requires filePath');
    this.filePath = filePath;
    this.maxRecentIds = maxRecentIds;
    this.log = log;
    this.data = { version: CATCHUP_STATE_VERSION, orgs: {} };
    this.loaded = false;
    this._saveTimer = null;
  }

  /**
   * Read the state file. Missing file = fresh state. Corrupt file = fresh
   * state plus a warning (never crash the bot over bookkeeping).
   */
  load() {
    this.loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`catchup state read failed (${err.message})`);
      return this;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.orgs || typeof parsed.orgs !== 'object') {
        this.log('catchup state has an unexpected shape — starting from empty state');
        return this;
      }
      this.data = { version: CATCHUP_STATE_VERSION, orgs: {} };
      for (const [label, org] of Object.entries(parsed.orgs)) {
        this.data.orgs[label] = normalizeOrg(org, this.maxRecentIds);
      }
    } catch (err) {
      this.log(`catchup state is not valid JSON (${err.message}) — starting from empty state`);
    }
    return this;
  }

  ensureLoaded() {
    if (!this.loaded) this.load();
    return this;
  }

  getOrg(label) {
    if (!this.data.orgs[label]) this.data.orgs[label] = emptyOrg();
    return this.data.orgs[label];
  }

  /** Boundary the next catch-up query starts from (0 = never established). */
  getWatermark(label) {
    return this.getOrg(label).watermark || 0;
  }

  setWatermark(label, ts) {
    const value = toPositiveInt(ts);
    if (!value) return;
    const org = this.getOrg(label);
    if (value > org.watermark) org.watermark = value;
  }

  getLastDeliveredAt(label) {
    return this.getOrg(label).lastDeliveredAt || 0;
  }

  setLastDeliveredAt(label, ts) {
    const value = toPositiveInt(ts);
    if (!value) return;
    const org = this.getOrg(label);
    if (value > org.lastDeliveredAt) org.lastDeliveredAt = value;
  }

  isDirty(label) {
    return this.getOrg(label).dirty === true;
  }

  setDirty(label, value = true) {
    const org = this.getOrg(label);
    org.dirty = value === true;
    if (org.dirty) org.dirtyRevision = (org.dirtyRevision || 0) + 1;
    if (!org.dirty) org.recentIds = org.recentIds.slice(-this.maxRecentIds);
  }

  hasSeen(label, id) {
    if (!id) return false;
    return this.getOrg(label).recentIds.includes(id);
  }

  /** Remember message ids as handled (idempotent, trimmed to maxRecentIds). */
  remember(label, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const org = this.getOrg(label);
    for (const id of list) {
      if (typeof id !== 'string' || !id) continue;
      const idx = org.recentIds.indexOf(id);
      if (idx !== -1) org.recentIds.splice(idx, 1);
      org.recentIds.push(id);
    }
    if (!org.dirty && org.recentIds.length > this.maxRecentIds) {
      org.recentIds = org.recentIds.slice(-this.maxRecentIds);
    }
  }

  /** Atomic write. Returns true on success; logs and returns false on failure. */
  save() {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify(this.data, null, 2) + '\n';
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      this.log(`catchup state write failed (${err.message})`);
      return false;
    }
  }

  /** Debounced save for the hot path (realtime message bookkeeping). */
  scheduleSave(delayMs = 3000) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save();
    }, delayMs);
    this._saveTimer.unref?.();
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    return this.save();
  }
}
