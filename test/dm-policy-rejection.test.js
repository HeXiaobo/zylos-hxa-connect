import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

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

function runLockWorker(directory, workerId) {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'src/lib/dm-policy-rejection.js')).href;
  const script = `
    import fs from 'node:fs';
    import { DmPolicyRejectionStore } from ${JSON.stringify(moduleUrl)};
    const [directory, workerId] = process.argv.slice(1);
    const store = new DmPolicyRejectionStore({ directory });
    for (let iteration = 0; iteration < 20; iteration += 1) {
      await store.withLock('six-process-lock', async () => {
        const criticalPath = directory + '/critical-section';
        const handle = await fs.promises.open(criticalPath, 'wx', 0o600);
        await new Promise(resolve => setTimeout(resolve, 2));
        await handle.close();
        await fs.promises.unlink(criticalPath);
      }, { timeoutMs: 10_000 });
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, directory, workerId], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  return {
    child,
    completed: new Promise(resolve => child.on('close', code => resolve({ code, stderr }))),
  };
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
  it('publishes complete lock metadata atomically across six competing processes', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-dm-policy-lock-'));
    tempDirs.push(directory);
    const workers = Array.from({ length: 6 }, (_, index) => runLockWorker(directory, String(index)));
    const parseFailures = [];

    while (workers.some(({ child }) => child.exitCode === null)) {
      const lockNames = (await fs.promises.readdir(directory)).filter(name => name.endsWith('.lock'));
      for (const name of lockNames) {
        try {
          const metadata = JSON.parse(await fs.promises.readFile(path.join(directory, name), 'utf8'));
          assert.equal(Number.isSafeInteger(metadata.pid), true);
          assert.match(metadata.token, /^[0-9a-f-]{36}$/);
        } catch (error) {
          if (error.code !== 'ENOENT') parseFailures.push(error);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    const results = await Promise.all(workers.map(worker => worker.completed));
    assert.deepEqual(parseFailures, []);
    assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0, 0, 0],
      results.map(result => result.stderr).join('\n'));
    assert.deepEqual((await fs.promises.readdir(directory)).filter(name => name.endsWith('.lock')), []);
  });

  it('fails closed on damaged lock metadata and recovers only a verifiably stale owner', async () => {
    const store = await createStore();
    const damagedCases = [
      { key: 'damaged-lock', content: '' },
      { key: 'half-written-lock', content: '{"schemaVersion":1,"pid":' },
      {
        key: 'parseable-incomplete-lock',
        content: `${JSON.stringify({
          schemaVersion: 1,
          pid: 2_147_483_647,
          token: 'truncated-token',
        })}\n`,
      },
    ];

    for (const lockCase of damagedCases) {
      const lockPath = `${store.filePath(lockCase.key)}.lock`;
      await fs.promises.writeFile(lockPath, lockCase.content, { mode: 0o600 });
      const old = new Date(Date.now() - 10_000);
      await fs.promises.utimes(lockPath, old, old);
      await assert.rejects(
        store.withLock(lockCase.key, async () => {
          assert.fail('damaged owner metadata must never be stolen');
        }, { timeoutMs: 150 }),
        error => error?.code === 'HXA_DM_POLICY_REJECTION_BUSY',
        lockCase.key,
      );
      assert.equal(await fs.promises.readFile(lockPath, 'utf8'), lockCase.content);
      await fs.promises.unlink(lockPath);
    }

    const staleKey = 'stale-lock';
    const stalePath = `${store.filePath(staleKey)}.lock`;
    await fs.promises.writeFile(stalePath, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: '10000000-0000-4000-8000-000000000001',
      createdAt: 1,
    })}\n`, { mode: 0o600 });
    let entered = false;
    await store.withLock(staleKey, async () => { entered = true; }, { timeoutMs: 2_000 });
    assert.equal(entered, true);
    await assert.rejects(fs.promises.stat(stalePath), { code: 'ENOENT' });
  });

  it('recovers the lock after its owning process is killed', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-dm-policy-killed-lock-'));
    tempDirs.push(directory);
    const readyPath = path.join(directory, 'owner-ready');
    const moduleUrl = pathToFileURL(path.join(ROOT, 'src/lib/dm-policy-rejection.js')).href;
    const script = `
      import fs from 'node:fs';
      import { DmPolicyRejectionStore } from ${JSON.stringify(moduleUrl)};
      const [directory, readyPath] = process.argv.slice(1);
      const store = new DmPolicyRejectionStore({ directory });
      await store.withLock('killed-owner-lock', async () => {
        await fs.promises.writeFile(readyPath, 'ready', { mode: 0o600 });
        await new Promise(() => {});
      });
    `;
    const owner = spawn(process.execPath, [
      '--input-type=module', '--eval', script, directory, readyPath,
    ], { stdio: 'ignore' });
    const ownerClosed = new Promise(resolve => owner.on('close', resolve));
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(readyPath) && owner.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(readyPath), true, 'owner never acquired the lock');
    owner.kill('SIGKILL');
    await ownerClosed;

    const restarted = new DmPolicyRejectionStore({ directory });
    let entered = false;
    await restarted.withLock('killed-owner-lock', async () => { entered = true; }, { timeoutMs: 2_000 });

    assert.equal(entered, true);
    assert.deepEqual((await fs.promises.readdir(directory)).filter(name => name.endsWith('.lock')), []);
  });

  it('does not let a former owner release a replacement lock', async () => {
    const store = await createStore();
    const key = 'replacement-owner-lock';
    const lockPath = `${store.filePath(key)}.lock`;
    const replacement = {
      schemaVersion: 1,
      pid: process.pid,
      token: 'replacement-owner-token',
      createdAt: Date.now(),
    };

    await store.withLock(key, async () => {
      const displacedPath = `${lockPath}.displaced`;
      await fs.promises.rename(lockPath, displacedPath);
      await fs.promises.writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
      await fs.promises.unlink(displacedPath);
    });

    assert.deepEqual(JSON.parse(await fs.promises.readFile(lockPath, 'utf8')), replacement);
    await fs.promises.unlink(lockPath);
  });

  it('enforces private directory and audit-file modes when the store starts', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-dm-policy-modes-'));
    tempDirs.push(directory);
    await fs.promises.chmod(directory, 0o777);
    let store = new DmPolicyRejectionStore({ directory });
    assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o700);

    const record = await store.begin({
      idempotencyKey: 'mode-test',
      label: 'hxa',
      messageId: 'mode-message',
      source: 'websocket',
      sender: 'peer-agent',
      senderId: 'peer-1',
      senderKey: 'sender-key',
      timestamp: 1_788_220_799_000,
      reason: 'dm_policy',
      policy: 'allowlist',
      channelId: 'channel-1',
    });
    const auditPath = store.filePath(record.idempotencyKey);
    await fs.promises.chmod(auditPath, 0o666);

    store = new DmPolicyRejectionStore({ directory });
    assert.equal((await fs.promises.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.promises.stat(auditPath)).mode & 0o777, 0o600);
  });

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

  it('reconciles an ambiguous notice signed by the previous key after rotation', async () => {
    let now = 1_788_220_800_000;
    const store = await createStore(() => now);
    const history = [];
    let sends = 0;
    const client = {
      async send(target, content, options) {
        sends += 1;
        if (sends === 1) {
          history.push({
            id: 'old-key-notice',
            channel_id: 'channel-1',
            sender_id: 'receiver-1',
            content,
            content_type: options.content_type,
            created_at: now + 10,
          });
          throw new Error('ambiguous old-key delivery');
        }
        return { channel_id: 'channel-1', message: { id: 'duplicate-new-key-notice' } };
      },
      async getMessages() { return history; },
    };
    const oldHandler = createBaseDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      client,
      agentId: 'receiver-1',
      noticeSecret: 'old-rotation-secret',
    });
    assert.equal((await oldHandler.reject(rejectedDm({ id: 'rotation-ambiguous' }), {
      source: 'websocket',
      policy: 'allowlist',
    })).status, 'retry_wait');
    now += 1_000;

    const restarted = createBaseDmPolicyRejectionHandler({
      label: 'hxa',
      store: new DmPolicyRejectionStore({ directory: store.directory, clock: store.clock }),
      client,
      agentId: 'receiver-1',
      noticeSecrets: {
        current: 'new-rotation-secret',
        previous: ['old-rotation-secret'],
      },
    });
    assert.deepEqual(await restarted.reject(rejectedDm({ id: 'rotation-ambiguous' }), {
      source: 'inbox',
      policy: 'allowlist',
    }), { status: 'notified', replayed: true, reconciled: true });
    assert.equal(sends, 1);
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

  it('keeps an exact reconciliation candidate unknown when its external message id is empty', async () => {
    let now = 1_788_220_800_000;
    const store = await createStore(() => now);
    let sends = 0;
    let noticeContent;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      client: {
        async send(target, content) {
          sends += 1;
          noticeContent = content;
          throw new Error('ambiguous delivery');
        },
        async getMessages() {
          return [{
            id: '   ',
            channel_id: 'channel-1',
            sender_id: 'receiver-1',
            content: noticeContent,
            content_type: 'system',
            created_at: now,
          }];
        },
      },
    });
    assert.equal((await handler.reject(rejectedDm({ id: 'missing-external-id' }), {
      source: 'websocket',
      policy: 'allowlist',
    })).status, 'retry_wait');
    now += 1_000;

    assert.deepEqual(await handler.reject(rejectedDm({ id: 'missing-external-id' }), {
      source: 'inbox',
      policy: 'allowlist',
    }), {
      status: 'retry_wait',
      replayed: true,
      nextRetryAt: now + 2_000,
    });
    assert.equal(sends, 1);
    const [audit] = await store.list({ label: 'hxa' });
    assert.equal(audit.noticeMessageId, null);
    assert.deepEqual(audit.lastError, {
      errorCode: 'DELIVERY_RECEIPT_MISSING',
      errorClass: 'DeliveryReceiptError',
      retryable: true,
      summary: 'Hub did not return a verifiable notification receipt',
    });
  });

  it('rejects same-message replays with a different sender, channel, or policy before I/O or audit mutation', async () => {
    const variants = [
      { name: 'sender', message: { sender_id: 'attacker-1' }, policy: 'allowlist' },
      { name: 'channel', message: { channel_id: 'attacker-channel' }, policy: 'allowlist' },
      { name: 'policy', message: {}, policy: 'disabled' },
    ];

    for (const variant of variants) {
      let now = 1_788_220_800_000;
      const store = await createStore(() => now);
      let sends = 0;
      let reconciliations = 0;
      const handler = createDmPolicyRejectionHandler({
        label: 'hxa',
        store,
        agentId: 'receiver-1',
        client: {
          async send() {
            sends += 1;
            throw new Error('ambiguous delivery');
          },
          async getMessages() {
            reconciliations += 1;
            return [];
          },
        },
      });
      assert.equal((await handler.reject(rejectedDm({ id: `identity-${variant.name}` }), {
        source: 'websocket',
        policy: 'allowlist',
      })).status, 'retry_wait');
      const [audit] = await store.list({ label: 'hxa' });
      const auditPath = store.filePath(audit.idempotencyKey);
      const before = await fs.promises.readFile(auditPath, 'utf8');
      now += 1_000;

      const result = await handler.reject(rejectedDm({
        id: `identity-${variant.name}`,
        ...variant.message,
      }), {
        source: 'inbox',
        policy: variant.policy,
      });

      assert.deepEqual(result, {
        status: 'identity_conflict',
        replayed: true,
        errorCode: 'IDENTITY_CONFLICT',
      }, variant.name);
      assert.equal(sends, 1, variant.name);
      assert.equal(reconciliations, 0, variant.name);
      assert.equal(await fs.promises.readFile(auditPath, 'utf8'), before, variant.name);
    }
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

  it('treats undefined or identity-free send receipts as unknown until strict reconciliation', async () => {
    const receipts = [
      { name: 'undefined', value: undefined },
      { name: 'missing identity', value: { message: {} } },
      { name: 'missing channel', value: { message: { id: 'notice-without-channel' } } },
    ];

    for (const receiptCase of receipts) {
      let now = 1_788_220_800_000;
      const store = await createStore(() => now);
      let sends = 0;
      let content;
      const history = [];
      const handler = createDmPolicyRejectionHandler({
        label: 'hxa',
        store,
        agentId: 'receiver-1',
        client: {
          async send(target, sentContent) {
            sends += 1;
            content = sentContent;
            return receiptCase.value;
          },
          async getMessages() { return history; },
        },
      });

      assert.deepEqual(await handler.reject(rejectedDm({ id: `receipt-${receiptCase.name}` }), {
        source: 'websocket',
        policy: 'allowlist',
      }), {
        status: 'retry_wait',
        replayed: false,
        nextRetryAt: now + 1_000,
      }, receiptCase.name);
      const [unknown] = await store.list({ label: 'hxa' });
      assert.equal(unknown.noticeMessageId, null, receiptCase.name);
      assert.deepEqual(unknown.lastError, {
        errorCode: 'DELIVERY_RECEIPT_MISSING',
        errorClass: 'DeliveryReceiptError',
        retryable: true,
        summary: 'Hub did not return a verifiable notification receipt',
      });

      now += 1_000;
      history.push({
        id: `notice-${receiptCase.name}`,
        channel_id: 'channel-1',
        sender_id: 'receiver-1',
        content,
        content_type: 'system',
        created_at: now,
      });
      assert.deepEqual(await handler.reject(rejectedDm({ id: `receipt-${receiptCase.name}` }), {
        source: 'inbox',
        policy: 'allowlist',
      }), { status: 'notified', replayed: true, reconciled: true });
      assert.equal(sends, 1, receiptCase.name);
    }
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

  it('performs a final reconciliation after the last ambiguous send attempt', async () => {
    let now = 1_788_220_800_000;
    const store = await createStore(() => now);
    const history = [];
    let sends = 0;
    let reconciliations = 0;
    const handler = createDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      maxAttempts: 1,
      retryBaseMs: 100,
      client: {
        async send(target, content, options) {
          sends += 1;
          history.push({
            id: 'final-attempt-notice',
            channel_id: 'channel-1',
            sender_id: 'receiver-1',
            content,
            content_type: options.content_type,
            created_at: now + 1,
          });
          throw new Error('ambiguous final attempt');
        },
        async getMessages() {
          reconciliations += 1;
          return history;
        },
      },
    });

    assert.deepEqual(await handler.reject(rejectedDm({ id: 'final-ambiguous' }), {
      source: 'websocket',
      policy: 'allowlist',
    }), {
      status: 'retry_wait',
      replayed: false,
      nextRetryAt: now + 100,
    });
    now += 100;
    assert.deepEqual(await handler.reject(rejectedDm({ id: 'final-ambiguous' }), {
      source: 'inbox',
      policy: 'allowlist',
    }), { status: 'notified', replayed: true, reconciled: true });
    assert.equal(sends, 1);
    assert.equal(reconciliations, 1);
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
    }), {
      status: 'retry_wait',
      replayed: false,
      nextRetryAt: now + 200,
    });
    assert.equal(sends, 2);
    assert.equal(reconciliations, 1);

    now += 200;
    assert.deepEqual(await handler.reject(rejectedDm(), {
      source: 'inbox',
      policy: 'allowlist',
    }), { status: 'dead_letter', replayed: true });
    assert.equal(sends, 2);
    assert.equal(reconciliations, 2);
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

  it('fails closed before any send or DM routing when the current notice secret is missing', async () => {
    const store = await createStore();
    let sends = 0;
    let rejections = 0;
    assert.throws(() => createBaseDmPolicyRejectionHandler({
      label: 'hxa',
      store,
      agentId: 'receiver-1',
      client: {
        async send() { sends += 1; },
      },
    }), error => error?.code === 'HXA_DM_POLICY_NOTICE_SECRET_REQUIRED');
    assert.throws(() => createDmPolicyGate({
      agentId: 'receiver-1',
      rejectionHandler: {
        async reject() { rejections += 1; },
      },
    }), error => error?.code === 'HXA_DM_POLICY_NOTICE_SECRET_REQUIRED');

    assert.equal(sends, 0);
    assert.equal(rejections, 0);
    assert.deepEqual(await store.list({ label: 'hxa' }), []);
  });

  it('verifies previous-key notices during rotation but signs new notices only with current', async () => {
    const oldSecret = 'old-shared-notice-secret';
    const newSecret = 'new-shared-notice-secret';
    const oldStore = await createStore();
    let oldNotice;
    const oldHandler = createBaseDmPolicyRejectionHandler({
      label: 'hxa',
      store: oldStore,
      agentId: 'receiver-1',
      noticeSecret: oldSecret,
      client: {
        async send(target, content, options) {
          oldNotice = {
            content,
            content_type: options.content_type,
            sender_id: 'receiver-1',
            channel_id: 'channel-1',
          };
          return { channel_id: 'channel-1', message: { id: 'old-notice' } };
        },
      },
    });
    await oldHandler.reject(rejectedDm({ id: 'old-source' }), {
      source: 'websocket',
      policy: 'allowlist',
    });

    const rotation = {
      agentId: 'peer-1',
      noticeSecrets: { current: newSecret, previous: [oldSecret] },
    };
    assert.equal(isDmPolicyRejectionNotice(oldNotice, rotation), true);
    assert.equal(isDmPolicyRejectionNotice(oldNotice, {
      agentId: 'peer-1',
      noticeSecrets: { current: newSecret, previous: [] },
    }), false);
    let crossAgentReplies = 0;
    const rotatingPeerGate = createDmPolicyGate({
      agentId: 'peer-1',
      noticeSecrets: { current: newSecret, previous: [oldSecret] },
      rejectionHandler: {
        async reject() {
          crossAgentReplies += 1;
          return { status: 'notified', replayed: false };
        },
      },
    });
    assert.deepEqual(await rotatingPeerGate.evaluate(oldNotice, {
      source: 'websocket',
      access: { dmPolicy: 'allowlist', dmAllowFrom: [] },
    }), { action: 'discarded', reason: 'dm_policy_rejection_notice' });
    assert.equal(crossAgentReplies, 0);

    const newStore = await createStore();
    let newNotice;
    const newHandler = createBaseDmPolicyRejectionHandler({
      label: 'hxa',
      store: newStore,
      agentId: 'receiver-1',
      noticeSecrets: { current: newSecret, previous: [oldSecret] },
      client: {
        async send(target, content, options) {
          newNotice = {
            content,
            content_type: options.content_type,
            sender_id: 'receiver-1',
            channel_id: 'channel-1',
          };
          return { channel_id: 'channel-1', message: { id: 'new-notice' } };
        },
      },
    });
    await newHandler.reject(rejectedDm({ id: 'new-source' }), {
      source: 'websocket',
      policy: 'allowlist',
    });

    assert.equal(isDmPolicyRejectionNotice(newNotice, {
      agentId: 'peer-1',
      noticeSecret: newSecret,
    }), true);
    assert.equal(isDmPolicyRejectionNotice(newNotice, {
      agentId: 'peer-1',
      noticeSecret: oldSecret,
    }), false);
    const persisted = await fs.promises.readFile(
      newStore.filePath((await newStore.list({ label: 'hxa' }))[0].idempotencyKey),
      'utf8',
    );
    assert.doesNotMatch(persisted, /old-shared-notice-secret|new-shared-notice-secret/);
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
