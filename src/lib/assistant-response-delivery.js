import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ORG_PREFIX_RE = /^org:([a-z0-9][a-z0-9-]*)\|(.+)$/;
const MSG_SUFFIX_RE = /\|msg:([A-Za-z0-9-]+)$/;
const TERMINAL_EVENTS = new Set(['RunCompleted', 'RunFailed']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

export function normalizeHxaTransportReceipt(receipt) {
  const message = receipt?.message || receipt || {};
  return {
    hubMessageId: typeof message.id === 'string' ? message.id : null,
    channelId: typeof receipt?.channel_id === 'string'
      ? receipt.channel_id
      : (typeof message.channel_id === 'string' ? message.channel_id : null),
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

async function writeAtomic(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await fs.promises.writeFile(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.promises.rename(tempPath, filePath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

export function parseHxaResponseEndpoint(endpointId, defaultOrgLabel = 'default') {
  let endpoint = requireText(endpointId, 'HXA response endpointId');
  let orgLabel = defaultOrgLabel;
  const orgMatch = endpoint.match(ORG_PREFIX_RE);
  if (orgMatch) {
    orgLabel = orgMatch[1];
    endpoint = orgMatch[2];
  }

  let sourceMessageId = null;
  const messageMatch = endpoint.match(MSG_SUFFIX_RE);
  if (messageMatch) {
    sourceMessageId = messageMatch[1];
    endpoint = endpoint.slice(0, messageMatch.index);
  }

  if (endpoint.startsWith('thread:')) {
    const threadId = requireText(endpoint.slice('thread:'.length), 'HXA response threadId');
    return Object.freeze({
      kind: 'thread',
      orgLabel,
      threadId,
      replyToId: sourceMessageId,
      endpointId,
    });
  }
  if (endpoint.startsWith('channel:')) {
    throw new TypeError('HXA response cannot target a legacy group channel');
  }
  return Object.freeze({
    kind: 'dm',
    orgLabel,
    target: requireText(endpoint, 'HXA response DM target'),
    sourceMessageId,
    endpointId,
  });
}

export function dmResponseEndpoint(label, sender, messageId, { multiOrg = true } = {}) {
  const target = `${requireText(sender, 'HXA DM sender')}|msg:${requireText(messageId, 'HXA DM messageId')}`;
  if (!multiOrg && label === 'default') return target;
  return `org:${requireText(label, 'HXA org label')}|${target}`;
}

function terminalFromDelivery(input) {
  const delivery = requireRecord(input, 'C4 assistant response delivery');
  if (delivery.schemaVersion !== 1) {
    throw new TypeError('C4 assistant response delivery schemaVersion must be 1');
  }
  const requestId = requireText(delivery.requestId, 'C4 assistant response requestId');
  const route = requireRecord(delivery.route, 'C4 assistant response route');
  if (route.channel !== 'hxa-connect') {
    throw new TypeError('C4 assistant response route channel must be hxa-connect');
  }
  requireText(route.endpointId, 'C4 assistant response route endpointId');
  if (!Array.isArray(delivery.events) || delivery.events.length === 0) {
    throw new TypeError('C4 assistant response delivery events must be non-empty');
  }
  const terminals = delivery.events.filter(event => TERMINAL_EVENTS.has(event?.type));
  if (terminals.length === 0) return { requestId, route, terminal: null };
  if (terminals.length !== 1) {
    throw new TypeError('C4 assistant response delivery must contain one terminal event');
  }
  const terminal = requireRecord(terminals[0], 'C4 assistant response terminal event');
  if (terminal.requestId !== requestId) {
    throw new TypeError('C4 assistant response terminal event requestId mismatch');
  }
  if (!Number.isSafeInteger(terminal.sequence) || terminal.sequence < 1) {
    throw new TypeError('C4 assistant response terminal sequence must be positive');
  }
  const payload = requireRecord(terminal.payload, 'C4 assistant response terminal payload');
  if (terminal.type === 'RunCompleted' && typeof payload.output !== 'string') {
    throw new TypeError('RunCompleted output must be a string');
  }
  if (terminal.type === 'RunFailed' && typeof payload.retryable !== 'boolean') {
    throw new TypeError('RunFailed retryable must be a boolean');
  }
  return { requestId, route, terminal };
}

function publicCompletedContent(terminal) {
  return terminal.payload.output.trim().length > 0 ? terminal.payload.output : '处理完成。';
}

function canonicalEndpointKey(parsed) {
  return parsed.kind === 'thread'
    ? `${parsed.orgLabel}\0thread\0${parsed.threadId}`
    : `${parsed.orgLabel}\0dm\0${parsed.target}`;
}

function responseIdentity({ requestId, parsed, content }) {
  const deliveryId = `hxa.response.${sha256(requestId)}`;
  const identity = {
    deliveryId,
    requestId,
    endpointKey: canonicalEndpointKey(parsed),
    contentHash: sha256(content),
  };
  return { ...identity, identityHash: sha256(JSON.stringify(identity)) };
}

export class AssistantResponseDeliveryStore {
  constructor({ directory, clock = () => Date.now() }) {
    this.directory = requireText(directory, 'assistant response delivery directory');
    this.clock = clock;
  }

  filePath(deliveryId) {
    return path.join(this.directory, `${sha256(deliveryId)}.json`);
  }

  async read(deliveryId) {
    try {
      return JSON.parse(await fs.promises.readFile(this.filePath(deliveryId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async withLock(deliveryId, callback, { timeoutMs = 5_000 } = {}) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath(deliveryId)}.lock`;
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
          const busy = new Error('assistant response delivery is busy');
          busy.code = 'HXA_RESPONSE_DELIVERY_BUSY';
          throw busy;
        }
        await sleep(25);
      }
    }

    try {
      return await callback(Object.freeze({ lockToken: token }));
    } finally {
      try {
        const owner = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        if (owner.token === token) await fs.promises.unlink(lockPath);
      } catch {
        // A missing lock is safe; the durable delivery record remains canonical.
      }
    }
  }

  async begin(identity, initial = {}) {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(identity.deliveryId);
    try {
      const existing = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      if (existing.identityHash !== identity.identityHash) {
        const conflict = new Error('assistant response delivery identity collision');
        conflict.code = 'IDEMPOTENCY_CONFLICT';
        throw conflict;
      }
      return existing;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const now = this.clock();
    const record = {
      schemaVersion: 1,
      ...identity,
      status: 'prepared',
      attempts: 0,
      startedAt: now,
      updatedAt: now,
      lastError: null,
      hubMessageId: null,
      channelId: null,
      ...initial,
    };
    const tempPath = `${filePath}.new.${process.pid}.${randomUUID()}`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      await fs.promises.link(tempPath, filePath);
      return record;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      if (existing.identityHash !== identity.identityHash) {
        const conflict = new Error('assistant response delivery identity collision');
        conflict.code = 'IDEMPOTENCY_CONFLICT';
        throw conflict;
      }
      return existing;
    } finally {
      await fs.promises.unlink(tempPath).catch(() => {});
    }
  }

  async update(record, changes, { expectedFence, expectedLeaseToken } = {}) {
    const current = await this.read(record.deliveryId);
    if (!current || current.identityHash !== record.identityHash) {
      const error = new Error('assistant response delivery identity collision');
      error.code = 'IDEMPOTENCY_CONFLICT';
      throw error;
    }
    if (expectedFence !== undefined && (current.fence ?? 0) !== expectedFence) {
      const error = new Error('assistant response delivery fence lost');
      error.code = 'HXA_DELIVERY_FENCE_LOST';
      throw error;
    }
    if (expectedLeaseToken !== undefined && current.activeLease?.token !== expectedLeaseToken) {
      const error = new Error('assistant response delivery lease lost');
      error.code = 'HXA_DELIVERY_LEASE_LOST';
      throw error;
    }
    const next = { ...current, ...changes, updatedAt: this.clock() };
    await writeAtomic(this.filePath(record.deliveryId), next);
    return next;
  }
}

function isSelfMessage(message, org) {
  if (org.agentId && message?.sender_id === org.agentId) return true;
  return Boolean(org.agentName && message?.sender_name === org.agentName);
}

async function reconcileDm({ client, org, target, sourceMessageId, content, startedAt }) {
  const messages = await client.inbox(Math.max(0, startedAt - 5_000));
  if (!Array.isArray(messages)) throw new TypeError('Hub inbox response must be an array');
  const expectedChannels = new Set();
  for (const message of messages) {
    if (sourceMessageId && message?.id === sourceMessageId && message.channel_id) {
      expectedChannels.add(message.channel_id);
    }
    if (!sourceMessageId && message?.sender_name === target && message.channel_id) {
      expectedChannels.add(message.channel_id);
    }
  }
  return messages.find(message => (
    isSelfMessage(message, org)
    && message.content === content
    && Number(message.created_at) >= startedAt - 5_000
    && (expectedChannels.size === 0 || expectedChannels.has(message.channel_id))
  )) || null;
}

async function reconcileThread({ client, org, threadId, content, startedAt }) {
  const messages = await client.getThreadMessages(threadId, {
    since: Math.max(0, startedAt - 5_000),
  });
  if (!Array.isArray(messages)) throw new TypeError('Hub thread messages response must be an array');
  return messages.find(message => (
    isSelfMessage(message, org)
    && message.content === content
    && Number(message.created_at) >= startedAt - 5_000
  )) || null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveCompatibleRoute(parsed, client) {
  if (parsed.kind !== 'dm' || !UUID_RE.test(parsed.target) || typeof client.getThread !== 'function') {
    return parsed;
  }
  try {
    await client.getThread(parsed.target);
    return {
      kind: 'thread',
      orgLabel: parsed.orgLabel,
      threadId: parsed.target,
      replyToId: parsed.sourceMessageId,
      endpointId: parsed.endpointId,
    };
  } catch (error) {
    if (error?.body?.code === 'NOT_FOUND' || error?.status === 404) return parsed;
    throw error;
  }
}

export async function reconcileHxaResponse({ parsed, client, org, content, startedAt }) {
  const route = await resolveCompatibleRoute(parsed, client);
  if (route.kind === 'thread') {
    return reconcileThread({ client, org, threadId: route.threadId, content, startedAt });
  }
  return reconcileDm({
    client,
    org,
    target: route.target,
    sourceMessageId: route.sourceMessageId,
    content,
    startedAt,
  });
}

export async function sendHxaResponse({ parsed, client, content }) {
  const route = await resolveCompatibleRoute(parsed, client);
  if (route.kind === 'thread') {
    const options = route.replyToId ? { reply_to: route.replyToId } : undefined;
    try {
      return await client.sendThreadMessage(route.threadId, content, options);
    } catch (error) {
      if (route.replyToId && (error?.status === 400 || error?.body?.code === 'NOT_FOUND')) {
        return client.sendThreadMessage(route.threadId, content);
      }
      throw error;
    }
  }
  return client.send(route.target, content);
}

export function createAssistantResponseSender({
  store,
  resolveOrg,
  defaultOrgLabel = 'default',
  logger = console,
} = {}) {
  if (!(store instanceof AssistantResponseDeliveryStore)) {
    throw new TypeError('assistant response delivery store is required');
  }
  if (typeof resolveOrg !== 'function') {
    throw new TypeError('assistant response org resolver is required');
  }

  return Object.freeze({
    async send({ requestId, endpointId, content, suppressSkip = false } = {}) {
      const safeRequestId = requireText(requestId, 'HXA assistant response requestId');
      const safeEndpointId = requireText(endpointId, 'HXA assistant response endpointId');
      const safeContent = requireText(content, 'HXA assistant response content');
      const parsed = parseHxaResponseEndpoint(safeEndpointId, defaultOrgLabel);
      const identity = responseIdentity({
        requestId: safeRequestId,
        parsed,
        content: safeContent,
      });
      return store.withLock(identity.deliveryId, async () => {
        let record = await store.begin(identity);
        if (record.status === 'delivered' || record.status === 'suppressed') {
          return { handled: true, replayed: true, status: record.status };
        }

        if (suppressSkip && /^\s*\[SKIP\]\s*$/i.test(safeContent)) {
          record = await store.update(record, { status: 'suppressed', lastError: null });
          return { handled: true, replayed: false, status: record.status };
        }

        const org = requireRecord(await resolveOrg(parsed.orgLabel), 'HXA response org');
        const client = requireRecord(org.client, 'HXA response client');

        if (record.attempts > 0) {
          const existing = await reconcileHxaResponse({
            parsed,
            client,
            org,
            content: safeContent,
            startedAt: record.startedAt,
          });
          if (existing) {
            const receipt = normalizeHxaTransportReceipt(existing);
            record = await store.update(record, {
              status: 'delivered',
              lastError: null,
              ...receipt,
            });
            logger.warn?.(`[hxa-connect] Reconciled ambiguous assistant response ${record.deliveryId}`);
            return { handled: true, replayed: true, status: record.status };
          }
        }

        record = await store.update(record, {
          status: 'sending',
          attempts: record.attempts + 1,
          lastError: null,
        });
        try {
          const receipt = normalizeHxaTransportReceipt(await sendHxaResponse({
            parsed,
            client,
            content: safeContent,
          }));
          record = await store.update(record, {
            status: 'delivered',
            lastError: null,
            ...receipt,
          });
        } catch (error) {
          await store.update(record, {
            status: 'uncertain',
            lastError: String(error?.message || error).slice(0, 500),
          });
          throw error;
        }
        return {
          handled: true,
          replayed: false,
          status: record.status,
          hubMessageId: record.hubMessageId,
        };
      });
    },
  });
}

export function createAssistantResponseDelivery(options = {}) {
  const sender = createAssistantResponseSender(options);
  const logger = options.logger || console;
  return Object.freeze({
    async deliver(input) {
      const { requestId, route, terminal } = terminalFromDelivery(input);
      if (!terminal) return { handled: true, terminal: false };
      if (terminal.type === 'RunFailed') {
        const code = typeof terminal.payload.code === 'string' ? terminal.payload.code : null;
        const failure = Object.freeze({ code, retryable: terminal.payload.retryable });
        logger.warn?.('[hxa-connect] Suppressed outbound RunFailed terminal', {
          requestId,
          ...failure,
        });
        return {
          handled: true,
          terminal: true,
          status: 'suppressed',
          eventType: 'RunFailed',
          failure,
        };
      }
      const result = await sender.send({
        requestId,
        endpointId: route.endpointId,
        content: publicCompletedContent(terminal),
        suppressSkip: true,
      });
      return { ...result, terminal: true, eventType: 'RunCompleted' };
    },
  });
}
