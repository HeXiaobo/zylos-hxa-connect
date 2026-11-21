/**
 * Regression: a first DM send failure must not wedge every later retry.
 *
 * The inbound DM arrives 60 seconds BEFORE this process starts sending — the
 * normal case, because the agent spends that time working. `startedAt` is the
 * first send attempt, so the reply window is `startedAt - 5s` and the source
 * message is far outside it. `reconcileDm()` used to require the source message
 * inside that same window to learn the DM channel, so after one
 * `ECONNREFUSED` the route could never resolve again: every later call threw
 * `HXA_RECONCILE_ROUTE_UNKNOWN` and the reply was lost for good.
 *
 * Nothing below mocks the storage or the clock: the store is the real
 * file-backed one, and the fake hub filters by `since` exactly like the hub
 * does. Only the transport is a stand-in.
 *
 * Both delivery paths are covered, because they share the reconcile:
 *   1. the legacy event-batch delivery (`createAssistantResponseDelivery`);
 *   2. the canonical adapter (`createHxaFinalDeliveryAdapter`).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AssistantResponseDeliveryStore,
  createAssistantResponseDelivery,
} from '../src/lib/assistant-response-delivery.js';
import { createHxaFinalDeliveryAdapter } from '../src/lib/hxa-final-delivery-adapter.js';

const NOW = 1_800_000_000_000;
const SOURCE_AGE_MS = 60_000;
const CHANNEL_ID = 'dm-channel-1';
const SELF = { agentId: 'self-agent-id', agentName: 'self-agent' };

const tempDirs = [];

async function createStore() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-dm-channel-'));
  tempDirs.push(directory);
  return new AssistantResponseDeliveryStore({ directory, clock: () => NOW });
}

async function readOnlyRecord(store) {
  const [file] = (await fs.promises.readdir(store.directory)).filter(name => name.endsWith('.json'));
  return JSON.parse(await fs.promises.readFile(path.join(store.directory, file), 'utf8'));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

/**
 * A stand-in hub for one DM channel.
 *
 * `inbox(since)` returns the messages that ARRIVED here at or after `since`,
 * which is what the hub does: once the source DM is 60 s older than the send,
 * an inbox window starting at `startedAt - 5s` cannot contain it.
 */
function fakeHub() {
  const arrivals = [{
    id: 'source-message-1',
    channel_id: CHANNEL_ID,
    sender_id: 'peer-agent-id',
    sender_name: 'peer-agent',
    content: 'please answer',
    created_at: NOW - SOURCE_AGE_MS,
  }];
  const delivered = [];
  const calls = { send: 0, inbox: 0, getMessages: 0 };

  return {
    calls,
    delivered,
    client: {
      async send(target, content) {
        calls.send += 1;
        return { channel_id: CHANNEL_ID, message: this.accept(target, content) };
      },
      // Accept the message on the hub, then fail the response — the ambiguous
      // case: the message exists, but the caller never learned its id.
      accept(_target, content) {
        const message = {
          id: `outbound-${delivered.length + 1}`,
          channel_id: CHANNEL_ID,
          sender_id: SELF.agentId,
          sender_name: SELF.agentName,
          content,
          created_at: NOW + delivered.length + 1,
        };
        delivered.push(message);
        return message;
      },
      async inbox(since) {
        calls.inbox += 1;
        return arrivals.filter(message => message.created_at >= since);
      },
      async getMessages(channelId, opts = {}) {
        calls.getMessages += 1;
        assert.equal(channelId, CHANNEL_ID);
        const since = opts.since ?? 0;
        return [...arrivals, ...delivered]
          .filter(message => message.created_at >= since)
          .sort((left, right) => left.created_at - right.created_at);
      },
    },
  };
}

