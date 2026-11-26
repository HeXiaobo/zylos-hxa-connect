import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redact.js';

const SCHEMA_VERSION = 1;

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, orgs: {} };
}

async function writeAtomic(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(tempPath, filePath);
}

export class DmInboxState {
  constructor({
    filePath,
    overlapMs = 5 * 60_000,
    initialLookbackMs = 5 * 60_000,
    seenRetentionMs = 24 * 60 * 60_000,
    maxSeenPerOrg = 10_000,
    clock = () => Date.now(),
  }) {
    this.filePath = filePath;
    this.overlapMs = overlapMs;
    this.initialLookbackMs = initialLookbackMs;
    this.seenRetentionMs = seenRetentionMs;
    this.maxSeenPerOrg = maxSeenPerOrg;
    this.clock = clock;
    this.state = emptyState();
    this.loaded = false;
    this.persistChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
      if (parsed?.schemaVersion === SCHEMA_VERSION && parsed.orgs && typeof parsed.orgs === 'object') {
        this.state = parsed;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const corruptPath = `${this.filePath}.corrupt.${this.clock()}`;
        await fs.promises.rename(this.filePath, corruptPath).catch(() => {});
      }
    }
    this.loaded = true;
  }

  #org(label) {
    this.state.orgs[label] ??= { lastSuccessfulScanAt: 0, seen: {}, suppressed: {} };
    this.state.orgs[label].seen ??= {};
    this.state.orgs[label].suppressed ??= {};
    return this.state.orgs[label];
  }

  getLastSuccessfulScanAt(label) {
    const value = this.#org(label).lastSuccessfulScanAt;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  since(label, now = this.clock()) {
    const org = this.#org(label);
    const anchor = Number.isFinite(org.lastSuccessfulScanAt) && org.lastSuccessfulScanAt > 0
      ? org.lastSuccessfulScanAt
      : now - this.initialLookbackMs;
    return Math.max(0, anchor - this.overlapMs);
  }

  hasSeen(label, id) {
    const org = this.#org(label);
    return Object.hasOwn(org.seen, id) || Object.hasOwn(org.suppressed, id);
  }

  isSuppressed(label, id) {
    return Object.hasOwn(this.#org(label).suppressed, id);
  }

  getSuppressedRecord(label, id) {
    const entry = this.#org(label).suppressed[id];
    return entry && typeof entry === 'object' ? entry : null;
  }

  async markSeen(label, message) {
    if (!message || typeof message.id !== 'string' || message.id.length === 0) {
      throw new TypeError('message.id is required');
    }
    const org = this.#org(label);
    org.seen[message.id] = Number.isFinite(message.created_at) ? message.created_at : this.clock();
    this.#prune(org);
    await this.#persist();
  }

  async markSuppressed(label, message, { reason = 'stale_cutoff' } = {}) {
    if (!message || typeof message.id !== 'string' || message.id.length === 0) {
      throw new TypeError('message.id is required');
    }
    const org = this.#org(label);
    const createdAt = Number(message.created_at);
    org.suppressed[message.id] = {
      at: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : 0,
      status: 'not_delivered',
      reason: typeof reason === 'string' && reason ? reason : 'stale_cutoff',
      recordedAt: this.clock(),
    };
    this.#prune(org);
    await this.#persist();
  }

  async markScan(label, scannedThrough) {
    const org = this.#org(label);
    org.lastSuccessfulScanAt = Math.max(0, Math.floor(scannedThrough));
    this.#prune(org);
    await this.#persist();
  }

  #prune(org) {
    const cutoff = this.clock() - this.seenRetentionMs;
    const entries = Object.entries(org.seen)
      .filter(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxSeenPerOrg);
    org.seen = Object.fromEntries(entries);
    const suppressedEntries = Object.entries(org.suppressed || {})
      .filter(([, entry]) => entry && typeof entry === 'object' && Number.isFinite(entry.recordedAt) && entry.recordedAt >= cutoff)
      .sort((a, b) => b[1].recordedAt - a[1].recordedAt)
      .slice(0, this.maxSeenPerOrg);
    org.suppressed = Object.fromEntries(suppressedEntries);
  }

  #persist() {
    this.persistChain = this.persistChain
      .catch(() => {})
      .then(() => writeAtomic(this.filePath, this.state));
    return this.persistChain;
  }
}

/**
 * Periodically compares the Hub's authoritative DM inbox with WebSocket intake.
 * A DM missed by an otherwise healthy WebSocket is replayed through the same
 * idempotent C4 delivery path on the next poll.
 */
export class DmInboxReconciler {
  constructor({
    label,
    client,
    state,
    processMessage,
    intervalMs = 15_000,
    clock = () => Date.now(),
    logger = console,
    processStartedAt,
    maxAgeMs = Infinity,
  }) {
    this.label = label;
    this.client = client;
    this.state = state;
    this.processMessage = processMessage;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.logger = logger;
    const resolvedStart = Number(processStartedAt);
    this.processStartedAt = Number.isFinite(resolvedStart) && resolvedStart > 0
      ? Math.floor(resolvedStart)
      : this.clock();
    this.maxAgeMs = typeof maxAgeMs === 'number'
      && (Number.isFinite(maxAgeMs) || maxAgeMs === Infinity)
      && maxAgeMs >= 0
      ? maxAgeMs
      : Infinity;
    this.timer = null;
    this.running = false;
    this.stopped = true;
  }

