import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AssistantResponseDeliveryStore,
  createAssistantResponseDelivery,
  createAssistantResponseSender,
  dmResponseEndpoint,
  parseHxaResponseEndpoint,
} from '../src/lib/assistant-response-delivery.js';

const tempDirs = [];

async function createStore(clock = () => 1_787_773_000_000) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-response-delivery-'));
  tempDirs.push(directory);
  return new AssistantResponseDeliveryStore({ directory, clock });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

function delivery({
  requestId = 'hxa.dm.request-1',
  endpointId = 'org:hxa|ss|msg:source-message-1',
  type = 'RunCompleted',
  sequence = 5,
  payload = { output: 'exact response' },
} = {}) {
  return {
    schemaVersion: 1,
    requestId,
    route: { channel: 'hxa-connect', endpointId },
    events: [{ requestId, type, sequence, payload }],
  };
}

function progressDelivery() {
  return {
    schemaVersion: 1,
    requestId: 'hxa.dm.request-1',
    route: { channel: 'hxa-connect', endpointId: 'org:hxa|ss|msg:source-message-1' },
    events: [{
      requestId: 'hxa.dm.request-1',
      type: 'ProgressUpdated',
      sequence: 4,
      payload: { stage: 'execute_action' },
    }],
  };
}

describe('HXA assistant response delivery', () => {
  it('parses DM and thread response endpoints with source message identity', () => {
    assert.deepEqual(parseHxaResponseEndpoint('org:hxa|ss|msg:abc-123'), {
      kind: 'dm',
      orgLabel: 'hxa',
      target: 'ss',
      sourceMessageId: 'abc-123',
      endpointId: 'org:hxa|ss|msg:abc-123',
    });
    assert.deepEqual(parseHxaResponseEndpoint('thread:thread-1|msg:msg-1'), {
      kind: 'thread',
      orgLabel: 'default',
      threadId: 'thread-1',
      replyToId: 'msg-1',
      endpointId: 'thread:thread-1|msg:msg-1',
    });
    assert.equal(dmResponseEndpoint('default', 'ss', 'msg-1', { multiOrg: false }), 'ss|msg:msg-1');
    assert.equal(dmResponseEndpoint('hxa', 'ss', 'msg-1'), 'org:hxa|ss|msg:msg-1');
  });

  it('acknowledges progress without sending an HXA message', async () => {
    const store = await createStore();
    let resolved = 0;
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => { resolved += 1; },
      defaultOrgLabel: 'hxa',
    });
    assert.deepEqual(await adapter.deliver(progressDelivery()), {
      handled: true,
      terminal: false,
    });
    assert.equal(resolved, 0);
  });

  it('sends one exact DM terminal response and suppresses a replay', async () => {
    const store = await createStore();
    const sends = [];
    const client = {
      async send(target, content) {
        sends.push({ target, content });
        return {
          channel_id: 'channel-1',
          message: { id: 'outbound-1', channel_id: 'channel-1' },
        };
      },
      async inbox() { return []; },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => ({ client, agentId: 'self-1', agentName: 'agent' }),
      defaultOrgLabel: 'hxa',
    });

    const first = await adapter.deliver(delivery());
    const replay = await adapter.deliver(delivery());
    assert.equal(first.replayed, false);
    assert.equal(first.hubMessageId, 'outbound-1');
    assert.equal(replay.replayed, true);
    assert.deepEqual(sends, [{ target: 'ss', content: 'exact response' }]);
  });

  it('suppresses an exact DM [SKIP] terminal before resolving the Hub org', async () => {
    const store = await createStore();
    let resolved = 0;
    let sends = 0;
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => {
        resolved += 1;
        return {
          client: {
            async send() {
              sends += 1;
              return { channel_id: 'channel-1', message: { id: 'unexpected' } };
            },
          },
          agentId: 'self-1',
          agentName: 'agent',
        };
      },
      defaultOrgLabel: 'hxa',
    });

    const result = await adapter.deliver(delivery({
      payload: { output: '  [SKIP]  ' },
    }));
    assert.deepEqual(result, {
      handled: true,
      replayed: false,
      status: 'suppressed',
      terminal: true,
      eventType: 'RunCompleted',
    });
    assert.equal(resolved, 0);
    assert.equal(sends, 0);
  });

  it('deduplicates an explicit c4-send reply against the later terminal stream event', async () => {
    const store = await createStore();
    const sends = [];
    const client = {
      async send(target, content) {
        sends.push({ target, content });
        return {
          channel_id: 'channel-1',
          message: { id: 'outbound-explicit', channel_id: 'channel-1' },
        };
      },
      async inbox() { return []; },
    };
    const options = {
      store,
      resolveOrg: async () => ({ client, agentId: 'self-1', agentName: 'agent' }),
      defaultOrgLabel: 'hxa',
    };
    const sender = createAssistantResponseSender(options);
    const adapter = createAssistantResponseDelivery(options);

    await sender.send({
      requestId: 'hxa.dm.request-1',
      endpointId: 'org:hxa|ss',
      content: 'exact response',
    });
    const terminal = await adapter.deliver(delivery());
    assert.equal(terminal.replayed, true);
    assert.deepEqual(sends, [{ target: 'ss', content: 'exact response' }]);
  });

  it('serializes concurrent terminal replays before the Hub send', async () => {
    const store = await createStore();
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        await new Promise(resolve => setTimeout(resolve, 40));
        return {
          channel_id: 'channel-1',
          message: { id: 'outbound-concurrent', channel_id: 'channel-1' },
        };
      },
      async inbox() { return []; },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => ({ client, agentId: 'self-1', agentName: 'agent' }),
      defaultOrgLabel: 'hxa',
    });

    const results = await Promise.all([adapter.deliver(delivery()), adapter.deliver(delivery())]);
    assert.equal(sends, 1);
    assert.equal(results.filter(result => result.replayed).length, 1);
  });

  it('reconciles Hub success after an ambiguous transport error without sending twice', async () => {
    const now = 1_787_773_000_000;
    const store = await createStore(() => now);
    const inbox = [{
      id: 'source-message-1',
      channel_id: 'channel-1',
      sender_id: 'peer-1',
      sender_name: 'ss',
      content: 'request',
      created_at: now - 100,
    }];
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        inbox.push({
          id: 'outbound-ambiguous',
          channel_id: 'channel-1',
          sender_id: 'self-1',
          sender_name: 'agent',
          content: 'exact response',
          created_at: now + 10,
        });
        throw new Error('response socket closed');
      },
      async inbox() { return inbox; },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => ({ client, agentId: 'self-1', agentName: 'agent' }),
      defaultOrgLabel: 'hxa',
      logger: { warn() {} },
    });

    await assert.rejects(adapter.deliver(delivery()), /response socket closed/);
    const recovered = await adapter.deliver(delivery());
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.status, 'delivered');
    assert.equal(sends, 1);
  });

  it('retries when the failed attempt never reached the Hub', async () => {
    const now = 1_787_773_000_000;
    const store = await createStore(() => now);
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        if (sends === 1) throw new Error('connect failed');
        return {
          channel_id: 'channel-1',
          message: { id: 'outbound-retry', channel_id: 'channel-1' },
        };
      },
      async inbox() {
        return [{
          id: 'source-message-1',
          channel_id: 'channel-1',
          sender_id: 'peer-1',
          sender_name: 'ss',
          content: 'request',
          created_at: now - 100,
        }];
      },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => ({ client, agentId: 'self-1', agentName: 'agent' }),
      defaultOrgLabel: 'hxa',
    });

    await assert.rejects(adapter.deliver(delivery()), /connect failed/);
    const retried = await adapter.deliver(delivery());
    assert.equal(retried.replayed, false);
    assert.equal(retried.hubMessageId, 'outbound-retry');
    assert.equal(sends, 2);
  });

  it('replies inside a thread once and preserves reply_to', async () => {
    const store = await createStore();
    const sends = [];
    const client = {
      async sendThreadMessage(threadId, content, options) {
        sends.push({ threadId, content, options });
        return { id: 'thread-outbound-1' };
      },
      async getThreadMessages() { return []; },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => ({ client, agentId: 'self-1', agentName: 'agent' }),
    });
    const input = delivery({ endpointId: 'thread:thread-1|msg:source-thread-message' });

    await adapter.deliver(input);
    await adapter.deliver(input);
    assert.deepEqual(sends, [{
      threadId: 'thread-1',
      content: 'exact response',
      options: { reply_to: 'source-thread-message' },
    }]);
  });

  it('suppresses a retryable failed run without sending an HXA message', async () => {
    const store = await createStore();
    const contents = [];
    const warnings = [];
    const client = {
      async send(target, content) {
        contents.push(content);
        return { channel_id: 'channel-1', message: { id: 'failure-message' } };
      },
      async inbox() { return []; },
    };
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => ({ client, agentId: 'self-1', agentName: 'agent' }),
      defaultOrgLabel: 'hxa',
      logger: { warn(message, details) { warnings.push({ message, details }); } },
    });
    const result = await adapter.deliver(delivery({
      type: 'RunFailed',
      payload: { code: 'RUN_STALE_AFTER_RESTART', retryable: true },
    }));
    assert.deepEqual(result, {
      handled: true,
      terminal: true,
      status: 'suppressed',
      eventType: 'RunFailed',
      failure: { code: 'RUN_STALE_AFTER_RESTART', retryable: true },
    });
    assert.deepEqual(contents, []);
    assert.deepEqual(warnings, [{
      message: '[hxa-connect] Suppressed outbound RunFailed terminal',
      details: {
        requestId: 'hxa.dm.request-1',
        code: 'RUN_STALE_AFTER_RESTART',
        retryable: true,
      },
    }]);
  });

  it('keeps a non-retryable failed run locally distinguishable from silence', async () => {
    const store = await createStore();
    let resolved = 0;
    const adapter = createAssistantResponseDelivery({
      store,
      resolveOrg: async () => { resolved += 1; },
      logger: { warn() {} },
    });
    const result = await adapter.deliver(delivery({
      type: 'RunFailed',
      payload: { code: 'PERMANENT_FAILURE', retryable: false },
    }));
    assert.deepEqual(result, {
      handled: true,
      terminal: true,
      status: 'suppressed',
      eventType: 'RunFailed',
      failure: { code: 'PERMANENT_FAILURE', retryable: false },
    });
    assert.equal(resolved, 0);
  });
});
