/**
 * Persistent catch-up state for zylos-hxa-connect.
 *
 * Two kinds of progress per org:
 *
 *   1. Event-stream progress (the hub's catchup_events feed):
 *        eventsSince  — boundary for `client.catchup({since})`
 *        eventCursor  — resume cursor while a page budget ran out
 *      `eventsSince` only moves once the feed is drained AND every message scan
 *      for the batch finished AND no delivery failed.
 *
 *   2. Message-scan progress, one record per channel / thread:
 *        doneUpTo   — everything with created_at < doneUpTo is handled
 *        hi         — end of the range this scan covers
 *        windows    — inclusive [lo, hi] windows still to fetch, oldest first
 *        ids        — [id, created_at] pairs delivered inside those windows
 *      A scan always walks oldest-first and `doneUpTo` only moves forward, so a
 *      run that exhausts its page budget resumes from the saved windows instead
 *      of rescanning. Ids are pruned once they fall below the open window, and
 *      never pruned while their window is still open (that was the旧 bug).
 *
 * Plus, per org:
 *   dirty        — a gap may exist (startup, disconnect, unfinished run)
 *   gapEpoch     — bumped every time a gap appears; a run may only clear `dirty`
 *                  if the epoch it started with is still current, so a
 *                  disconnect during a slow run is not swallowed
 *   recentIds    — bounded ring of recently delivered ids (live traffic), used
 *                  only as an extra safety net against re-delivery
 *
 * Writes are atomic (tmp + fsync + rename, mode 0600). v1/v2 files are upgraded
 * transparently on load.
 */

import fs from 'fs';
import path from 'path';

export const CATCHUP_STATE_VERSION = 3;
export const DEFAULT_MAX_RECENT_IDS = 5000;
/** Retention for the "already delivered" buckets (must exceed the replay window). */
export const DEFAULT_RETAIN_DELIVERED_MS = 48 * 60 * 60 * 1000;
/** Bucket width for the delivered-id index. */
export const DELIVERED_BUCKET_MS = 10 * 60 * 1000;
/** Safety valve for one target's open-window id list. */
export const MAX_WINDOW_IDS = 50000;

export const CATCHUP_STATE_FILENAME = 'catchup-state.json';

export function resolveCatchupStatePath({ home = process.env.HOME } = {}) {
  if (!home) throw new Error('HOME is not set — cannot resolve catchup state path');
  return path.join(home, 'zylos/components/hxa-connect', CATCHUP_STATE_FILENAME);
}

function emptyOrg() {
  return {
    eventsSince: 0,
    eventCursor: null,
    gapEpoch: 0,
    dirty: false,
    lastDeliveredAt: 0,
    lastRememberedAt: 0,
    recentIds: [],
    // id buckets keyed by DELIVERY-time slice: `{ "<ms>": ["id", ...] }`
    delivered: {},
    targets: {},
  };
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0]) {
      out.push([entry[0], toPositiveInt(entry[1])]);
    } else if (typeof entry === 'string' && entry) {
      // legacy / defensive
      out.push([entry, 0]);
    }
  }
  return out;
}

function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const doneUpTo = toPositiveInt(raw.doneUpTo);
  const hi = toPositiveInt(raw.hi);
  const windows = Array.isArray(raw.windows)
    ? raw.windows
      .filter(w => Array.isArray(w) && w.length === 2)
      .map(w => [toPositiveInt(w[0]), toPositiveInt(w[1])])
      .filter(([lo, h]) => lo > 0 && h >= lo)
      .sort((a, b) => a[0] - b[0])
    : [];
  if (!doneUpTo && !hi && !windows.length) return null;
  return {
    doneUpTo,
    hi: Math.max(hi, doneUpTo),
    windows,
    ids: normalizeIds(raw.ids).slice(-MAX_WINDOW_IDS),
    // Cursor inside a "flooded instant" (more messages at one millisecond than
    // a page can return). The hub's id-cursor walks strictly below this row.
    anchorId: typeof raw.anchorId === 'string' && raw.anchorId ? raw.anchorId : null,
    anchorAt: toPositiveInt(raw.anchorAt),
    // Set when the window must be enumerated with the hub's id cursor instead
    // of the timestamp query (an instant holds more rows than one page, so the
    // timestamp query can never return them all).
    byId: raw.byId === true,
  };
}

