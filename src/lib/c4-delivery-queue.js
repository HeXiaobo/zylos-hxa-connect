import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { redactSecrets } from './redact.js';

const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 60_000;

function deliveryFilename(id) {
  return `${createHash('sha256').update(id).digest('hex')}.json`;
}

function requireDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') {
    throw new TypeError('delivery must be an object');
  }
  if (typeof delivery.id !== 'string' || delivery.id.length === 0) {
    throw new TypeError('delivery.id must be a non-empty string');
  }
  if (!Array.isArray(delivery.args) || delivery.args.some(arg => typeof arg !== 'string')) {
    throw new TypeError('delivery.args must be an array of strings');
  }
  return {
    schemaVersion: 1,
    id: delivery.id,
    args: delivery.args,
    preview: typeof delivery.preview === 'string' ? delivery.preview.slice(0, 160) : '',
    enqueuedAt: Number.isFinite(delivery.enqueuedAt) ? delivery.enqueuedAt : Date.now(),
    attempts: Number.isInteger(delivery.attempts) && delivery.attempts >= 0 ? delivery.attempts : 0,
    availableAt: Number.isFinite(delivery.availableAt) ? delivery.availableAt : Date.now(),
    lastError: typeof delivery.lastError === 'string' ? delivery.lastError.slice(0, 500) : null,
  };
}

async function writeAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.promises.rename(tempPath, filePath);
}

