import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { C4DeliveryQueue } from '../src/lib/c4-delivery-queue.js';

const tempDirs = [];

async function tempDir() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-c4-spool-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

function delivery(id = 'message-1') {
  return {
    id,
    args: ['--channel', 'hxa-connect', '--endpoint', 'org:hxa|ss', '--content', id],
    preview: id,
  };
}

describe('C4DeliveryQueue', () => {
  it('spools duplicate deliveries once and invokes C4 once', async () => {
    const spoolDir = await tempDir();
    const calls = [];
    const execFileFn = (command, args, options, callback) => {
      calls.push({ command, args, options });
      setImmediate(() => callback(null, '{"ok":true}', ''));
    };
    const queue = new C4DeliveryQueue({
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn,
      logger: { log() {}, warn() {}, error() {} },
    });
    await queue.start();

    const results = await Promise.all([queue.enqueue(delivery()), queue.enqueue(delivery())]);
    assert.equal(results.filter(result => result.replayed).length, 1);
    assert.equal(await queue.waitForIdle(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(calls[0].args, ['/fake/c4-receive.js', ...delivery().args]);
    queue.stop();
  });

  it('retains a failed item and retries until C4 accepts it', async () => {
    const spoolDir = await tempDir();
    let attempts = 0;
    const execFileFn = (command, args, options, callback) => {
      attempts += 1;
      setImmediate(() => {
        if (attempts === 1) callback(new Error('temporary C4 outage'), '', '');
        else callback(null, '{"ok":true}', '');
      });
    };
    const queue = new C4DeliveryQueue({
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn,
      retryMs: 5,
      maxRetryMs: 5,
      logger: { log() {}, warn() {}, error() {} },
    });
    await queue.start();
    await queue.enqueue(delivery('retry-me'));

    assert.equal(await queue.waitForIdle(2_000), true);
    assert.equal(attempts, 2);
    assert.equal(await queue.pendingCount(), 0);
    queue.stop();
  });

  it('recovers a pending spool entry after process restart', async () => {
    const spoolDir = await tempDir();
    let firstAttempts = 0;
    const first = new C4DeliveryQueue({
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn: (command, args, options, callback) => {
        firstAttempts += 1;
        setImmediate(() => callback(new Error('offline'), '', ''));
      },
      retryMs: 50,
      maxRetryMs: 50,
      logger: { log() {}, warn() {}, error() {} },
    });
    await first.start();
    await first.enqueue(delivery('survive-restart'));
    while (firstAttempts === 0) await new Promise(resolve => setTimeout(resolve, 5));
    while (first.active !== 0) await new Promise(resolve => setTimeout(resolve, 5));
    first.stop();
    assert.equal(await first.pendingCount(), 1);

    let recovered = 0;
    const second = new C4DeliveryQueue({
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn: (command, args, options, callback) => {
        recovered += 1;
        setImmediate(() => callback(null, '{"ok":true}', ''));
      },
      logger: { log() {}, warn() {}, error() {} },
    });
    await second.start();
    assert.equal(await second.waitForIdle(2_000), true);
    assert.equal(recovered, 1);
    second.stop();
  });

  it('fails visibly at the spool bound while preserving idempotent replays', async () => {
    const spoolDir = await tempDir();
    const queue = new C4DeliveryQueue({
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      execFileFn: () => {},
      maxEntries: 1,
      logger: { log() {}, warn() {}, error() {} },
    });
    await queue.start();
    await queue.enqueue(delivery('first'));

    const replay = await queue.enqueue(delivery('first'));
    assert.equal(replay.replayed, true);
    await assert.rejects(queue.enqueue(delivery('second')), error => error.code === 'C4_SPOOL_FULL');
    queue.stop();
  });
});
