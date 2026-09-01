import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AssistantResponseDeliveryStore,
  createAssistantResponseDelivery,
  createAssistantResponseSender,
} from '../src/lib/assistant-response-delivery.js';
import { C4DeliveryQueue } from '../src/lib/c4-delivery-queue.js';
import { loadFixture } from './helpers/reply-contract-fixture.js';

const characterization = loadFixture('hxa-current-behavior-v1.json');
const tempDirs = [];

async function tempDir(prefix) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for characterized behavior');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

function legacyDelivery({
  requestId = 'hxa.dm.characterization-1',
  endpointId = 'org:hxa|peer-agent|msg:source-message-1',
  type = 'RunCompleted',
  payload = { output: 'exact response' },
} = {}) {
  return {
    schemaVersion: 1,
    requestId,
    route: { channel: 'hxa-connect', endpointId },
    events: [{ requestId, type, sequence: 5, payload }],
  };
}

function c4Delivery(id) {
  return {
    id,
    args: ['--channel', 'hxa-connect', '--endpoint', 'org:hxa|peer-agent', '--content', id],
    preview: id,
  };
}

describe('HXA current reply behavior characterization', () => {
  it('records the exact baseline and existing durable assets without claiming official HXA parity', () => {
    assert.equal(characterization.baselineSha, 'c99baa9215bad3136d62c4688ba115b927b404a2');
    assert.equal(characterization.packageVersion, '1.7.8');
    assert.equal(characterization.officialPeer.verified, false);
    assert.deepEqual(characterization.assets.map(asset => asset.name), [
      'AssistantResponseDeliveryStore',
      'C4DeliveryQueue',
      'DmInboxReconciler',
      'silent suppression',
    ]);
  });

  it('acknowledges ProgressUpdated and OutputDelta without resolving an org or sending Hub messages', async () => {
    const directory = await tempDir('hxa-terminal-only-');
    let resolved = 0;
    const adapter = createAssistantResponseDelivery({
      store: new AssistantResponseDeliveryStore({ directory }),
      resolveOrg: async () => { resolved += 1; },
      defaultOrgLabel: 'hxa',
    });

    for (const type of ['ProgressUpdated', 'OutputDelta']) {
      assert.deepEqual(await adapter.deliver(legacyDelivery({
        type,
        payload: { text: 'draft content' },
      })), {
        handled: true,
        terminal: false,
      });
    }
    assert.equal(resolved, 0);
    assert.deepEqual(await fs.promises.readdir(directory).catch(() => []), []);
  });

  it('rejects blank and invisible legacy RunCompleted output without manufacturing success', async () => {
    const directory = await tempDir('hxa-empty-output-');
    const sent = [];
    const adapter = createAssistantResponseDelivery({
      store: new AssistantResponseDeliveryStore({ directory }),
      resolveOrg: async () => ({
        agentId: 'self-1',
        agentName: 'agent',
        client: {
          async send(target, content) {
            sent.push({ target, content });
            return { channel_id: 'dm-1', message: { id: 'hub-fallback-1' } };
          },
          async inbox() { return []; },
        },
      }),
      defaultOrgLabel: 'hxa',
    });

    for (const output of ['   ', '\u200B\u200C\u200D\u2060\uFEFF']) {
      await assert.rejects(
        adapter.deliver(legacyDelivery({
          requestId: `hxa.dm.empty-${output.length}`,
          payload: { output },
        })),
        error => error.code === 'MISSING_OUTPUT',
      );
    }
    assert.deepEqual(sent, []);
    assert.equal(characterization.currentSemantics.emptyOutputBehavior, 'empty RunCompleted output is replaced with 处理完成。');
  });

  it('fails closed when the same request-derived delivery identity is replayed with different content', async () => {
    const directory = await tempDir('hxa-identity-conflict-');
    let sends = 0;
    const sender = createAssistantResponseSender({
      store: new AssistantResponseDeliveryStore({ directory }),
      resolveOrg: async () => ({
        agentId: 'self-1',
        agentName: 'agent',
        client: {
          async send() {
            sends += 1;
            return { channel_id: 'dm-1', message: { id: `hub-${sends}` } };
          },
          async inbox() { return []; },
        },
      }),
      defaultOrgLabel: 'hxa',
    });
    const input = {
      requestId: 'hxa.dm.identity-conflict',
      endpointId: 'org:hxa|peer-agent|msg:source-message-1',
    };

    await sender.send({ ...input, content: 'first answer' });
    await assert.rejects(
      sender.send({ ...input, content: 'different answer' }),
      /identity collision/,
    );
    assert.equal(sends, 1);
  });

  it('recovers a delivered identity from disk after an adapter restart without sending twice', async () => {
    const directory = await tempDir('hxa-restart-replay-');
    let sends = 0;
    const options = store => ({
      store,
      resolveOrg: async () => ({
        agentId: 'self-1',
        agentName: 'agent',
        client: {
          async send() {
            sends += 1;
            return { channel_id: 'dm-1', message: { id: 'hub-restart-1' } };
          },
          async inbox() { return []; },
        },
      }),
      defaultOrgLabel: 'hxa',
    });
    const input = {
      requestId: 'hxa.dm.restart-replay',
      endpointId: 'org:hxa|peer-agent|msg:source-message-1',
      content: 'restart-safe answer',
    };

    const first = createAssistantResponseSender(options(new AssistantResponseDeliveryStore({ directory })));
    assert.equal((await first.send(input)).replayed, false);

    const restarted = createAssistantResponseSender(options(new AssistantResponseDeliveryStore({ directory })));
    assert.equal((await restarted.send(input)).replayed, true);
    assert.equal(sends, 1);

    const records = (await fs.promises.readdir(directory)).filter(name => name.endsWith('.json'));
    assert.equal(records.length, 1);
    const record = JSON.parse(await fs.promises.readFile(path.join(directory, records[0]), 'utf8'));
    assert.match(record.deliveryId, /^hxa\.response\.[a-f0-9]{64}$/);
    assert.equal(record.status, 'delivered');
  });

  it('keeps issue-9 drain scheduling serialized so an enqueue during an active drain is not stranded', async () => {
    const spoolDir = await tempDir('hxa-issue-9-drain-');
    const calls = [];
    let releaseFirst;
    const queue = new C4DeliveryQueue({
      spoolDir,
      c4ReceivePath: '/fake/c4-receive.js',
      concurrency: 1,
      execFileFn(command, args, options, callback) {
        const id = args.at(-1);
        calls.push(id);
        if (id === 'first') {
          releaseFirst = () => callback(null, '{"ok":true}', '');
          return;
        }
        setImmediate(() => callback(null, '{"ok":true}', ''));
      },
      logger: { log() {}, warn() {}, error() {} },
    });

    await queue.start();
    await queue.enqueue(c4Delivery('first'));
    await waitUntil(() => Boolean(releaseFirst));
    await queue.enqueue(c4Delivery('second'));
    releaseFirst();

    assert.equal(await queue.waitForIdle(2_000), true);
    assert.deepEqual(calls, ['first', 'second']);
    queue.stop();
  });
});
