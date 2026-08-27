import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
    this.state.orgs[label] ??= { lastSuccessfulScanAt: 0, seen: {} };
    this.state.orgs[label].seen ??= {};
    return this.state.orgs[label];
  }

  since(label, now = this.clock()) {
    const org = this.#org(label);
    const anchor = Number.isFinite(org.lastSuccessfulScanAt) && org.lastSuccessfulScanAt > 0
      ? org.lastSuccessfulScanAt
      : now - this.initialLookbackMs;
    return Math.max(0, anchor - this.overlapMs);
  }

  hasSeen(label, id) {
    return Object.hasOwn(this.#org(label).seen, id);
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
  }) {
    this.label = label;
    this.client = client;
    this.state = state;
    this.processMessage = processMessage;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.logger = logger;
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
    const since = this.state.since(this.label, startedAt);
    let unresolvedCreatedAt = null;
    try {
      const messages = await this.client.inbox(since);
      if (!Array.isArray(messages)) throw new TypeError('Hub inbox response must be an array');
      messages.sort((a, b) => (a.created_at - b.created_at) || String(a.id).localeCompare(String(b.id)));
      let recovered = 0;
      for (const message of messages) {
        if (!message?.id || this.state.hasSeen(this.label, message.id)) continue;
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
      if (recovered > 0) {
        this.logger.warn(`[hxa-connect:${this.label}] DM inbox reconciliation recovered ${recovered} missed message(s) since=${since}`);
      }
      return { action: 'polled', recovered, since, count: messages.length };
    } catch (error) {
      this.logger.warn(`[hxa-connect:${this.label}] DM inbox reconciliation failed: ${error.message}`);
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
