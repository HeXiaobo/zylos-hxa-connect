import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDmAllowed } from './auth.js';

const REJECTION_MARKER = '[zylos:dm-policy-rejection:v1:';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function writeAtomic(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

function rejectionContent(idempotencyKey) {
  const digest = idempotencyKey.slice(idempotencyKey.lastIndexOf('.') + 1);
  return "Sorry, I'm not available for private messages. Please ask my owner to grant you access.\n\n"
    + `${REJECTION_MARKER}${digest}]`;
}

export function isDmPolicyRejectionNotice(message) {
  return message?.content_type === 'system'
    && typeof message?.content === 'string'
    && /\[zylos:dm-policy-rejection:v1:[a-f0-9]{64}\]$/.test(message.content);
}

export function decideDmPolicy(access, message) {
  if (isDmPolicyRejectionNotice(message)) return 'notice';
  return isDmAllowed(access, message?.sender_name || message?.sender_id) ? 'allow' : 'reject';
}

export function createDmPolicyGate({ rejectionHandler } = {}) {
  if (!rejectionHandler || typeof rejectionHandler.reject !== 'function') {
    throw new TypeError('DM policy rejection handler is required');
  }
  return Object.freeze({
    async evaluate(message, { source, access } = {}) {
      const decision = decideDmPolicy(access, message);
      if (decision === 'allow') return { action: 'continue' };
      if (decision === 'notice') {
        return { action: 'discarded', reason: 'dm_policy_rejection_notice' };
      }
      const notification = await rejectionHandler.reject(message, {
        source,
        policy: access?.dmPolicy || 'open',
      });
      return {
        action: 'discarded',
        reason: 'dm_policy',
        notificationStatus: notification.status,
        notificationReplayed: notification.replayed,
      };
    },
  });
}

export class DmPolicyRejectionStore {
  constructor({ directory, clock = () => Date.now() } = {}) {
    this.directory = requireText(directory, 'DM policy rejection directory');
    this.clock = clock;
  }

  filePath(idempotencyKey) {
    return path.join(this.directory, `${sha256(idempotencyKey)}.json`);
  }

  async withLock(idempotencyKey, callback, { timeoutMs = 5_000 } = {}) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath(idempotencyKey)}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        const handle = await fs.promises.open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
        await handle.close();
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const owner = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
          if (!processAlive(owner.pid)) {
            await fs.promises.unlink(lockPath);
            continue;
          }
        } catch (readError) {
          if (readError.code === 'ENOENT') continue;
          throw readError;
        }
        if (Date.now() >= deadline) {
          const busy = new Error('DM policy rejection delivery is busy');
          busy.code = 'HXA_DM_POLICY_REJECTION_BUSY';
          throw busy;
        }
        await sleep(25);
      }
    }
    try {
      return await callback();
    } finally {
      try {
        const owner = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        if (owner.token === token) await fs.promises.unlink(lockPath);
      } catch {
        // The durable audit remains canonical even if a lock disappeared.
      }
    }
  }

  async begin(record) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(record.idempotencyKey);
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const now = this.clock();
    const prepared = {
      schemaVersion: 1,
      ...record,
      status: 'prepared',
      attempts: 0,
      startedAt: now,
      updatedAt: now,
      noticeMessageId: null,
      channelId: record.channelId || null,
      lastError: null,
    };
    await writeAtomic(filePath, prepared);
    return prepared;
  }

  async update(record, changes) {
    const next = { ...record, ...changes, updatedAt: this.clock() };
    await writeAtomic(this.filePath(record.idempotencyKey), next);
    return next;
  }

  async list({ label } = {}) {
    const names = await fs.promises.readdir(this.directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records = await Promise.all(names
      .filter(name => name.endsWith('.json'))
      .map(async name => JSON.parse(await fs.promises.readFile(path.join(this.directory, name), 'utf8'))));
    return records
      .filter(record => !label || record.label === label)
      .sort((left, right) => right.timestamp - left.timestamp);
  }
}

