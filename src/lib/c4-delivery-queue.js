import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';

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
    this.clock = clock;
    this.logger = logger;
    this.active = 0;
    this.processing = new Set();
    this.timer = null;
    this.started = false;
    this.stopping = false;
  }

  async start() {
    await fs.promises.mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
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
        this.logger.error(`[hxa-connect] C4 spool drain failed: ${error.message}`);
        this.#schedule(this.retryMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async #drain() {
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
        this.logger.error(`[hxa-connect] Quarantined corrupt C4 spool entry ${name}: ${error.message}`);
        continue;
      }
      const waitMs = record.availableAt - this.clock();
      if (waitMs > 0) {
        nextDelay = nextDelay === null ? waitMs : Math.min(nextDelay, waitMs);
        continue;
      }
      this.processing.add(name);
      this.active += 1;
      this.#deliver(name, filePath, record).finally(() => {
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
      await fs.promises.unlink(filePath);
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
      this.logger.warn(`[hxa-connect] C4 durable delivery retry id=${record.id} attempt=${attempts} in=${delay}ms: ${error.message}`);
    }
  }
}