function terminalDelivery() {
  return {
    schemaVersion: 1,
    requestId: 'hxa.dm.request-late-source',
    route: { channel: 'hxa-connect', endpointId: 'org:hxa|peer-agent|msg:source-message-1' },
    events: [{
      requestId: 'hxa.dm.request-late-source',
      type: 'RunCompleted',
      sequence: 5,
      payload: { output: 'the answer' },
    }],
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function replyIntent() {
  const route = { adapterId: 'hxa-connect', targetRef: 'org:hxa|peer-agent|msg:source-message-1' };
  const payload = { format: 'text', text: 'the canonical answer' };
  const intentId = `reply:request-canonical:${createHash('sha256').update(canonicalJson(route)).digest('hex')}`;
  return {
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId,
    requestId: 'request-canonical',
    traceId: 'trace-canonical',
    cause: { kind: 'run_terminal', eventId: 'event-canonical-6' },
    route,
    disposition: 'send',
    payload,
    contentHash: `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`,
    idempotencyKey: intentId,
  };
}

describe('DM reply delivery when the source DM is older than the send', () => {
  it('legacy path: a retry after ECONNREFUSED sends again and ends delivered', async () => {
    const store = await createStore();
    const hub = fakeHub();
    const client = {
      ...hub.client,
      send: async (target, content) => {
        if (hub.calls.send === 0) {
          hub.calls.send += 1;
          const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
          error.code = 'ECONNREFUSED';
          throw error;
        }
        return hub.client.send(target, content);
      },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      defaultOrgLabel: 'hxa',
      resolveOrg: async () => ({ client, ...SELF }),
      logger: { warn() {} },
    });

    await assert.rejects(adapter.deliver(terminalDelivery()), /ECONNREFUSED/);
    assert.equal(hub.calls.send, 1, 'the first attempt must reach the transport');
    assert.equal((await readOnlyRecord(store)).status, 'uncertain');

    const retried = await adapter.deliver(terminalDelivery());

    assert.equal(hub.calls.send, 2, 'the retry must send, not stall in reconcile');
    assert.equal(retried.replayed, false);
    assert.equal(retried.status, 'delivered');
    assert.equal(retried.hubMessageId, 'outbound-1');
    assert.equal((await readOnlyRecord(store)).status, 'delivered');
  });

  it('legacy path: the DM channel is learned before the first send and persisted', async () => {
    const store = await createStore();
    const hub = fakeHub();
    const failing = {
      ...hub.client,
      send: async () => {
        hub.calls.send += 1;
        const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      defaultOrgLabel: 'hxa',
      resolveOrg: async () => ({ client: failing, ...SELF }),
      logger: { warn() {} },
    });

    await assert.rejects(adapter.deliver(terminalDelivery()), /ECONNREFUSED/);

    const record = await readOnlyRecord(store);
    assert.equal(record.status, 'uncertain');
    assert.equal(record.channelId, CHANNEL_ID, 'the channel must be persisted with the record');
    assert.equal(record.attempts, 1);
  });

  it('canonical path: reconcile settles the ambiguous attempt in the persisted channel', async () => {
    const store = await createStore();
    const hub = fakeHub();
    const client = {
      ...hub.client,
      send: async (target, content) => {
        hub.calls.send += 1;
        hub.client.accept(target, content);
        throw new Error('socket hang up');
      },
    };
    const adapter = createHxaFinalDeliveryAdapter({
      store,
      defaultOrgLabel: 'hxa',
      clock: () => NOW,
      resolveOrg: async () => ({ client, ...SELF }),
      logger: { warn() {}, error() {} },
    });
    const intent = replyIntent();
    const attempt = { attemptId: 'attempt:canonical:1', ownerId: 'owner-1' };

    const sent = await adapter.deliver(intent, attempt);
    assert.equal(sent.outcome, 'unknown');
    assert.equal(hub.calls.send, 1);

    const settled = await adapter.reconcile(intent, attempt);

    assert.equal(settled.outcome, 'reconciled');
    assert.equal(settled.externalRef, 'opaque:outbound-1');
    assert.equal(hub.calls.send, 1, 'reconcile must not send a second message');
  });
});