function normalizeOrg(raw, maxRecentIds) {
  const org = emptyOrg();
  if (!raw || typeof raw !== 'object') return org;

  org.eventsSince = toPositiveInt(raw.eventsSince ?? raw.watermark);
  org.eventCursor = typeof raw.eventCursor === 'string' && raw.eventCursor ? raw.eventCursor : null;
  org.gapEpoch = Number.isFinite(Number(raw.gapEpoch)) ? Math.max(0, Math.floor(Number(raw.gapEpoch))) : 0;
  org.dirty = raw.dirty === true;
  org.lastDeliveredAt = toPositiveInt(raw.lastDeliveredAt);
  org.lastRememberedAt = toPositiveInt(raw.lastRememberedAt);

  if (Array.isArray(raw.recentIds)) {
    org.recentIds = raw.recentIds.filter(id => typeof id === 'string' && id).slice(-maxRecentIds);
  }
  if (raw.delivered && typeof raw.delivered === 'object') {
    for (const [key, ids] of Object.entries(raw.delivered)) {
      if (!Number.isFinite(Number(key)) || !Array.isArray(ids)) continue;
      const clean = ids.filter(id => typeof id === 'string' && id);
      if (clean.length) org.delivered[key] = clean;
    }
  }
  if (raw.targets && typeof raw.targets === 'object') {
    for (const [key, value] of Object.entries(raw.targets)) {
      const t = normalizeTarget(value);
      if (t) org.targets[key] = t;
    }
  }
  // v1/v2 only had a watermark: trust it as the event boundary but re-verify.
  if (raw.watermark !== undefined && raw.eventsSince === undefined) org.dirty = true;
  return org;
}

export class CatchupStateStore {
  constructor({
    filePath,
    maxRecentIds = DEFAULT_MAX_RECENT_IDS,
    retainDeliveredMs = DEFAULT_RETAIN_DELIVERED_MS,
    log = () => {},
  } = {}) {
    if (!filePath) throw new Error('CatchupStateStore requires filePath');
    this.filePath = filePath;
    this.maxRecentIds = maxRecentIds;
    this.retainDeliveredMs = retainDeliveredMs;
    this.log = log;
    this.data = { version: CATCHUP_STATE_VERSION, orgs: {} };
    this.loaded = false;
    this._saveTimer = null;
    this._targetIdSets = new Map();
  }

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
      this._targetIdSets.clear();
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

  // ── Event stream progress ─────────────────────────────────

  getEventsSince(label) {
    return this.getOrg(label).eventsSince || 0;
  }

  setEventsSince(label, ts) {
    const value = toPositiveInt(ts);
    if (!value) return;
    const org = this.getOrg(label);
    if (value > org.eventsSince) org.eventsSince = value;
  }

  getEventCursor(label) {
    return this.getOrg(label).eventCursor;
  }

  setEventCursor(label, cursor) {
    this.getOrg(label).eventCursor = typeof cursor === 'string' && cursor ? cursor : null;
  }

  // ── Gap tracking ─────────────────────────────────────────

  isDirty(label) {
    return this.getOrg(label).dirty === true;
  }

  getGapEpoch(label) {
    return this.getOrg(label).gapEpoch || 0;
  }

  /** Record a possible gap. Bumps the epoch so a stale in-flight run can't clear it. */
  markGap(label) {
    const org = this.getOrg(label);
    org.dirty = true;
    org.gapEpoch = (org.gapEpoch || 0) + 1;
    return org.gapEpoch;
  }

  /** Close the gap only if nothing new appeared since `epoch`. */
  settleGap(label, epoch) {
    const org = this.getOrg(label);
    if ((org.gapEpoch || 0) !== (epoch || 0)) return false;
    org.dirty = false;
    return true;
  }

  // ── Delivery bookkeeping (live traffic) ──────────────────

  getLastDeliveredAt(label) {
    return this.getOrg(label).lastDeliveredAt || 0;
  }

  setLastDeliveredAt(label, ts) {
    const value = toPositiveInt(ts);
    if (!value) return;
    const org = this.getOrg(label);
    if (value > org.lastDeliveredAt) org.lastDeliveredAt = value;
  }

  hasSeen(label, id) {
    if (!id) return false;
    const org = this.getOrg(label);
    if (org.recentIds.includes(id)) return true;
    if (org.delivered) {
      for (const bucket of Object.values(org.delivered)) {
        if (bucket.includes(id)) return true;
      }
    }
    for (const [key, target] of Object.entries(org.targets)) {
      const set = this._idSet(label, key, target);
      if (set.has(id)) return true;
    }
    return false;
  }