function execute(execFileFn, command, args) {
  return new Promise((resolve, reject) => {
    execFileFn(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout ??= stdout;
        error.stderr ??= stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * A small disk-backed queue in front of c4-receive.
 *
 * Hub events are durably spooled before the WebSocket handler returns. A PM2
 * restart, a busy C4 process, or the previous concurrency cap can therefore
 * delay delivery, but cannot silently discard it.
 */
export class C4DeliveryQueue {
  constructor({
    spoolDir,
    c4ReceivePath,
    execFileFn = nodeExecFile,
    concurrency = 4,
    maxEntries = 2_000,
    retryMs = DEFAULT_RETRY_MS,
    maxRetryMs = DEFAULT_MAX_RETRY_MS,
    // How long a delivered id stays "already delivered". Must comfortably
    // exceed the caller's own handled-id retention (catch-up state: 48h).
    doneRetentionMs = 72 * 60 * 60 * 1000,
    clock = () => Date.now(),
    logger = console,
  }) {
    if (typeof spoolDir !== 'string' || spoolDir.length === 0) {
      throw new TypeError('spoolDir is required');
    }
    if (typeof c4ReceivePath !== 'string' || c4ReceivePath.length === 0) {
      throw new TypeError('c4ReceivePath is required');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError('concurrency must be a positive integer');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    this.spoolDir = spoolDir;
    this.c4ReceivePath = c4ReceivePath;
    this.execFileFn = execFileFn;
    this.concurrency = concurrency;
    this.maxEntries = maxEntries;
    this.retryMs = retryMs;
    this.maxRetryMs = maxRetryMs;
    this.doneRetentionMs = doneRetentionMs;
    this.lastPruneAt = 0;
    this.clock = clock;
    this.logger = logger;
    this.active = 0;
    this.processing = new Set();
    this.timer = null;
    this.drainPromise = null;
    this.drainRequested = false;
    this.started = false;
    this.stopping = false;
  }

  async start() {
    await fs.promises.mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
    await this.#pruneDone();
    this.lastPruneAt = this.clock();
    this.started = true;
    this.stopping = false;
    this.#schedule(0);
  }

  async enqueue(delivery) {
    if (!this.started) await this.start();
    const record = requireDelivery({ ...delivery, enqueuedAt: this.clock(), availableAt: this.clock() });
    const filename = deliveryFilename(record.id);
    const finalPath = path.join(this.spoolDir, filename);
    try {
      await fs.promises.access(finalPath);
      this.#schedule(0);
      return { queued: true, replayed: true, id: record.id };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Already delivered earlier (possibly before a restart): do not send again.
    if (this.#isDone(filename)) {
      return { queued: false, replayed: true, delivered: true, id: record.id };
    }
    if (await this.pendingCount() >= this.maxEntries) {
      const error = new Error(`C4 durable spool is full (${this.maxEntries} entries)`);
      error.code = 'C4_SPOOL_FULL';
      throw error;
    }
    const tempPath = `${finalPath}.new.${process.pid}.${randomUUID()}`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    let replayed = false;
    try {
      await fs.promises.link(tempPath, finalPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      replayed = true;
    } finally {
      await fs.promises.unlink(tempPath).catch(() => {});
    }
    this.#schedule(0);
    return { queued: true, replayed, id: record.id };
  }

  /** Completion marker path for one spool entry. */
  #donePath(filename) {
    return path.join(this.spoolDir, `${filename}.done`);
  }

  #isDone(filename) {
    return fs.existsSync(this.#donePath(filename));
  }

  /**
   * Record that this entry reached C4, then drop the pending record.
   * The marker is created FIRST: a crash between the two leaves a marker plus a
   * pending file, which the next drain sees as delivered and skips — the safe
   * direction (no duplicate send). The reverse order could lose the memory.
   */
  async #markDone(name, record) {
    const donePath = this.#donePath(name);
    await fs.promises.writeFile(donePath, `${JSON.stringify({
      id: record.id,
      deliveredAt: this.clock(),
      attempts: record.attempts,
    })}\n`, { mode: 0o600 });
    await fs.promises.unlink(path.join(this.spoolDir, name)).catch(() => {});
  }

  /**
   * Run the marker sweep at most once an hour, off the delivery path.
   */
  #pruneDoneSoon() {
    const now = this.clock();
    if (this.lastPruneAt && now - this.lastPruneAt < 60 * 60 * 1000) return;
    this.lastPruneAt = now;
    this.#pruneDone().catch(error => {
      this.logger.warn(`[hxa-connect] Completion-marker sweep failed: ${redactSecrets(error.message)}`);
    });
  }

  /**
   * Drop completion markers older than `doneRetentionMs` (memory is bounded).
   *
   * A marker is only expired once its pending record is gone. Otherwise a
   * marker-plus-record pair left by a crash (or a failed unlink) that survives
   * a long outage would lose its marker first and then be re-sent — the exact
   * duplicate the marker exists to prevent. Recover the pair, then forget it.
   */
  async #pruneDone() {
    const cutoff = this.clock() - this.doneRetentionMs;
    let entries;
    try {
      entries = await fs.promises.readdir(this.spoolDir);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const name of entries) {
      if (!name.endsWith('.done')) continue;
      const full = path.join(this.spoolDir, name);
      const pending = path.join(this.spoolDir, name.slice(0, -'.done'.length));
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs >= cutoff) continue;
        // Still paired with a pending record: that record was delivered. Drop
        // the record first, so expiring the marker cannot resurrect it.
        await fs.promises.unlink(pending).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        await fs.promises.unlink(full);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async pendingCount() {
    const entries = await fs.promises.readdir(this.spoolDir).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return entries.filter(name => name.endsWith('.json')).length;
  }

  async waitForIdle(timeoutMs = 5_000) {
    const deadline = this.clock() + timeoutMs;
    while (this.clock() <= deadline) {
      if (this.active === 0 && await this.pendingCount() === 0) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return false;
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #schedule(delayMs) {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#drain().catch(error => {
        this.logger.error(`[hxa-connect] C4 spool drain failed: ${redactSecrets(error.message)}`);
        this.#schedule(this.retryMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  #drain() {
    if (this.drainPromise) {
      this.drainRequested = true;
      return this.drainPromise;
    }
    const run = async () => {
      do {
        this.drainRequested = false;
        await this.#drainOnce();
      } while (this.drainRequested && !this.stopping);
    };
    this.drainPromise = run().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  async #drainOnce() {
    if (this.stopping || this.active >= this.concurrency) return;
    const names = (await fs.promises.readdir(this.spoolDir))
      .filter(name => name.endsWith('.json'))
      .sort();
    let nextDelay = null;
    for (const name of names) {
      if (this.active >= this.concurrency) break;
      if (this.processing.has(name)) continue;
      const filePath = path.join(this.spoolDir, name);
      let record;
      try {
        record = requireDelivery(JSON.parse(await fs.promises.readFile(filePath, 'utf8')));
      } catch (error) {
        const corruptPath = `${filePath}.corrupt.${this.clock()}`;
        await fs.promises.rename(filePath, corruptPath).catch(() => {});
        this.logger.error(`[hxa-connect] Quarantined corrupt C4 spool entry ${name}: ${redactSecrets(error.message)}`);
        continue;
      }
      const waitMs = record.availableAt - this.clock();
      if (waitMs > 0) {
        nextDelay = nextDelay === null ? waitMs : Math.min(nextDelay, waitMs);
        continue;
      }
      if (this.#isDone(name)) {
        // Crashed between writing the marker and removing the record: it was
        // already delivered, so drop the record instead of sending it again.
        await fs.promises.unlink(filePath).catch(() => {});
        continue;
      }
      this.processing.add(name);
      this.active += 1;
      this.#deliver(name, filePath, record)
        .catch(error => {
          this.logger.error(`[hxa-connect] C4 spool state update failed id=${record.id}: ${redactSecrets(error.message)}`);
        })
        .finally(() => {
          this.processing.delete(name);
          this.active -= 1;
          this.#schedule(0);
        });
    }
    if (this.active === 0 && nextDelay !== null) this.#schedule(Math.max(1, nextDelay));
  }

  async #deliver(name, filePath, record) {
    try {
      await execute(this.execFileFn, process.execPath, [this.c4ReceivePath, ...record.args]);
      // Remove the pending record and leave a completion marker behind. The
      // marker is what makes the id still "already delivered" after a restart:
      // a successful record is otherwise gone, taking its uniqueness with it,
      // and a crash before the caller persisted its own handled-id would let
      // the message be enqueued and sent a second time.
      await this.#markDone(name, record);
      // Bound the marker directory during continuous operation, not only on the
      // next restart (swept at most hourly, off the delivery path).
      this.#pruneDoneSoon();
      this.logger.log(`[hxa-connect] -> C4 durable id=${record.id}: ${record.preview}`);
    } catch (error) {
      const attempts = record.attempts + 1;
      const delay = Math.min(this.retryMs * (2 ** Math.min(attempts - 1, 10)), this.maxRetryMs);
      const updated = {
        ...record,
        attempts,
        availableAt: this.clock() + delay,
        lastError: error.message,
      };
      await writeAtomic(filePath, updated);
      this.logger.warn(`[hxa-connect] C4 durable delivery retry id=${record.id} attempt=${attempts} in=${delay}ms: ${redactSecrets(error.message)}`);
    }
  }
}
