import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { isSenderAllowed, isThreadAllowed } from '../src/lib/auth.js';
import {
  DmPolicyRejectionStore,
  createDmPolicyRejectionHandler as createBaseDmPolicyRejectionHandler,
  createDmPolicyGate,
  decideDmPolicy,
  isDmPolicyRejectionNotice,
} from '../src/lib/dm-policy-rejection.js';

const tempDirs = [];
const ROOT = path.resolve(import.meta.dirname, '..');
const NOTICE_SECRET = 'test-only-shared-dm-policy-notice-secret';

function createDmPolicyRejectionHandler(options) {
  return createBaseDmPolicyRejectionHandler({
    ...options,
    noticeSecret: NOTICE_SECRET,
  });
}

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
    assert.match(sends[0].content, /\[zylos:dm-policy-rejection:v2:[A-Za-z0-9_-]+:[a-f0-9]{64}\]$/);
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
    assert.doesNotMatch(await fs.promises.readFile(
      store.filePath(audits[0].idempotencyKey),
      'utf8',
    ), new RegExp(NOTICE_SECRET));
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
    await store.update(record, {
      status: 'dead_letter',
      noticeMessageId: null,
      lastError: {
        errorCode: 'HTTP_403',
        errorClass: 'HttpError',
        retryable: false,
        summary: 'HTTP request rejected with status 403',
        body: 'private request body',
        token: 'Bearer secret-token',
        request: { url: 'https://hub.invalid/messages?token=secret-token' },
      },
    });

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
      status: 'dead_letter',
      lastError: {
        errorCode: 'HTTP_403',
        errorClass: 'HttpError',
        retryable: false,
        summary: 'HTTP request rejected with status 403',
      },
    });
    assert.doesNotMatch(child.stdout, /private request body/);
    assert.doesNotMatch(child.stdout, /secret-token/);
    assert.doesNotMatch(child.stdout, /hub\.invalid/);
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
    let now = 1_788_220_800_000;
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

    const initial = await createDmPolicyRejectionHandler(options).reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    });
    assert.deepEqual(initial, {
      status: 'retry_wait',
      replayed: false,
      nextRetryAt: now + 1_000,
    });
    const uncertain = (await store.list({ label: 'hxa' }))[0];
    assert.equal(uncertain.status, 'retry_wait');
    assert.deepEqual(uncertain.lastError, {
      errorCode: 'TRANSPORT_ERROR',
      errorClass: 'TransportError',
      retryable: true,
      summary: 'Transport request failed',
    });
    now += 1_000;

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

  it('does not reconcile the wrong route, a sender-name spoof, or an out-of-window notice', async () => {
    let now = 1_788_220_800_000;
    const store = await createStore(() => now);
    let sends = 0;
    let noticeContent;
    const client = {
      async send(target, content) {
        sends += 1;
        noticeContent = content;
        if (sends === 1) throw new Error('response socket closed');
        return { channel_id: 'channel-1', message: { id: 'notice-retry' } };
      },
      async getMessages() {
        return [
          {
            id: 'wrong-channel',
            channel_id: 'channel-attacker',
            sender_id: 'receiver-1',
            sender_name: 'receiver-agent',
            content: noticeContent,
            content_type: 'system',
            created_at: now + 10,
          },
          {
            id: 'wrong-sender',
            channel_id: 'channel-1',
            sender_id: 'attacker-1',
            sender_name: 'receiver-agent',
            content: noticeContent,
            content_type: 'system',
            created_at: now + 10,
          },
          {
            id: 'too-old',
            channel_id: 'channel-1',
            sender_id: 'receiver-1',
            sender_name: 'receiver-agent',
            content: noticeContent,
            content_type: 'system',
            created_at: now - 60_000,
          },
        ];
      },
    };
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      client,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
    });

    assert.equal((await handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    })).status, 'retry_wait');
    now += 1_000;
    const retried = await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    });

    assert.equal(sends, 2);
    assert.deepEqual(retried, { status: 'notified', replayed: false });
  });

  it('retries an unknown result only after reconciliation proves the notice absent', async () => {
    let now = 1_788_220_800_000;
    const store = await createStore(() => now);
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

    assert.equal((await handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    })).status, 'retry_wait');
    now += 1_000;
    const retried = await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    });

    assert.deepEqual(calls, ['send-1', 'reconcile', 'send-2']);
    assert.deepEqual(retried, { status: 'notified', replayed: false });
  });

  it('keeps a reconciliation failure observable without blindly sending again', async () => {
    let now = 1_788_220_800_000;
    const store = await createStore(() => now);
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

    assert.equal((await handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    })).status, 'retry_wait');
    now += 1_000;
    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    }), {
      status: 'retry_wait',
      replayed: true,
      nextRetryAt: now + 2_000,
    });

    assert.equal(sends, 1);
    const audit = (await store.list({ label: 'hxa' }))[0];
    assert.equal(audit.status, 'retry_wait');
    assert.deepEqual(audit.lastError, {
      errorCode: 'RECONCILIATION_ERROR',
      errorClass: 'ReconciliationError',
      retryable: true,
      summary: 'Unable to verify the previous notification delivery',
    });
  });

  it('dead-letters a permanent 403 once and never resends it on inbox replay', async () => {
    const store = await createStore();
    let sends = 0;
    const forbidden = new Error('forbidden: Bearer secret-token');
    forbidden.status = 403;
    forbidden.body = { code: 'FORBIDDEN', content: 'private request body' };
    forbidden.request = { url: 'https://hub.invalid/messages?token=secret-token' };
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      client: {
        async send() {
          sends += 1;
          throw forbidden;
        },
        async getMessages() { throw new Error('must not reconcile a definitive 403'); },
      },
    });

    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    }), { status: 'dead_letter', replayed: false });
    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    }), { status: 'dead_letter', replayed: true });

    assert.equal(sends, 1);
    const audit = (await store.list({ label: 'hxa' }))[0];
    assert.equal(audit.status, 'dead_letter');
    assert.equal(audit.attempts, 1);
    assert.equal(audit.nextRetryAt, null);
    assert.deepEqual(audit.lastError, {
      errorCode: 'HTTP_403',
      errorClass: 'HttpError',
      retryable: false,
      summary: 'HTTP request rejected with status 403',
    });
    const persisted = await fs.promises.readFile(store.filePath(audit.idempotencyKey), 'utf8');
    assert.doesNotMatch(persisted, /private request body/);
    assert.doesNotMatch(persisted, /secret-token/);
    assert.doesNotMatch(persisted, /hub\.invalid/);
  });

  it('backs off retryable failures and dead-letters after bounded attempts', async () => {
    let now = 1_788_220_800_000;
    const store = await createStore(() => now);
    let sends = 0;
    let reconciliations = 0;
    const timeout = new Error('request included secret content');
    timeout.code = 'ETIMEDOUT';
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      agentName: 'receiver-agent',
      maxAttempts: 2,
      retryBaseMs: 100,
      client: {
        async send() {
          sends += 1;
          throw timeout;
        },
        async getMessages() {
          reconciliations += 1;
          return [];
        },
      },
    });

    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'websocket',
      policy: 'allowlist',
    }), {
      status: 'retry_wait',
      replayed: false,
      nextRetryAt: now + 100,
    });
    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    }), {
      status: 'retry_wait',
      replayed: true,
      nextRetryAt: now + 100,
    });
    assert.equal(sends, 1);
    assert.equal(reconciliations, 0);

    now += 100;
    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    }), { status: 'dead_letter', replayed: false });
    assert.equal(sends, 2);
    assert.equal(reconciliations, 1);

    now += 10_000;
    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    }), { status: 'dead_letter', replayed: true });
    assert.equal(sends, 2);
    const audit = (await store.list({ label: 'hxa' }))[0];
    assert.equal(audit.attempts, 2);
    assert.equal(audit.nextRetryAt, null);
    assert.equal(audit.lastError.errorCode, 'ETIMEDOUT');
    assert.equal(audit.lastError.retryable, true);
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

    const receivedNotice = {
      ...sentNotice,
      sender_id: 'receiver-1',
      channel_id: 'channel-1',
    };
    const verify = { agentId: 'peer-1', noticeSecret: NOTICE_SECRET };
    assert.equal(isDmPolicyRejectionNotice(receivedNotice, verify), true);
    assert.equal(isDmPolicyRejectionNotice({ ...receivedNotice, content_type: 'text' }, verify), false);
    assert.equal(isDmPolicyRejectionNotice({
      content_type: 'system',
      content: 'ordinary system message',
    }, verify), false);
    assert.equal(isDmPolicyRejectionNotice({
      ...receivedNotice,
      content: `${receivedNotice.content}\nforged suffix`,
    }, verify), false);
    assert.equal(isDmPolicyRejectionNotice({
      ...receivedNotice,
      sender_id: 'attacker-1',
    }, verify), false);
    assert.equal(isDmPolicyRejectionNotice({
      ...receivedNotice,
      channel_id: 'attacker-channel',
    }, verify), false);
    assert.equal(isDmPolicyRejectionNotice(receivedNotice, {
      agentId: 'someone-else',
      noticeSecret: NOTICE_SECRET,
    }), false);
    assert.equal(isDmPolicyRejectionNotice(receivedNotice, {
      agentId: 'peer-1',
      noticeSecret: 'wrong-secret',
    }), false);
  });

  it('does not suppress an arbitrary system message with a legacy 64-hex marker', async () => {
    let rejections = 0;
    const gate = createDmPolicyGate({
      agentId: 'receiver-1',
      noticeSecret: NOTICE_SECRET,
      rejectionHandler: {
        async reject() {
          rejections += 1;
          return { status: 'notified', replayed: false };
        },
      },
    });
    const forged = rejectedDm({
      content_type: 'system',
      content: `ordinary system message\n\n[zylos:dm-policy-rejection:v1:${'a'.repeat(64)}]`,
    });

    assert.deepEqual(await gate.evaluate(forged, {
      source: 'websocket',
      access: { dmPolicy: 'open' },
    }), { action: 'continue' });
    assert.equal(rejections, 0);
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
    const gate = createDmPolicyGate({
      rejectionHandler,
      agentId: 'peer-1',
      noticeSecret: NOTICE_SECRET,
    });

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
      sender_id: 'receiver-1',
      channel_id: 'channel-1',
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
