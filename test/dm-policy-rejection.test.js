import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { isSenderAllowed, isThreadAllowed } from '../src/lib/auth.js';
import {
  DmPolicyRejectionStore,
  createDmPolicyRejectionHandler,
  createDmPolicyGate,
  decideDmPolicy,
  isDmPolicyRejectionNotice,
} from '../src/lib/dm-policy-rejection.js';

const tempDirs = [];
const ROOT = path.resolve(import.meta.dirname, '..');

async function createStore(clock = () => 1_788_220_800_000) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-dm-policy-rejection-'));
  tempDirs.push(directory);
  return new DmPolicyRejectionStore({ directory, clock });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

function rejectedDm(overrides = {}) {
  return {
    id: 'incoming-1',
    channel_id: 'channel-1',
    sender_id: 'peer-1',
    sender_name: 'peer-agent',
    content: 'private request body',
    content_type: 'text',
    created_at: 1_788_220_799_000,
    ...overrides,
  };
}

describe('DM policy rejection', () => {
  it('keeps open and allowlisted DMs accepted while rejecting only a non-allowlisted sender', () => {
    assert.equal(decideDmPolicy({ dmPolicy: 'open' }, rejectedDm()), 'allow');
    assert.equal(decideDmPolicy({
      dmPolicy: 'allowlist',
      dmAllowFrom: ['PEER-AGENT'],
    }, rejectedDm()), 'allow');
    assert.equal(decideDmPolicy({
      dmPolicy: 'allowlist',
      dmAllowFrom: ['someone-else'],
    }, rejectedDm()), 'reject');
  });

  it('notifies a sender rejected by allowlist and persists a body-free audit', async () => {
    const store = await createStore();
    const sends = [];
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send(target, content, options) {
          sends.push({ target, content, options });
          return {
            channel_id: 'channel-1',
            message: { id: 'notice-1', channel_id: 'channel-1' },
          };
        },
        async getMessages() { return []; },
      },
    });

    const result = await handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    });

    assert.equal(result.status, 'notified');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].target, 'peer-1');
    assert.match(sends[0].content, /Sorry, I'm not available for private messages/);
    assert.match(sends[0].content, /\[zylos:dm-policy-rejection:v1:[a-f0-9]{64}\]$/);
    assert.deepEqual(sends[0].options, { content_type: 'system' });

    const audits = await store.list({ label: 'hxa' });
    assert.equal(audits.length, 1);
    assert.deepEqual({
      messageId: audits[0].messageId,
      source: audits[0].source,
      sender: audits[0].sender,
      timestamp: audits[0].timestamp,
      reason: audits[0].reason,
      policy: audits[0].policy,
    }, {
      messageId: 'incoming-1',
      source: 'websocket',
      sender: 'peer-agent',
      timestamp: 1_788_220_799_000,
      reason: 'dm_policy',
      policy: 'allowlist',
    });
    assert.equal(Object.hasOwn(audits[0], 'body'), false);
    assert.equal(Object.hasOwn(audits[0], 'content'), false);
  });

  it('lets the receiver query durable rejection audits after a process restart', async () => {
    const zylosDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-dm-policy-query-'));
    tempDirs.push(zylosDir);
    const dataDir = path.join(zylosDir, 'components', 'hxa-connect');
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, 'config.json'), `${JSON.stringify({
      orgs: { default: { access: { dmPolicy: 'allowlist' } } },
    })}\n`);
    const store = new DmPolicyRejectionStore({
      directory: path.join(dataDir, 'dm-policy-rejections'),
      clock: () => 1_788_220_800_000,
    });
    const record = await store.begin({
      idempotencyKey: 'hxa.dm-policy-rejection.v1.query-test',
      label: 'default',
      messageId: 'incoming-query',
      source: 'inbox',
      sender: 'peer-agent',
      senderId: 'peer-1',
      timestamp: 1_788_220_799_000,
      reason: 'dm_policy',
      policy: 'allowlist',
      channelId: 'channel-1',
    });
    await store.update(record, { status: 'notified', noticeMessageId: 'notice-query' });

    const child = spawnSync(process.execPath, [
      'src/admin.js',
      '--org', 'default',
      'list-dm-rejections',
      '10',
    ], {
      cwd: ROOT,
      env: { ...process.env, ZYLOS_DIR: zylosDir },
      encoding: 'utf8',
    });

    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout);
    assert.equal(output.length, 1);
    assert.deepEqual(output[0], {
      messageId: 'incoming-query',
      source: 'inbox',
      sender: 'peer-agent',
      timestamp: 1_788_220_799_000,
      reason: 'dm_policy',
      policy: 'allowlist',
      status: 'notified',
      lastError: null,
    });
    assert.doesNotMatch(child.stdout, /private request body/);
  });

  it('does not repeat the audit or notice for duplicate delivery after restart', async () => {
    const store = await createStore();
    let sends = 0;
    const client = {
      async send() {
        sends += 1;
        return { channel_id: 'channel-1', message: { id: 'notice-1' } };
      },
      async getMessages() { return []; },
    };
    const options = {
      label: 'hxa',
      store,
      client,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
    };

    const first = createDmPolicyRejectionHandler(options);
    assert.equal((await first.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    })).replayed, false);

    const restarted = createDmPolicyRejectionHandler({
      ...options,
      store: new DmPolicyRejectionStore({ directory: store.directory, clock: store.clock }),
    });
    assert.equal((await restarted.reject(rejectedDm({ sender_name: 'peer-agent-renamed' }), {
      source: 'inbox',
      policy: 'allowlist',
    })).replayed, true);

    assert.equal(sends, 1);
    assert.equal((await store.list({ label: 'hxa' })).length, 1);
  });

  it('serializes concurrent duplicate events before the Hub send', async () => {
    const store = await createStore();
    let sends = 0;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send() {
          sends += 1;
          await new Promise(resolve => setTimeout(resolve, 20));
          return { channel_id: 'channel-1', message: { id: 'notice-1' } };
        },
        async getMessages() { return []; },
      },
    });

    const results = await Promise.all([
      handler.reject(rejectedDm(), { source: 'websocket', policy: 'allowlist' }),
      handler.reject(rejectedDm(), { source: 'inbox', policy: 'allowlist' }),
    ]);

    assert.equal(sends, 1);
    assert.equal(results.filter(result => result.replayed).length, 1);
  });

  it('reconciles an unknown send result after restart before attempting another send', async () => {
    const now = 1_788_220_800_000;
    const store = await createStore(() => now);
    const history = [];
    let sends = 0;
    let reconciliations = 0;
    const client = {
      async send(target, content, options) {
        sends += 1;
        history.push({
          id: 'notice-ambiguous',
          channel_id: 'channel-1',
          sender_id: 'receiver-1',
          sender_name: 'receiver-agent',
          content,
          content_type: options.content_type,
          created_at: now + 10,
        });
        throw new Error('response socket closed');
      },
      async getMessages(channelId, options) {
        reconciliations += 1;
        assert.equal(channelId, 'channel-1');
        assert.ok(options.since <= now);
        return history;
      },
    };
    const options = {
      label: 'hxa',
      store,
      client,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
    };

    await assert.rejects(
      createDmPolicyRejectionHandler(options).reject(rejectedDm(), {
        source: 'websocket',
        policy: 'allowlist',
      }),
      /response socket closed/,
    );
    const uncertain = (await store.list({ label: 'hxa' }))[0];
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.lastError, 'response socket closed');

    const restarted = createDmPolicyRejectionHandler({
      ...options,
      store: new DmPolicyRejectionStore({ directory: store.directory, clock: store.clock }),
    });
    const result = await restarted.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    });

    assert.deepEqual(result, { status: 'notified', replayed: true, reconciled: true });
    assert.equal(sends, 1);
    assert.equal(reconciliations, 1);
  });

  it('retries an unknown result only after reconciliation proves the notice absent', async () => {
    const store = await createStore();
    const calls = [];
    let sends = 0;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send() {
          sends += 1;
          calls.push(`send-${sends}`);
          if (sends === 1) throw new Error('connect failed');
          return { channel_id: 'channel-1', message: { id: 'notice-retry' } };
        },
        async getMessages() {
          calls.push('reconcile');
          return [];
        },
      },
    });

    await assert.rejects(handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    }), /connect failed/);
    const retried = await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    });

    assert.deepEqual(calls, ['send-1', 'reconcile', 'send-2']);
    assert.deepEqual(retried, { status: 'notified', replayed: false });
  });

  it('keeps a reconciliation failure observable without blindly sending again', async () => {
    const store = await createStore();
    let sends = 0;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send() {
          sends += 1;
          throw new Error('response timeout');
        },
        async getMessages() {
          throw new Error('history unavailable');
        },
      },
    });

    await assert.rejects(handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    }), /response timeout/);
    await assert.rejects(handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    }), /history unavailable/);

    assert.equal(sends, 1);
    const audit = (await store.list({ label: 'hxa' }))[0];
    assert.equal(audit.status, 'uncertain');
    assert.equal(audit.lastError, 'history unavailable');
  });

  it('rate-limits notices durably per sender and policy while auditing every rejected DM', async () => {
    const store = await createStore();
    let sends = 0;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send() {
          sends += 1;
          return { channel_id: 'channel-1', message: { id: `notice-${sends}` } };
        },
        async getMessages() { return []; },
      },
    });

    await handler.reject(rejectedDm(), { source: 'websocket', policy: 'allowlist' });
    const limited = await handler.reject(rejectedDm({
      id: 'incoming-2',
      created_at: 1_788_220_799_500,
    }), { source: 'websocket', policy: 'allowlist' });

    assert.deepEqual(limited, { status: 'rate_limited', replayed: false });
    assert.equal(sends, 1);
    const audits = await store.list({ label: 'hxa' });
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map(audit => audit.status).sort(), ['notified', 'rate_limited']);

    const afterRestart = createDmPolicyRejectionHandler({
      label: 'hxa',
      store: new DmPolicyRejectionStore({ directory: store.directory, clock: store.clock }),
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: { async send() { sends += 1; } },
    });
    assert.equal((await afterRestart.reject(rejectedDm({ id: 'incoming-2' }), {
      source: 'inbox',
      policy: 'allowlist',
    })).replayed, true);
    assert.equal(sends, 1);
  });

  it('sends exactly one notice for concurrent messages in the same sender-policy window', async () => {
    const store = await createStore();
    let sends = 0;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send() {
          sends += 1;
          await new Promise(resolve => setTimeout(resolve, 20));
          return { channel_id: 'channel-1', message: { id: `notice-${sends}` } };
        },
        async getMessages() { return []; },
      },
    });

    const results = await Promise.all([
      handler.reject(rejectedDm({ id: 'concurrent-1' }), {
        source: 'websocket',
        policy: 'allowlist',
      }),
      handler.reject(rejectedDm({ id: 'concurrent-2' }), {
        source: 'websocket',
        policy: 'allowlist',
      }),
    ]);

    assert.equal(sends, 1);
    assert.deepEqual(results.map(result => result.status).sort(), ['notified', 'rate_limited']);
  });

  it('recognizes only protocol-marked system notices for no-assistant loop suppression', async () => {
    const store = await createStore();
    let sentNotice;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send(target, content, options) {
          sentNotice = { content, content_type: options.content_type };
          return { channel_id: 'channel-1', message: { id: 'notice-1' } };
        },
        async getMessages() { return []; },
      },
    });
    await handler.reject(rejectedDm(), { source: 'websocket', policy: 'allowlist' });

    assert.equal(isDmPolicyRejectionNotice(sentNotice), true);
    assert.equal(isDmPolicyRejectionNotice({ ...sentNotice, content_type: 'text' }), false);
    assert.equal(isDmPolicyRejectionNotice({
      content_type: 'system',
      content: 'ordinary system message',
    }), false);
  });

  it('keeps rejection notices out of the assistant path and never replies to them', async () => {
    const store = await createStore();
    let sends = 0;
    let sentNotice;
    const rejectionHandler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send(target, content, options) {
          sends += 1;
          sentNotice = { content, content_type: options.content_type };
          return { channel_id: 'channel-1', message: { id: 'notice-1' } };
        },
        async getMessages() { return []; },
      },
    });
    const gate = createDmPolicyGate({ rejectionHandler });

    assert.deepEqual(await gate.evaluate(rejectedDm({ id: 'open-message' }), {
      source: 'websocket',
      access: { dmPolicy: 'open' },
    }), { action: 'continue' });
    assert.equal((await store.list({ label: 'hxa' })).length, 0);

    assert.deepEqual(await gate.evaluate(rejectedDm(), {
      source: 'websocket',
      access: { dmPolicy: 'allowlist', dmAllowFrom: [] },
    }), {
      action: 'discarded',
      reason: 'dm_policy',
      notificationStatus: 'notified',
      notificationReplayed: false,
    });
    assert.deepEqual(await gate.evaluate({
      ...rejectedDm({ id: 'notice-inbound' }),
      ...sentNotice,
    }, {
      source: 'websocket',
      access: { dmPolicy: 'allowlist', dmAllowFrom: [] },
    }), {
      action: 'discarded',
      reason: 'dm_policy_rejection_notice',
    });
    assert.equal(sends, 1);
  });

  it('does not change thread open, allowlist, or per-sender policy semantics', () => {
    assert.equal(isThreadAllowed({ groupPolicy: 'open' }, 'thread-any'), true);
    assert.equal(isThreadAllowed({
      groupPolicy: 'allowlist',
      threads: { 'thread-allowed': { allowFrom: ['peer-agent'] } },
    }, 'thread-allowed'), true);
    assert.equal(isThreadAllowed({
      groupPolicy: 'allowlist',
      threads: { 'thread-allowed': {} },
    }, 'thread-denied'), false);
    assert.equal(isSenderAllowed({
      threads: { 'thread-allowed': { allowFrom: ['PEER-AGENT'] } },
    }, 'thread-allowed', 'peer-agent'), true);
    assert.equal(isSenderAllowed({
      threads: { 'thread-allowed': { allowFrom: ['someone-else'] } },
    }, 'thread-allowed', 'peer-agent'), false);
  });
});