  async start() {
    await this.state.load();
    this.stopped = false;
    await this.pollOnce();
    this.#schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async observeLive(message) {
    if (!message?.id || this.state.hasSeen(this.label, message.id)) {
      return { action: 'duplicate' };
    }
    const result = await this.processMessage(message, 'websocket');
    if (result?.action === 'accepted' || result?.action === 'discarded') {
      await this.state.markSeen(this.label, message);
    }
    return result;
  }

  async pollOnce() {
    if (this.running) return { action: 'already_running' };
    this.running = true;
    const startedAt = this.clock();
    const cutoffAt = Number.isFinite(this.maxAgeMs) ? (this.processStartedAt - this.maxAgeMs) : -Infinity;
    const lastScanAt = this.state.getLastSuccessfulScanAt(this.label);

    if (Number.isFinite(cutoffAt) && (lastScanAt <= 0 || lastScanAt < cutoffAt)) {
      const reason = lastScanAt <= 0 ? 'baseline' : 'stale_cursor';
      try {
        await this.state.markScan(this.label, startedAt);
        this.logger.warn(
          `[hxa-connect:${this.label}] DM inbox reconciliation ${reason}: ` +
          `lastScanAt=${lastScanAt ? new Date(lastScanAt).toISOString() : 'none'}, ` +
          `cutoff=${new Date(cutoffAt).toISOString()}; advancing scan cursor to ${new Date(startedAt).toISOString()} without replaying history`,
        );
        return { action: `skipped_${reason}`, previousScanAt: lastScanAt, since: startedAt, recovered: 0, suppressed: 0, count: 0 };
      } catch (error) {
        this.logger.warn(`[hxa-connect:${this.label}] DM inbox reconciliation failed: ${redactSecrets(error.message)}`);
        return { action: 'failed', error };
      } finally {
        this.running = false;
      }
    }

    const since = this.state.since(this.label, startedAt);
    // Keep overlapMs window available for in-flight / rate-limited retries
    // (whose scanThrough advances by overlapMs - 1), while still enforcing
    // both the scan lower bound (`since`) and the process staleness `cutoffAt`.
    const deliveryFloor = Number.isFinite(cutoffAt) ? Math.max(since, cutoffAt) : 0;
    let unresolvedCreatedAt = null;
    try {
      const messages = await this.client.inbox(since);
      if (!Array.isArray(messages)) throw new TypeError('Hub inbox response must be an array');
      messages.sort((a, b) => (a.created_at - b.created_at) || String(a.id).localeCompare(String(b.id)));
      let recovered = 0;
      let suppressed = 0;
      for (const message of messages) {
        if (!message?.id || this.state.hasSeen(this.label, message.id)) continue;
        if (Number.isFinite(cutoffAt)) {
          const msgAt = Number(message.created_at) || 0;
          if (msgAt <= 0 || msgAt < deliveryFloor) {
            const reason = msgAt <= 0
              ? 'invalid_timestamp'
              : (msgAt < cutoffAt ? 'stale_cutoff' : 'before_cursor');
            await this.state.markSuppressed(this.label, message, { reason });
            suppressed += 1;
            continue;
          }
        }
        const result = await this.processMessage(message, 'inbox');
        if (result?.action === 'accepted' || result?.action === 'discarded') {
          await this.state.markSeen(this.label, message);
          recovered += result.action === 'accepted' ? 1 : 0;
        } else {
          const createdAt = Number.isFinite(message.created_at) ? message.created_at : since;
          unresolvedCreatedAt = unresolvedCreatedAt === null
            ? createdAt
            : Math.min(unresolvedCreatedAt, createdAt);
        }
      }
      const scanThrough = unresolvedCreatedAt === null
        ? startedAt
        : Math.min(startedAt, unresolvedCreatedAt + this.state.overlapMs - 1);
      await this.state.markScan(this.label, scanThrough);
      if (suppressed > 0) {
        this.logger.warn(
          `[hxa-connect:${this.label}] DM inbox reconciliation suppressed ${suppressed} non-deliverable message(s) ` +
          `(deliveryFloor=${new Date(deliveryFloor).toISOString()}, persisted as not_delivered)`,
        );
      }
      if (recovered > 0) {
        this.logger.warn(`[hxa-connect:${this.label}] DM inbox reconciliation recovered ${recovered} missed message(s) since=${since}`);
      }
      return { action: 'polled', recovered, suppressed, since, count: messages.length };
    } catch (error) {
      this.logger.warn(`[hxa-connect:${this.label}] DM inbox reconciliation failed: ${redactSecrets(error.message)}`);
      return { action: 'failed', error };
    } finally {
      this.running = false;
    }
  }

  #schedule() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.pollOnce();
      this.#schedule();
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
