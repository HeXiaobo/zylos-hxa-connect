import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDmAllowed } from './auth.js';

const REJECTION_TEXT = "Sorry, I'm not available for private messages. Please ask my owner to grant you access.";
const REJECTION_MARKER_PATTERN = /^\[zylos:dm-policy-rejection:v2:([A-Za-z0-9_-]+):([a-f0-9]{64})\]$/;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429]);
const SAFE_NETWORK_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireCurrentNoticeSecret(value) {
  try {
    return requireText(value, 'HXA_DM_POLICY_NOTICE_SECRET');
  } catch {
    const error = new Error('HXA_DM_POLICY_NOTICE_SECRET is required for safe DM rejection handling');
    error.code = 'HXA_DM_POLICY_NOTICE_SECRET_REQUIRED';
    throw error;
  }
}

function normalizeNoticeSecrets({ noticeSecret, noticeSecrets } = {}, { required = false } = {}) {
  const current = noticeSecrets?.current ?? noticeSecret;
  if (required) requireCurrentNoticeSecret(current);
  if (typeof current !== 'string' || current.trim() === '') return null;
  const configuredPrevious = noticeSecrets?.previous ?? [];
  const previous = typeof configuredPrevious === 'string'
    ? [configuredPrevious]
    : configuredPrevious;
  if (!Array.isArray(previous)
    || previous.some(secret => typeof secret !== 'string' || secret.trim() === '')) {
    if (!required) return null;
    const error = new TypeError('DM policy rejection previous notice secrets must be non-empty strings');
    error.code = 'HXA_DM_POLICY_NOTICE_PREVIOUS_SECRET_INVALID';
    throw error;
  }
  return {
    current,
    verification: [current, ...previous.filter(secret => secret !== current)],
  };
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

async function publishCompleteLock(lockPath, owner) {
  const candidatePath = `${lockPath}.candidate.${process.pid}.${owner.token}`;
  try {
    const handle = await fs.promises.open(candidatePath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.link(candidatePath, lockPath);
    return await fs.promises.stat(lockPath);
  } finally {
    await fs.promises.unlink(candidatePath).catch(() => {});
  }
}

async function observeLock(lockPath) {
  try {
    const [raw, stat] = await Promise.all([
      fs.promises.readFile(lockPath, 'utf8'),
      fs.promises.stat(lockPath),
    ]);
    let owner = null;
    try {
      const candidate = JSON.parse(raw);
      if (candidate?.schemaVersion === 1
        && Number.isSafeInteger(candidate?.pid)
        && candidate.pid > 0
        && typeof candidate?.token === 'string'
        && LOCK_TOKEN_PATTERN.test(candidate.token)
        && Number.isSafeInteger(candidate?.createdAt)
        && candidate.createdAt > 0) owner = candidate;
    } catch {
      // Invalid owner metadata remains fail-closed because liveness cannot be proven.
    }
    return { raw, stat, owner };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkObservedLock(lockPath, observed) {
  const current = await observeLock(lockPath);
  if (!current
    || current.stat.dev !== observed.stat.dev
    || current.stat.ino !== observed.stat.ino
    || current.raw !== observed.raw) return false;
  try {
    await fs.promises.unlink(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeDeliveryError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (status !== null) {
    const retryable = status >= 500 || RETRYABLE_HTTP_STATUSES.has(status);
    return {
      errorCode: `HTTP_${status}`,
      errorClass: 'HttpError',
      retryable,
      summary: `HTTP request rejected with status ${status}`,
    };
  }
  const networkCode = SAFE_NETWORK_CODES.has(error?.code) ? error.code : null;
  return {
    errorCode: networkCode || 'TRANSPORT_ERROR',
    errorClass: networkCode ? 'NetworkError' : 'TransportError',
    retryable: true,
    summary: networkCode
      ? `Transport request failed (${networkCode})`
      : 'Transport request failed',
  };
}

function safeReconciliationError() {
  return {
    errorCode: 'RECONCILIATION_ERROR',
    errorClass: 'ReconciliationError',
    retryable: true,
    summary: 'Unable to verify the previous notification delivery',
  };
}

function safeMissingReceiptError() {
  return {
    errorCode: 'DELIVERY_RECEIPT_MISSING',
    errorClass: 'DeliveryReceiptError',
    retryable: true,
    summary: 'Hub did not return a verifiable notification receipt',
  };
}

export function publicDmPolicyRejectionError(error) {
  if (!error || typeof error !== 'object') return null;
  if (/^HTTP_[1-5][0-9]{2}$/.test(error.errorCode)) {
    const status = Number.parseInt(error.errorCode.slice(5), 10);
    return {
      errorCode: error.errorCode,
      errorClass: 'HttpError',
      retryable: status >= 500 || RETRYABLE_HTTP_STATUSES.has(status),
      summary: `HTTP request rejected with status ${status}`,
    };
  }
  if (error.errorCode === 'RECONCILIATION_ERROR') return safeReconciliationError();
  if (error.errorCode === 'DELIVERY_RECEIPT_MISSING') return safeMissingReceiptError();
  if (SAFE_NETWORK_CODES.has(error.errorCode)) {
    return {
      errorCode: error.errorCode,
      errorClass: 'NetworkError',
      retryable: true,
      summary: `Transport request failed (${error.errorCode})`,
    };
  }
  if (error.errorCode === 'TRANSPORT_ERROR') {
    return {
      errorCode: 'TRANSPORT_ERROR',
      errorClass: 'TransportError',
      retryable: true,
      summary: 'Transport request failed',
    };
  }
  return null;
}

async function writeAtomic(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.promises.chmod(path.dirname(filePath), 0o700);
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

function signedRejectionContent({ noticeSecret, rejectorAgentId, targetAgentId, channelId, messageId, policy }) {
  const payload = {
    rejectorAgentId,
    targetAgentId,
    channelId,
    messageId,
    policy,
    reason: 'dm_policy',
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', noticeSecret).update(encoded).digest('hex');
  return `${REJECTION_TEXT}\n\n[zylos:dm-policy-rejection:v2:${encoded}:${signature}]`;
}

export function isDmPolicyRejectionNotice(message, options = {}) {
  const { agentId } = options;
  const secrets = normalizeNoticeSecrets(options);
  if (message?.content_type !== 'system'
    || typeof message?.content !== 'string'
    || typeof agentId !== 'string'
    || agentId === ''
    || !secrets) return false;
  const prefix = `${REJECTION_TEXT}\n\n`;
  if (!message.content.startsWith(prefix)) return false;
  const match = message.content.slice(prefix.length).match(REJECTION_MARKER_PATTERN);
  if (!match) return false;
  const [, encoded, providedSignature] = match;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const canonical = {
    rejectorAgentId: payload?.rejectorAgentId,
    targetAgentId: payload?.targetAgentId,
    channelId: payload?.channelId,
    messageId: payload?.messageId,
    policy: payload?.policy,
    reason: payload?.reason,
  };
  if (Object.values(canonical).some(value => typeof value !== 'string' || value === '')
    || canonical.reason !== 'dm_policy'
    || Buffer.from(JSON.stringify(canonical)).toString('base64url') !== encoded
    || canonical.rejectorAgentId !== message.sender_id
    || canonical.targetAgentId !== agentId
    || canonical.channelId !== message.channel_id) return false;
  const actualSignature = Buffer.from(providedSignature, 'hex');
  return secrets.verification.some(secret => {
    const expectedSignature = createHmac('sha256', secret).update(encoded).digest();
    return actualSignature.length === expectedSignature.length
      && timingSafeEqual(actualSignature, expectedSignature);
  });
}

export function decideDmPolicy(access, message) {
  return isDmAllowed(access, message?.sender_name || message?.sender_id) ? 'allow' : 'reject';
}

export function createDmPolicyGate({ rejectionHandler, agentId, noticeSecret, noticeSecrets } = {}) {
  if (!rejectionHandler || typeof rejectionHandler.reject !== 'function') {
    throw new TypeError('DM policy rejection handler is required');
  }
  const normalizedSecrets = normalizeNoticeSecrets({ noticeSecret, noticeSecrets }, { required: true });
  return Object.freeze({
    async evaluate(message, { source, access } = {}) {
      if (isDmPolicyRejectionNotice(message, {
        agentId,
        noticeSecrets: {
          current: normalizedSecrets.current,
          previous: normalizedSecrets.verification.slice(1),
        },
      })) {
        return { action: 'discarded', reason: 'dm_policy_rejection_notice' };
      }
      const decision = decideDmPolicy(access, message);
      if (decision === 'allow') return { action: 'continue' };
      const notification = await rejectionHandler.reject(message, {
        source,
        policy: access?.dmPolicy || 'open',
      });
      return {
        action: notification.status === 'retry_wait' ? 'retry' : 'discarded',
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
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        fs.chmodSync(path.join(this.directory, entry.name), 0o600);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  filePath(idempotencyKey) {
    return path.join(this.directory, `${sha256(idempotencyKey)}.json`);
  }

  async withLock(idempotencyKey, callback, {
    timeoutMs = 5_000,
  } = {}) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.directory, 0o700);
    const lockPath = `${this.filePath(idempotencyKey)}.lock`;
    const token = randomUUID();
    const owner = { schemaVersion: 1, pid: process.pid, token, createdAt: Date.now() };
    const deadline = Date.now() + timeoutMs;
    let acquiredStat;
    while (true) {
      try {
        acquiredStat = await publishCompleteLock(lockPath, owner);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const observed = await observeLock(lockPath);
        if (!observed) continue;
        if (observed.owner && !processAlive(observed.owner.pid)) {
          if (await unlinkObservedLock(lockPath, observed)) continue;
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
        const observed = await observeLock(lockPath);
        if (observed?.owner?.token === token
          && observed.stat.dev === acquiredStat.dev
          && observed.stat.ino === acquiredStat.ino) {
          await unlinkObservedLock(lockPath, observed);
        }
      } catch {
        // The durable audit remains canonical even if a lock disappeared.
      }
    }
  }

  async begin(record) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.directory, 0o700);
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
      nextRetryAt: null,
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
  noticeSecret,
  noticeSecrets,
  noticeIntervalMs = 60_000,
  maxAttempts = 3,
  retryBaseMs = 1_000,
  maxRetryMs = 60_000,
} = {}) {
  const safeLabel = requireText(label, 'HXA org label');
  const normalizedSecrets = normalizeNoticeSecrets({ noticeSecret, noticeSecrets }, { required: true });
  if (!(store instanceof DmPolicyRejectionStore)) {
    throw new TypeError('DM policy rejection store is required');
  }
  if (!client || typeof client.send !== 'function') {
    throw new TypeError('HXA client with send() is required');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('DM policy rejection maxAttempts must be a positive integer');
  }
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1) {
    throw new TypeError('DM policy rejection retryBaseMs must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRetryMs) || maxRetryMs < retryBaseMs) {
    throw new TypeError('DM policy rejection maxRetryMs must be an integer at least retryBaseMs');
  }

  return Object.freeze({
    async reject(message, { source, policy } = {}) {
      const messageId = requireText(message?.id, 'rejected DM message id');
      const sender = requireText(message?.sender_name || message?.sender_id, 'rejected DM sender');
      const senderId = requireText(message?.sender_id, 'rejected DM sender id');
      const channelId = requireText(message?.channel_id, 'rejected DM channel id');
      const safePolicy = requireText(policy, 'DM policy');
      const senderIdentity = senderId;
      const idempotencyKey = `hxa.dm-policy-rejection.v1.${sha256(`${safeLabel}\0${messageId}\0dm_policy`)}`;
      const senderPolicyKey = `hxa.dm-policy-rejection-rate.v1.${sha256(`${safeLabel}\0${senderIdentity}\0${safePolicy}`)}`;
      return store.withLock(senderPolicyKey, () => store.withLock(idempotencyKey, async () => {
        let record = await store.begin({
          idempotencyKey,
          label: safeLabel,
          messageId,
          source: requireText(source, 'rejected DM source'),
          sender,
          senderId,
          senderKey: sha256(senderIdentity),
          timestamp: Number.isFinite(message.created_at) ? message.created_at : store.clock(),
          reason: 'dm_policy',
          policy: safePolicy,
          channelId,
        });
        const sameSender = record.senderId
          ? record.senderId === senderId
          : record.senderKey === sha256(senderId);
        if (record.label !== safeLabel
          || record.messageId !== messageId
          || !sameSender
          || record.channelId !== channelId
          || record.policy !== safePolicy) {
          return {
            status: 'identity_conflict',
            replayed: true,
            errorCode: 'IDENTITY_CONFLICT',
          };
        }
        if (record.status === 'notified' || record.status === 'rate_limited' || record.status === 'dead_letter') {
          return { status: record.status, replayed: true };
        }
        if (record.status === 'retry_wait' && record.nextRetryAt > store.clock()) {
          return {
            status: record.status,
            replayed: true,
            nextRetryAt: record.nextRetryAt,
          };
        }
        const rejectorAgentId = requireText(agentId, 'HXA agent id');
        const reconciliationContents = new Set(normalizedSecrets.verification.map(secret => (
          signedRejectionContent({
            noticeSecret: secret,
            rejectorAgentId,
            targetAgentId: senderId,
            channelId,
            messageId,
            policy: safePolicy,
          })
        )));
        const content = signedRejectionContent({
          noticeSecret: normalizedSecrets.current,
          rejectorAgentId,
          targetAgentId: senderId,
          channelId,
          messageId,
          policy: safePolicy,
        });
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
            const reconcileStart = Math.max(0, record.startedAt - 5_000);
            const reconcileEnd = store.clock() + 5_000;
            const matchingMessages = messages.filter(candidate => (
              candidate?.channel_id === record.channelId
              && candidate?.sender_id === agentId
              && reconciliationContents.has(candidate?.content)
              && candidate?.content_type === 'system'
              && Number.isFinite(candidate?.created_at)
              && candidate.created_at >= reconcileStart
              && candidate.created_at <= reconcileEnd
            ));
            const existing = matchingMessages.find(candidate => (
              typeof candidate.id === 'string' && candidate.id.trim() !== ''
            ));
            if (existing) {
              record = await store.update(record, {
                status: 'notified',
                noticeMessageId: existing.id,
                channelId: existing.channel_id || record.channelId,
                nextRetryAt: null,
                lastError: null,
              });
              return { status: record.status, replayed: true, reconciled: true };
            }
            if (matchingMessages.length > 0) {
              const attempts = Math.min(maxAttempts, record.attempts + 1);
              const nextRetryAt = store.clock()
                + Math.min(maxRetryMs, retryBaseMs * (2 ** (attempts - 1)));
              record = await store.update(record, {
                status: 'retry_wait',
                attempts,
                nextRetryAt,
                lastError: safeMissingReceiptError(),
              });
              return { status: record.status, replayed: true, nextRetryAt };
            }
          } catch (error) {
            const attempts = Math.min(maxAttempts, record.attempts + 1);
            const nextRetryAt = store.clock()
              + Math.min(maxRetryMs, retryBaseMs * (2 ** (attempts - 1)));
            record = await store.update(record, {
              status: 'retry_wait',
              attempts,
              nextRetryAt,
              lastError: safeReconciliationError(),
            });
            return { status: record.status, replayed: true, nextRetryAt };
          }
          if (record.attempts >= maxAttempts) {
            record = await store.update(record, {
              status: 'dead_letter',
              nextRetryAt: null,
            });
            return { status: record.status, replayed: true };
          }
        }
        const recentForSenderAndPolicy = (await store.list({ label: safeLabel })).some(candidate => (
          candidate.idempotencyKey !== record.idempotencyKey
          && candidate.senderKey === record.senderKey
          && candidate.policy === record.policy
          && ['prepared', 'sending', 'retry_wait', 'notified'].includes(candidate.status)
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
            senderId,
            content,
            { content_type: 'system' },
          );
        } catch (error) {
          const failure = safeDeliveryError(error);
          const nextRetryAt = failure.retryable
            ? store.clock() + Math.min(maxRetryMs, retryBaseMs * (2 ** (record.attempts - 1)))
            : null;
          record = await store.update(record, {
            status: nextRetryAt === null ? 'dead_letter' : 'retry_wait',
            nextRetryAt,
            lastError: failure,
          });
          return nextRetryAt === null
            ? { status: record.status, replayed: false }
            : { status: record.status, replayed: false, nextRetryAt };
        }
        const noticeMessageId = typeof receipt?.message?.id === 'string'
          && receipt.message.id.trim() !== ''
          ? receipt.message.id
          : null;
        const receiptChannelId = receipt?.channel_id || receipt?.message?.channel_id || null;
        if (!noticeMessageId || receiptChannelId !== record.channelId) {
          const nextRetryAt = store.clock()
            + Math.min(maxRetryMs, retryBaseMs * (2 ** (record.attempts - 1)));
          record = await store.update(record, {
            status: 'retry_wait',
            nextRetryAt,
            lastError: safeMissingReceiptError(),
          });
          return { status: record.status, replayed: false, nextRetryAt };
        }
        record = await store.update(record, {
          status: 'notified',
          noticeMessageId,
          channelId: receiptChannelId,
          nextRetryAt: null,
          lastError: null,
        });
        return { status: record.status, replayed: false };
      }));
    },
  });
}