  /**
   * Remember delivered ids.
   *
   * Two records, on purpose:
   *   - `recentIds`: a bounded ring, the hot cache for the common case;
   *   - `delivered`: ids bucketed by when they were DELIVERED, kept for
   *     `retainDeliveredMs`. A ring alone is not enough: a backlog can be
   *     thousands of messages long and the replay re-queries the same window
   *     after the boundary moved, so dropping the oldest ring entries makes
   *     the walk deliver them again.
   *
   * Bucketing by delivery time (not by `message.created_at`) is the whole
   * point: an offline backlog older than the retention window is still
   * delivered "now", and pruning by message age deleted the record of exactly
   * those messages the moment the run settled, so the next summary re-scanned
   * all history and replayed them (round-3 review blocker 2).
   *
   * `at` is kept in the signature for callers that want the message timestamp
   * in the target record; the bucket always uses the wall clock.
   */
  remember(label, ids, at) {
    const list = Array.isArray(ids) ? ids : [ids];
    const org = this.getOrg(label);
    org.delivered ||= {};
    const deliveredAt = Date.now();
    const bucketKey = String(Math.floor(deliveredAt / DELIVERED_BUCKET_MS) * DELIVERED_BUCKET_MS);
    const bucket = org.delivered[bucketKey] ||= [];
    for (const id of list) {
      if (typeof id !== 'string' || !id) continue;
      const idx = org.recentIds.indexOf(id);
      if (idx !== -1) org.recentIds.splice(idx, 1);
      org.recentIds.push(id);
      if (!bucket.includes(id)) bucket.push(id);
    }
    if (org.recentIds.length > this.maxRecentIds) {
      org.recentIds = org.recentIds.slice(-this.maxRecentIds);
    }
    // Keep the "remembered at" stamp for callers that pass one; it is not what
    // the retention window is measured against.
    if (at) org.lastRememberedAt = Math.max(org.lastRememberedAt || 0, toPositiveInt(at) || 0);
  }

  /** Drop delivery buckets older than the retention window (delivery time). */
  pruneDelivered(label, now = Date.now()) {
    const org = this.getOrg(label);
    if (!org.delivered) return;
    const floor = Math.floor((now - this.retainDeliveredMs) / DELIVERED_BUCKET_MS) * DELIVERED_BUCKET_MS;
    for (const key of Object.keys(org.delivered)) {
      if (Number(key) < floor) delete org.delivered[key];
    }
  }

  // ── Per-target scan progress ─────────────────────────────

  static targetKey(kind, id) {
    return `${kind === 'thread' ? 'thread' : 'channel'}:${id}`;
  }

  _idSet(label, key, target) {
    const mapKey = `${label}\u0000${key}`;
    let set = this._targetIdSets.get(mapKey);
    if (!set || set.size !== target.ids.length) {
      set = new Set(target.ids.map(([id]) => id));
      this._targetIdSets.set(mapKey, set);
    }
    return set;
  }

  getTarget(label, kind, id) {
    return this.getOrg(label).targets[CatchupStateStore.targetKey(kind, id)] || null;
  }

  /** All target keys with unfinished work, oldest pending window first. */
  openTargets(label) {
    const org = this.getOrg(label);
    return Object.entries(org.targets)
      .filter(([, t]) => t.windows.length > 0)
      .map(([key, t]) => ({
        kind: key.startsWith('thread:') ? 'thread' : 'channel',
        id: key.slice(key.indexOf(':') + 1),
        target: t,
      }))
      .sort((a, b) => (a.target.windows[0]?.[0] ?? a.target.doneUpTo)
        - (b.target.windows[0]?.[0] ?? b.target.doneUpTo));
  }

  /**
   * Open or extend a scan for one channel/thread so it covers `[doneUpTo, hi]`.
   * Existing unfinished windows are kept (that is the resume point).
   */
  extendTarget(label, kind, id, hi) {
    const org = this.getOrg(label);
    const key = CatchupStateStore.targetKey(kind, id);
    const end = toPositiveInt(hi);
    let t = org.targets[key];
    if (!t) {
      t = { doneUpTo: 0, hi: 0, windows: [], ids: [], anchorId: null, anchorAt: 0 };
      org.targets[key] = t;
    }
    const grew = end > t.hi;
    if (grew) t.hi = end;
    if (t.windows.length === 0) {
      if (t.hi > t.doneUpTo) {
        t.windows = [[t.doneUpTo + 1, t.hi]];
        t.ids = [];
        t.anchorId = null;
        t.anchorAt = 0;
        t.byId = false;
        this._invalidate(label, key);
      }
    } else if (grew) {
      // A previous run stopped mid-scan and now more messages arrived. The
      // pending windows only cover the OLD high-water mark; extending `hi`
      // without extending them would let commitWindow() declare the new range
      // done although it was never queried (round-3 review blocker 3).
      const top = t.windows.reduce((max, w) => Math.max(max, w[1]), 0);
      if (t.hi > top) t.windows.push([top + 1, t.hi]);
    }
    return t;
  }