export function createDmPolicyRejectionHandler({
  label,
  store,
  client,
  agentId,
  agentName,
  noticeIntervalMs = 60_000,
} = {}) {
  const safeLabel = requireText(label, 'HXA org label');
  if (!(store instanceof DmPolicyRejectionStore)) {
    throw new TypeError('DM policy rejection store is required');
  }
  if (!client || typeof client.send !== 'function') {
    throw new TypeError('HXA client with send() is required');
  }

  return Object.freeze({
    async reject(message, { source, policy } = {}) {
      const messageId = requireText(message?.id, 'rejected DM message id');
      const sender = requireText(message?.sender_name || message?.sender_id, 'rejected DM sender');
      const safePolicy = requireText(policy, 'DM policy');
      const senderIdentity = message.sender_id || sender;
      const idempotencyKey = `hxa.dm-policy-rejection.v1.${sha256(`${safeLabel}\0${messageId}\0dm_policy`)}`;
      const senderPolicyKey = `hxa.dm-policy-rejection-rate.v1.${sha256(`${safeLabel}\0${senderIdentity}\0${safePolicy}`)}`;
      return store.withLock(senderPolicyKey, () => store.withLock(idempotencyKey, async () => {
        let record = await store.begin({
          idempotencyKey,
          label: safeLabel,
          messageId,
          source: requireText(source, 'rejected DM source'),
          sender,
          senderKey: sha256(senderIdentity),
          timestamp: Number.isFinite(message.created_at) ? message.created_at : store.clock(),
          reason: 'dm_policy',
          policy: safePolicy,
          channelId: message.channel_id || null,
        });
        if (record.status === 'notified' || record.status === 'rate_limited') {
          return { status: record.status, replayed: true };
        }
        const content = rejectionContent(idempotencyKey);
        if (record.attempts > 0) {
          try {
            if (!record.channelId || typeof client.getMessages !== 'function') {
              throw new Error('DM policy rejection cannot reconcile without channel history');
            }
            const messages = await client.getMessages(record.channelId, {
              since: Math.max(0, record.startedAt - 5_000),
            });
            if (!Array.isArray(messages)) {
              throw new TypeError('Hub channel messages response must be an array');
            }
            const existing = messages.find(candidate => (
              candidate?.content === content
              && candidate?.content_type === 'system'
              && (candidate?.sender_id === agentId || candidate?.sender_name === agentName)
            ));
            if (existing) {
              record = await store.update(record, {
                status: 'notified',
                noticeMessageId: existing.id || null,
                channelId: existing.channel_id || record.channelId,
                lastError: null,
              });
              return { status: record.status, replayed: true, reconciled: true };
            }
          } catch (error) {
            await store.update(record, {
              status: 'uncertain',
              lastError: String(error?.message || error).slice(0, 500),
            });
            throw error;
          }
        }
        const recentForSenderAndPolicy = (await store.list({ label: safeLabel })).some(candidate => (
          candidate.idempotencyKey !== record.idempotencyKey
          && candidate.senderKey === record.senderKey
          && candidate.policy === record.policy
          && ['prepared', 'sending', 'uncertain', 'notified'].includes(candidate.status)
          && candidate.startedAt >= record.startedAt - noticeIntervalMs
        ));
        if (recentForSenderAndPolicy) {
          record = await store.update(record, {
            status: 'rate_limited',
            lastError: null,
          });
          return { status: record.status, replayed: false };
        }
        record = await store.update(record, {
          status: 'sending',
          attempts: record.attempts + 1,
        });
        let receipt;
        try {
          receipt = await client.send(
            message.sender_id || sender,
            content,
            { content_type: 'system' },
          );
        } catch (error) {
          await store.update(record, {
            status: 'uncertain',
            lastError: String(error?.message || error).slice(0, 500),
          });
          throw error;
        }
        record = await store.update(record, {
          status: 'notified',
          noticeMessageId: receipt?.message?.id || null,
          channelId: receipt?.channel_id || receipt?.message?.channel_id || record.channelId,
          lastError: null,
        });
        return { status: record.status, replayed: false };
      }));
    },
  });
}