  /**
   * The oldest pending window was partially read from its TOP (the hub returns
   * the newest rows first). Keep the unread lower part `[lo, newHi]`.
   * `newHi >= lo` required, otherwise use `commitWindow`.
   */
  shrinkWindowTop(label, kind, id, newHi) {
    const org = this.getOrg(label);
    const key = CatchupStateStore.targetKey(kind, id);
    const t = org.targets[key];
    if (!t || t.windows.length === 0) return;
    const [lo, hi] = t.windows[0];
    const top = Math.min(toPositiveInt(newHi), hi);
    if (top < lo) return;
    t.windows[0] = [lo, top];
    // `t.hi` stays the high-water mark of the whole scan: the bytes above `top`
    // were already delivered, and once the lower part is read the scan is done
    // through `t.hi` (see commitWindow).
    // Ids above the new top can never be re-queried.
    t.ids = t.ids.filter(([, at]) => at === 0 || at <= top).slice(-MAX_WINDOW_IDS);
    this._invalidate(label, key);
  }

  /**
   * Remember where to resume inside an instant that holds more messages than a
   * page can return. `id` must be a message already delivered.
   */
  setAnchor(label, kind, id, anchorId, anchorAt) {
    const t = this.getTarget(label, kind, id);
    if (!t) return;
    t.anchorId = anchorId || null;
    t.anchorAt = toPositiveInt(anchorAt);
  }

  clearAnchor(label, kind, id) {
    const t = this.getTarget(label, kind, id);
    if (!t) return;
    t.anchorId = null;
    t.anchorAt = 0;
  }

  /**
   * Switch this target's pending window to the hub's id cursor. `anchorId`
   * stays null for the first page (start at the newest row of the channel);
   * after that it is the id of the oldest row we consumed.
   */
  useIdScan(label, kind, id, anchorId = null, anchorAt = 0) {
    const t = this.getTarget(label, kind, id);
    if (!t) return;
    t.byId = true;
    t.anchorId = anchorId || null;
    t.anchorAt = toPositiveInt(anchorAt);
  }

  isIdScan(label, kind, id) {
    return this.getTarget(label, kind, id)?.byId === true;
  }

  /** Leave id-cursor mode and go back to the timestamp query. */
  endIdScan(label, kind, id) {
    const t = this.getTarget(label, kind, id);
    if (!t) return;
    t.byId = false;
    t.anchorId = null;
    t.anchorAt = 0;
  }

  /**
   * The oldest pending window was fully read. When it was the last one, the
   * whole scan is done up to `t.hi` (the high-water mark): every page above the
   * shrinking windows was delivered on the way down.
   */
  commitWindow(label, kind, id) {
    const org = this.getOrg(label);
    const key = CatchupStateStore.targetKey(kind, id);
    const t = org.targets[key];
    if (!t || t.windows.length === 0) return;
    const [, hi] = t.windows.shift();
    t.anchorId = null;
    t.anchorAt = 0;
    if (t.windows.length === 0) {
      // The scan is done through the last window's top, never further: `hi` is
      // only the high-water mark, and a window list that does not reach it
      // means the newest slice was never queried.
      const reached = hi > t.doneUpTo ? hi : t.doneUpTo;
      t.doneUpTo = reached;
      if (t.hi > reached) {
        // Keep the uncovered tail open instead of declaring it done.
        t.windows = [[reached + 1, t.hi]];
        t.ids = [];
        t.byId = false;
      } else {
        t.ids = [];
        t.byId = false;
      }
    } else {
      if (hi > t.doneUpTo) t.doneUpTo = hi;
      const bottom = Math.min(...t.windows.map(w => w[0]));
      t.ids = t.ids.filter(([, at]) => at === 0 || at >= bottom).slice(-MAX_WINDOW_IDS);
    }
    this._invalidate(label, key);
  }

  /** Record a delivered message inside the target's open window. */
  addTargetId(label, kind, id, messageId, at) {
    if (!messageId) return;
    const org = this.getOrg(label);
    const key = CatchupStateStore.targetKey(kind, id);
    const t = org.targets[key];
    if (!t || t.windows.length === 0) return; // nothing open → nothing to dedupe
    const set = this._idSet(label, key, t);
    if (set.has(messageId)) return;
    t.ids.push([messageId, toPositiveInt(at)]);
    if (t.ids.length > MAX_WINDOW_IDS) t.ids.splice(0, t.ids.length - MAX_WINDOW_IDS);
    this._idSet(label, key, t).add(messageId);
  }

  /** True when no target still has a pending window. */
  targetsSettled(label) {
    const org = this.getOrg(label);
    for (const t of Object.values(org.targets)) {
      if (t.windows.length > 0) return false;
    }
    return true;
  }

  /** Drop finished target records. */
  pruneTargets(label) {
    const org = this.getOrg(label);
    for (const [key, t] of Object.entries(org.targets)) {
      if (t.windows.length === 0) {
        delete org.targets[key];
        this._invalidate(label, key);
      }
    }
  }

  _invalidate(label, key) {
    this._targetIdSets.delete(`${label}\u0000${key}`);
  }

  // ── Persistence ──────────────────────────────────────────

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
