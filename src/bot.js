/**
 * zylos-hxa-connect - HXA-Connect WebSocket client for Zylos Bot
 * Connects to HXA-Connect hubs via SDK and bridges messages to C4.
 * Supports multiple orgs simultaneously.
 *
 * Handles: DM, threads, artifacts, participant events.
 * Uses hxa-connect-sdk for WS (session-based auth, auto-reconnect, 1012 support).
 */

import * as hxaSdk from '@coco-xyz/hxa-connect-sdk';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { migrateConfig, resolveOrgs, setupFetchProxy, PROXY_URL } from './env.js';

import {
  decideDmDelivery, decideThreadDelivery, decideCatchupEvent, settleLiveDelivery,
  REJECT as POLICY_REJECT, DELIVER as POLICY_DELIVER,
  DELIVERED as DELIVERY_OK, SKIP as DELIVERY_SKIP,
} from './lib/delivery.js';
import { getMediaBaseDir, generateFilename } from './lib/media.js';
// zylos-lab-hxa-catchup: recover messages missed while offline / restarting.
import { CatchupRunner, DeliveryGate, formatCatchupEventLine } from './lib/catchup.js';
import { buildDmContent, buildThreadHeader } from './lib/format.js';
import { CatchupStateStore, resolveCatchupStatePath } from './lib/catchup-state.js';
// zylos-lab-hxa-redact: never log tokens/tickets/Authorization values.
import { redactSecrets } from './lib/redact.js';
// Upstream 1.7.4+: durable C4 spool, DM inbox reconciliation, signed DM-policy
// rejection notices, stable assistant-response identities.
import { C4DeliveryQueue } from './lib/c4-delivery-queue.js';
import { DmInboxReconciler, DmInboxState } from './lib/dm-inbox-reconciler.js';
import {
  DmPolicyRejectionStore,
  createDmPolicyGate,
  createDmPolicyRejectionHandler,
  requireCurrentNoticeSecret,
} from './lib/dm-policy-rejection.js';
import { resolveFinalDeliveryMode } from './lib/assistant-response-delivery.js';
import { newestDeliveryAgeMs } from './lib/delivery-health.js';
import { getRuntimePaths } from './lib/config-path.js';

const {
  c4ReceivePath: C4_RECEIVE,
  c4SpoolDir: C4_SPOOL_DIR,
  dmInboxStatePath: DM_INBOX_STATE_PATH,
  dmPolicyRejectionDir: DM_POLICY_REJECTION_DIR,
  assistantResponseDir: ASSISTANT_RESPONSE_DIR,
} = getRuntimePaths();
const configuredDmReconcileInterval = Number.parseInt(process.env.HXA_DM_RECONCILE_INTERVAL_MS || '15000', 10);
const DM_POLICY_NOTICE_SECRET = process.env.HXA_DM_POLICY_NOTICE_SECRET;
const DM_POLICY_NOTICE_PREVIOUS_SECRET = process.env.HXA_DM_POLICY_NOTICE_PREVIOUS_SECRET;
const DM_POLICY_NOTICE_SECRETS = {
  current: DM_POLICY_NOTICE_SECRET,
  previous: DM_POLICY_NOTICE_PREVIOUS_SECRET ? [DM_POLICY_NOTICE_PREVIOUS_SECRET] : [],
};

// Fail fast before any connection setup. The per-org DM policy gate below
// requires this secret; if it is missing the gate throws mid-setup and the
// process previously kept running (PM2 still "online") with no WebSockets
// established — an invisible half-dead state. Exit loudly instead.
try {
  requireCurrentNoticeSecret(DM_POLICY_NOTICE_SECRET);
} catch (error) {
  console.error(
    `[hxa-connect] ${redactSecrets(error.message)}. ` +
    'Add HXA_DM_POLICY_NOTICE_SECRET to the zylos .env file, then run `pm2 restart` on the HXA service. Exiting.',
  );
  process.exit(1);
}

// Startup self-check: surface a stale assistant-response delivery store.
// A store that stops receiving writes is the first sign of streamed-reply
// delivery silently stopping (issue #26). With terminal auto-delivery off
// (the default) a quiet ledger is expected, so the check is skipped. This
// is diagnostic only and must never take the service down.
const ASSISTANT_DELIVERY_STALE_WARN_MS = 60 * 60 * 1000; // 1 hour
if (resolveFinalDeliveryMode(process.env) !== 'off') {
  try {
    const deliveryHealth = newestDeliveryAgeMs({ directory: ASSISTANT_RESPONSE_DIR });
    if (deliveryHealth.hasRecords && deliveryHealth.ageMs > ASSISTANT_DELIVERY_STALE_WARN_MS) {
      console.warn(
        `[hxa-connect] Assistant-response delivery store is stale: newest record is ` +
        `${Math.round(deliveryHealth.ageMs / 60_000)} minutes old. ` +
        'If outbound assistant replies are expected, verify C4_ASSISTANT_REQUEST_ID is still being passed ' +
        'to scripts/send.js and scripts/stream.js is still being invoked.',
      );
    }
  } catch (error) {
    console.warn(`[hxa-connect] Assistant-response delivery health check failed: ${redactSecrets(error.message)}`);
  }
}

const DM_RECONCILE_INTERVAL_MS = Number.isInteger(configuredDmReconcileInterval)
  && configuredDmReconcileInterval >= 5_000
  ? configuredDmReconcileInterval
  : 15_000;

const config = migrateConfig();
const resolved = resolveOrgs(config);
const orgLabels = Object.keys(resolved.orgs);
const isMultiOrg = orgLabels.length > 1 || !resolved.orgs.default;

const C4_CHANNEL = 'hxa-connect';
const { HxaConnectClient, ThreadContext } = hxaSdk;

function fallbackFormatThreadLifecycleEvent(event) {
  switch (event.type) {
    case 'thread_created': {
      const topic = event.thread?.topic || 'untitled';
      const tags = event.thread?.tags?.length ? ` (tags: ${event.thread.tags.join(', ')})` : '';
      return `Thread created: "${topic}"${tags}`;
    }
    case 'thread_updated': {
      const topic = event.thread?.topic || 'untitled';
      const changes = Array.isArray(event.changes) && event.changes.length ? event.changes.join(', ') : 'unknown fields';
      return `Thread updated: "${topic}" (${changes})`;
    }
    case 'thread_status_changed':
      return `Thread status changed: "${event.topic}" ${event.from} -> ${event.to}${event.by ? ` by ${event.by}` : ''}`;
    case 'thread_artifact': {
      const artifact = event.artifact || {};
      return `Artifact ${event.action}: "${artifact.title || artifact.artifact_key}" (type: ${artifact.type})`;
    }
    case 'thread_participant':
      return `${event.bot_name || event.bot_id}${event.label ? ` [${event.label}]` : ''} ${event.action} the thread${event.by ? ` by ${event.by}` : ''}`;
    default:
      return event.type || 'thread event';
  }
}

const formatThreadLifecycleEvent = hxaSdk.formatThreadLifecycleEvent || fallbackFormatThreadLifecycleEvent;

function c4Endpoint(label, endpoint) {
  if (!isMultiOrg && label === 'default') return endpoint;
  return `org:${label}|${endpoint}`;
}

function displayPrefix(label) {
  if (!isMultiOrg) return 'HXA-Connect';
  return `HXA:${label}`;
}

function logPrefix(label) {
  if (!isMultiOrg) return '[hxa-connect]';
  return `[hxa-connect:${label}]`;
}

function createConnectionDiagnostics(client, label) {
  const org = /^[a-z0-9][a-z0-9-]*$/.test(label) ? label : 'unknown';
  let connectedAt = null;
  let lastReceivedAt = null;
  let lastPongAt = null;
  let connectCount = 0;
  let reconnectCount = 0;
  let reconnectAttemptCount = 0;
  const numberOrNull = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const iso = value => value === null ? null : new Date(value).toISOString();

  function record(event, fields = {}) {
    const now = Date.now();
    console.log(`[hxa-connect:${org}] Connection ${JSON.stringify({
      event,
      org,
      at: iso(now),
      connectedAt: iso(connectedAt),
      connectionAgeMs: connectedAt === null ? null : Math.max(0, now - connectedAt),
      lastReceivedAt: iso(lastReceivedAt),
      lastReceivedAgeMs: lastReceivedAt === null ? null : Math.max(0, now - lastReceivedAt),
      lastPongAt: iso(lastPongAt),
      lastPongAgeMs: lastPongAt === null ? null : Math.max(0, now - lastPongAt),
      connectCount,
      reconnectCount,
      reconnectAttemptCount,
      ...fields,
    })}`);
  }

  function connected(event) {
    connectedAt = Date.now();
    lastReceivedAt = null;
    lastPongAt = null;
    connectCount++;
    if (event === 'reconnected') reconnectCount++;
    record(event);
  }

  // SDK '*' observes parsed application frames, not transport control frames.
  client.on('*', () => { lastReceivedAt = Date.now(); });
  client.on('pong', () => {
    lastPongAt = Date.now();
    lastReceivedAt = lastPongAt;
    record('pong');
  });
  client.on('close', ({ code } = {}) => {
    record('close', { code: numberOrNull(code) });
  });
  client.on('reconnecting', ({ attempt, delay } = {}) => {
    reconnectAttemptCount++;
    record('reconnecting', { attempt: numberOrNull(attempt), delayMs: numberOrNull(delay) });
  });
  client.on('reconnected', () => { connected('reconnected'); });
  client.on('reconnect_failed', ({ attempts } = {}) => {
    record('reconnect_failed', { attempts: numberOrNull(attempts) });
  });

  return { connected: () => connected('connected') };
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildLifecycleBlock(snapshot) {
  const lifecycleEvents = snapshot.lifecycleEvents || [];
  if (!lifecycleEvents.length) return '';
  const lines = lifecycleEvents.map(event => `- ${escapeXml(formatThreadLifecycleEvent(event))}`);
  return `<thread-events>\n${lines.join('\n')}\n</thread-events>\n\n`;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '?B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// Format non-text message parts (image, file, link) as inline references.
// Text/markdown parts are already captured via msg.content; json parts are
// complex objects not suitable for inline display — both are skipped here.
const MAX_ATTACHMENT_PARTS = 20;

function formatAttachments(parts, localPaths) {
  if (!parts || !parts.length) return '';
  const refs = [];
  let truncated = 0;
  for (const part of parts) {
    if (refs.length >= MAX_ATTACHMENT_PARTS) {
      // Only count parts that would have produced a ref
      if (part.type === 'image' || part.type === 'file' || part.type === 'link'
          || (part.type && part.url)) {
        truncated++;
      }
      continue;
    }
    switch (part.type) {
      case 'image': {
        if (!part.url) break;
        const loc = localPaths?.[part.url];
        refs.push(part.alt
          ? `[image: ${part.alt} — ${loc || part.url}]`
          : `[image: ${loc || part.url}]`);
        break;
      }
      case 'file': {
        if (!part.url || !part.name) break;
        const size = part.size != null ? `, ${formatBytes(part.size)}` : '';
        const loc = localPaths?.[part.url];
        refs.push(`[file: ${part.name} (${part.mime_type || 'application/octet-stream'}${size}) — ${loc || part.url}]`);
        break;
      }
      case 'link':
        if (!part.url) break;
        refs.push(part.title
          ? `[link: ${part.title} — ${part.url}]`
          : `[link: ${part.url}]`);
        break;
      default:
        // Forward-compat: surface unknown part types that carry a URL
        if (part.type && part.url) {
          refs.push(`[${part.type}: ${part.url}]`);
        }
        break;
    }
  }
  if (truncated > 0) refs.push(`[... and ${truncated} more]`);
  return refs.length > 0 ? '\n' + refs.join('\n') : '';
}

// ─── Media Download ─────────────────────────────────────────

// Match Hub-internal file URLs: /api/files/<id> (ID is opaque — no format constraints)
// [^?#]+ excludes query strings and fragments from the captured ID.
const HUB_FILE_RE = /^\/api\/files\/([^/?#]+)/;

/**
 * Download media parts (image/file) from Hub to local filesystem.
 * Uses client.downloadFile() from hxa-connect-sdk for the actual download.
 * Returns a map of original URL → local file path.
 * Only downloads Hub-internal URLs (/api/files/:id); external URLs are skipped.
 */
async function downloadMediaParts(parts, client, orgLabel, lp) {
  if (!parts || !parts.length) return {};

  const localPaths = {};
  const orgDir = path.join(getMediaBaseDir(), orgLabel);

  try {
    await fs.promises.mkdir(orgDir, { recursive: true });
  } catch (err) {
    console.warn(`${lp} Failed to create media dir ${orgDir}: ${redactSecrets(err.message)}`);
    return localPaths;
  }

  for (const part of parts) {
    if (part.type !== 'image' && part.type !== 'file') continue;
    if (!part.url) continue;

    const match = HUB_FILE_RE.exec(part.url);
    if (!match) continue; // External URL, skip

    const fileId = match[1];

    try {
      const result = await client.downloadFile(fileId, {
        maxBytes: 10 * 1024 * 1024, // 10 MB
        timeout: 30_000,
      });
      const filename = generateFilename(fileId, result.contentType);

      const localPath = path.join(orgDir, filename);
      await fs.promises.writeFile(localPath, result.buffer);

      localPaths[part.url] = localPath;
      console.log(`${lp} Media saved: ${localPath} (${formatBytes(result.size)})`);
    } catch (err) {
      console.warn(`${lp} Media download error for ${part.url}: ${redactSecrets(err.message)}`);
    }
  }

  return localPaths;
}

await setupFetchProxy();

const c4ReceiveSource = (() => {
  try {
    return fs.readFileSync(C4_RECEIVE, 'utf8');
  } catch {
    return '';
  }
})();
const supportsAssistantResponseStream = c4ReceiveSource.includes('--assistant-request-id')
  && c4ReceiveSource.includes('--assistant-source-id');
const c4Queue = new C4DeliveryQueue({
  spoolDir: C4_SPOOL_DIR,
  c4ReceivePath: C4_RECEIVE,
});
const dmInboxState = new DmInboxState({ filePath: DM_INBOX_STATE_PATH });
const dmPolicyRejectionStore = new DmPolicyRejectionStore({
  directory: DM_POLICY_REJECTION_DIR,
});
await c4Queue.start();
await dmInboxState.load();

const MAX_WS_PAYLOAD = 1048576; // 1 MB
const MAX_CONTENT_LENGTH = 51200; // 50 KB

// ─── Rate Limiting (M-04) ────────────────────────────────

class TokenBucket {
  constructor(capacity = 10, refillRate = 5, refillIntervalMs = 10000) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.refillIntervalMs = refillIntervalMs;
    this.lastRefill = Date.now();
  }

  consume() {
    this._refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed < this.refillIntervalMs) return;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    this.tokens = Math.min(this.capacity, this.tokens + intervals * this.refillRate);
    this.lastRefill += intervals * this.refillIntervalMs;
  }
}

// Per-sender rate limiters (keyed by org:senderId)
const rateLimiters = new Map();

function getRateLimiter(key) {
  let bucket = rateLimiters.get(key);
  if (!bucket) {
    bucket = new TokenBucket(10, 5, 10000);
    rateLimiters.set(key, bucket);
  }
  return bucket;
}

const wsOptions = {
  maxPayload: MAX_WS_PAYLOAD,
  ...(PROXY_URL ? { agent: new HttpsProxyAgent(PROXY_URL) } : {}),
};

// ─── C4 Bridge ─────────────────────────────────────────────

function stableC4Identity(label, kind, sourceId) {
  const digest = createHash('sha256').update(`${label}\0${kind}\0${sourceId}`).digest('hex');
  return {
    requestId: `hxa.${kind}.${digest}`,
    sourceId: `hxa:${kind}:${digest}`,
  };
}

/**
 * The one way a message leaves this process.
 *
 * Upstream 1.7.4 replaced the old in-process `execFile` + 2s retry with a
 * disk-backed spool: the record survives a PM2 restart, a busy C4, or a crash,
 * and an id that is already spooled is never enqueued twice.
 *
 * Returns the queue receipt; the queue owns retries, so a caller that must know
 * "did C4 take it" uses the awaited form below.
 */
async function sendToC4(channel, endpoint, content, {
  deliveryId = `hxa:generated:${randomUUID()}`,
  assistantIdentity = null,
} = {}) {
  if (!content) return { queued: false, replayed: false };
  const args = ['--channel', channel, '--endpoint', endpoint, '--json', '--content', content];
  if (supportsAssistantResponseStream && assistantIdentity) {
    args.push(
      '--assistant-request-id', assistantIdentity.requestId,
      '--assistant-source-id', assistantIdentity.sourceId,
    );
  }
  return c4Queue.enqueue({
    id: deliveryId,
    args,
    preview: content.substring(0, 80),
  });
}

/**
 * Awaited variant used by message delivery (live *and* replayed): the catch-up
 * watermark may only move past a message once C4 accepted it, otherwise a
 * failed replay would be lost. Throws on failure so the runner stops and
 * retries on the next reconnect.
 *
 * The spool makes the write durable before this returns; "accepted" here means
 * "durably queued", which is the strongest promise available at this point and
 * the one the watermark needs.
 */
async function sendToC4Awaited(channel, endpoint, content, options) {
  if (!content) return null;
  return sendToC4(channel, endpoint, content, options);
}

/**
 * Fire-and-forget C4 send for notifications that carry no delivery guarantee
 * (admin notices, lifecycle chatter) or whose caller only logs the failure.
 */
function sendToC4Notice(channel, endpoint, content, options) {
  if (!content) return;
  sendToC4Awaited(channel, endpoint, content, options).catch(err => {
    console.warn(`[hxa-connect] C4 notice dropped: ${redactSecrets(err?.message || err)}`);
  });
}

// ─── Constants ──────────────────────────────────────────────

const HANDLED_EVENTS = new Set([
  'message', 'channel_message', 'thread_created', 'thread_message',
  'thread_updated', 'thread_artifact', 'thread_participant',
  'channel_deleted', 'channel_created', 'bot_online', 'bot_offline', 'bot_renamed', 'thread_status_changed',
  'bot_join_request', 'bot_status_changed', 'bot_registered',
  'reconnecting', 'reconnected', 'reconnect_failed', 'error', 'close', 'pong',
  'ack', 'session_invalidated',
]);

const MAX_CONNECT_ATTEMPTS = 20;

// ─── Catch-up State (one file for all orgs, atomic writes) ──

const CATCHUP_STATE_PATH = resolveCatchupStatePath();
const catchupState = new CatchupStateStore({
  filePath: process.env.HXA_CATCHUP_STATE_PATH || CATCHUP_STATE_PATH,
  log: (msg) => console.warn(`[hxa-connect] ${msg}`),
}).load();

process.once('exit', () => {
  try { catchupState.flush(); } catch {}
});

// ─── Per-Org Connection Setup ──────────────────────────────

const connections = new Map();

for (const [label, org] of Object.entries(resolved.orgs)) {
  const lp = logPrefix(label);
  const dp = displayPrefix(label);

  if (!org.hubUrl) {
    console.error(`${lp} Skipping — no hub_url configured (neither per-org nor default)`);
    continue;
  }

  if (!org.agentId) {
    console.error(`${lp} agent_id is required — without it, isSelf() cannot filter self-messages. Set agent_id in config.json for org "${label}"`);
    continue;
  }

  const client = new HxaConnectClient({
    url: org.hubUrl,
    token: org.agentToken,
    orgId: org.orgId,
    wsOptions,
    reconnect: {
      enabled: true,
      initialDelay: 3000,
      maxDelay: 60000,
      backoffFactor: 1.5,
    },
  });

  // Diagnostic-only observer (allowlisted fields only; never sends traffic and
  // never changes the SDK's recovery behaviour). Hosts use these lines to tell
  // "socket alive but silent" apart from "socket gone".
  const diagnostics = createConnectionDiagnostics(client, label);

  const isSelf = (id, metadata) => {
    if (!org.agentId || id !== org.agentId) return false;
    // Human-authored messages via Web UI should not be treated as self-echo
    const meta = typeof metadata === 'string'
      ? (() => { try { return JSON.parse(metadata); } catch { return null; } })()
      : metadata;
    if (meta?.provenance?.authored_by === 'human') return false;
    return true;
  };

  // Shared de-duplication + watermark bookkeeping for realtime and catch-up.
  const gate = new DeliveryGate({ state: catchupState, label });

  // A restart or a dropped socket means we may have missed messages: open a
  // gap so a replay has to confirm the window is covered before the event
  // boundary moves. No boundary yet ⇒ the first run only baselines.
  if (catchupState.getEventsSince(label)) catchupState.markGap(label);

  // Upstream 1.7.9: a DM policy rejection is answered with a signed notice so
  // the sender learns why, and a notice that arrives back at us is recognised
  // instead of being treated as a new message.
  const dmPolicyGate = createDmPolicyGate({
    agentId: org.agentId,
    noticeSecrets: DM_POLICY_NOTICE_SECRETS,
    rejectionHandler: createDmPolicyRejectionHandler({
      label,
      store: dmPolicyRejectionStore,
      client,
      agentId: org.agentId,
      noticeSecrets: DM_POLICY_NOTICE_SECRETS,
    }),
  });

  /**
   * Single delivery pipeline for one DM message.
   * Used by both the realtime path and catch-up, so attachment handling, C4
   * formatting and the rate limit stay identical on both.
   * Throw on failure so catch-up can retry the message on the next reconnect.
   *
   * `skipRateLimit` is for the realtime caller that already consumed a token.
   */
  const deliverDm = async ({
    message, sender_name: senderName, parts, catchup = false, skipRateLimit = false,
    // Optional C4 delivery identity. Realtime passes the stable request id (see
    // `stableC4Identity`) so a replay cannot open a second assistant turn; a
    // catch-up replay is a new turn by design and passes none.
    delivery = null,
  }) => {
    const sender = senderName || message.sender_name || 'unknown';
    const content = message.content || '';
    // Return codes (the same constants the shared policy/settle helpers use):
    // DELIVERY_OK (C4 accepted), POLICY_REJECT (final policy no),
    // DELIVERY_SKIP (self / duplicate / rate-limited). Anything else throws.
    const decision = decideDmDelivery({
      access: org.access, isSelf, message, sender, catchup: catchup || skipRateLimit,
      takeRateToken: () => getRateLimiter(`${label}:dm:${message.sender_id || sender}`).consume(),
    });
    if (decision.verdict === POLICY_REJECT) {
      console.log(`${lp} DM from ${sender} rejected (${decision.reason})`);
      return POLICY_REJECT;
    }
    if (decision.verdict !== POLICY_DELIVER) {
      if (decision.reason === 'rate-limited') console.warn(`${lp} DM from ${sender} rate-limited, dropping`);
      return DELIVERY_SKIP;
    }

    // Download media after policy checks to avoid wasted effort
    const msgParts = message.parts || parts;
    const localPaths = await downloadMediaParts(msgParts, client, label, lp);
    const attachments = formatAttachments(msgParts, localPaths);

    if ((content.length + attachments.length) > MAX_CONTENT_LENGTH) {
      console.warn(`${lp} DM from ${sender} rejected — content too large (${content.length + attachments.length} bytes)`);
      return POLICY_REJECT;
    }

    console.log(`${lp} DM from ${sender}${catchup ? ' (catch-up)' : ''}: ${content.substring(0, 80)}`);
    const formatted = buildDmContent({ displayPrefix: dp, sender, content, attachments, catchup });
    // Awaited for BOTH live and replay: a message only counts as delivered once
    // C4 accepted it. A live failure therefore stays deliverable by catch-up.
    await sendToC4Awaited(
      C4_CHANNEL,
      // The endpoint carries the hub message id (upstream `dmResponseEndpoint`,
      // same org-prefix rule) so the reply anchors to the right DM.
      c4Endpoint(label, message.id ? `${sender}|msg:${message.id}` : sender),
      formatted,
      delivery || undefined,
    );
    return DELIVERY_OK;
  };

  // ─── DM intake: one message, one decision ─────────────

  const dmInFlight = new Map();

  function normalizeDm(raw) {
    const message = raw?.message || raw || {};
    return {
      id: message.id || raw?.id || null,
      channel_id: message.channel_id || raw?.channel_id || null,
      sender_id: message.sender_id || raw?.sender_id || null,
      sender_name: message.sender_name || raw?.sender_name || 'unknown',
      content: message.content || raw?.content || '',
      content_type: message.content_type || raw?.content_type || 'text',
      parts: message.parts || raw?.parts || [],
      metadata: message.metadata || raw?.metadata || null,
      created_at: message.created_at || raw?.created_at || Date.now(),
    };
  }

  /**
   * One inbound DM, from either the socket or the inbox reconciliation poll.
   *
   * The policy question and the signed rejection notice belong to the upstream
   * gate; the delivery itself stays on `deliverDm`. Every accepted or finally
   * rejected id is written into the catch-up state, so a replay of the same id
   * is skipped — that is the seam between the two recovery mechanisms.
   */
  async function processDm(raw, source, { ownReservations = [] } = {}) {
    const message = normalizeDm(raw);
    if (!message.id) {
      console.warn(`${lp} DM discarded source=${source} reason=missing_message_id sender=${message.sender_name}`);
      return { action: 'discarded', reason: 'missing_message_id' };
    }
    if (dmInFlight.has(message.id)) return dmInFlight.get(message.id);
    const promise = (async () => {
      const sender = message.sender_name;
      if (isSelf(message.sender_id, message.metadata)) {
        console.log(`${lp} DM discarded id=${message.id} source=${source} reason=self_message`);
        return { action: 'discarded', reason: 'self_message' };
      }
      // The catch-up replay and the inbox poll read the same hub history from
      // two different stores. Whichever path delivered this id first wins; the
      // other must not deliver it again. An id still IN FLIGHT elsewhere is not
      // a final answer either — defer rather than enqueue a second delivery
      // under a different spool id.
      if (gate.isDelivered(message.id)) {
        console.log(`${lp} DM discarded id=${message.id} source=${source} reason=already_delivered`);
        return { action: 'discarded', reason: 'already_delivered' };
      }
      // A reservation held by THIS delivery (the catch-up runner reserves an id
      // before calling back in) is not a conflict; only another owner's is.
      if (gate.isHeldByOther(message.id, ownReservations)) {
        console.log(`${lp} DM deferred id=${message.id} source=${source} reason=in_flight_elsewhere`);
        return { action: 'retry', reason: 'in_flight_elsewhere' };
      }
      const policyResult = await dmPolicyGate.evaluate(message, {
        source,
        access: org.access,
      });
      if (policyResult.action !== 'continue') {
        console.log(`${lp} DM discarded id=${message.id} source=${source} sender=${sender} reason=${policyResult.reason}${policyResult.notificationStatus ? ` notification=${policyResult.notificationStatus}` : ''}`);
        // A policy rejection is final for this id: remember it so catch-up does
        // not replay it, but do not let a rate-limited notice retry forever.
        if (policyResult.reason === 'dm_policy_rejection_notice'
            || policyResult.notificationStatus !== 'retry_wait') {
          gate.mark(message.id, Number(message.created_at) || Date.now());
          catchupState.scheduleSave();
        }
        return policyResult;
      }

      const rlKey = `${label}:dm:${message.sender_id || sender}`;
      if (!getRateLimiter(rlKey).consume()) {
        // Not a final answer: leave the id unremembered so a later replay or
        // inbox poll can still deliver it.
        console.warn(`${lp} DM deferred id=${message.id} source=${source} sender=${sender} reason=rate_limit`);
        return { action: 'retry', reason: 'rate_limit' };
      }

      gate.begin(message.id);
      let outcome;
      let error;
      try {
        outcome = await deliverDm({
          message,
          sender_name: sender,
          parts: message.parts,
          catchup: source !== 'websocket',
          skipRateLimit: true,
          delivery: {
            deliveryId: `hxa:${label}:dm:${message.id}`,
            assistantIdentity: stableC4Identity(label, 'dm', message.id),
          },
        });
      } catch (err) {
        error = err;
      }
      settleLiveDelivery({
        outcome, error, id: message.id, at: Number(message.created_at) || Date.now(), gate,
        markGap: () => catchupState.markGap(label),
        save: () => catchupState.scheduleSave(),
      });
      if (error) throw error;
      if (outcome === DELIVERY_OK) return { action: 'accepted' };
      if (outcome === POLICY_REJECT) return { action: 'discarded', reason: 'dm_policy' };
      return { action: 'skipped' };
    })().finally(() => dmInFlight.delete(message.id));
    dmInFlight.set(message.id, promise);
    return promise;
  }

  const dmReconciler = new DmInboxReconciler({
    label,
    client,
    state: dmInboxState,
    processMessage: processDm,
    intervalMs: DM_RECONCILE_INTERVAL_MS,
  });

  // ─── Event Handlers ───────────────────────────────────

  client.on('message', (msg) => {
    dmReconciler.observeLive(normalizeDm(msg)).catch(err => {
      console.error(`${lp} DM handler error: ${redactSecrets(err?.message || err)}`);
    });
  });

  // channel_message handler removed — channels are DMs, group channels no longer exist.
  // groupPolicy now gates thread access (see threadCtx.onMention below).

  client.on('thread_created', (msg) => {
    const thread = msg.thread || {};
    const topic = thread.topic || 'untitled';
    const tags = thread.tags?.length ? thread.tags.join(', ') : 'none';
    console.log(`${lp} Thread created: "${topic}" (tags: ${tags})`);
  });

  // ─── Thread @mention filtering (SDK ThreadContext) ───
  // Always catch all messages; per-thread mode filtering happens in onMention handler
  const threadCtx = new ThreadContext(client, {
    botNames: [org.agentName],
    botId: org.agentId || undefined,
    triggerPatterns: [/^/],
  });

  // Resolve thread mode: per-thread explicit mode, default "mention"
  function getThreadMode(threadId) {
    return org.access?.threads?.[threadId]?.mode || 'mention';
  }

  const mentionRe = new RegExp(
    `@${org.agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'
  );

  // Extract all searchable text from message (for mention detection).
  // Includes text/markdown content PLUS alt text, filenames, titles from
  // non-text parts so @mentions in those fields still trigger delivery.
  function extractText(msg) {
    const texts = [msg.content || ''];
    if (msg.parts) {
      for (const part of msg.parts) {
        if ('content' in part && typeof part.content === 'string') {
          texts.push(part.content);
        }
        if (part.type === 'image' && part.alt) texts.push(part.alt);
        if (part.type === 'file' && part.name) texts.push(part.name);
        if (part.type === 'link' && part.title) texts.push(part.title);
      }
    }
    return texts.join(' ');
  }

  // Display-friendly sender name (human provenance aware)
  function msgSender(msg) {
    const botName = msg.sender_name || msg.sender_id || 'unknown';
    const meta = typeof msg.metadata === 'string'
      ? (() => { try { return JSON.parse(msg.metadata); } catch { return null; } })()
      : msg.metadata;
    if (meta?.provenance?.authored_by === 'human' && meta.provenance.owner_name) {
      return `${meta.provenance.owner_name} (via ${botName})`;
    }
    return botName;
  }

  /**
   * Single delivery pipeline for one thread message.
   * Shared by threadCtx.onMention (realtime) and catch-up.
   * Throws on failure so catch-up can retry the message later.
   */
  async function deliverThread({ threadId, message, snapshot, reason, catchup = false }) {
    const sender = msgSender(message);
    const content = message.content || '';
    const isInteractiveDelivery = reason === 'message';
    const isRealMention = mentionRe.test(extractText(message)) || !!message.mention_all;
    const perThreadMode = getThreadMode(threadId);

    // One policy gate for the live socket and for replay: self-echo, groupPolicy
    // (incl. `disabled`, which stops invites too), sender allowlist, mention
    // mode and realtime rate limiting.
    const decision = decideThreadDelivery({
      access: org.access, isSelf, message, threadId, sender, reason,
      mode: perThreadMode, isMention: isRealMention, catchup,
      takeRateToken: () => getRateLimiter(`${label}:thread:${message.sender_id || sender}`).consume(),
    });
    if (decision.verdict === POLICY_REJECT) {
      console.log(`${lp} Thread ${threadId} rejected (${decision.reason})`);
      return POLICY_REJECT;
    }
    if (decision.verdict !== POLICY_DELIVER) {
      if (decision.reason === 'self' && message?.id) {
        console.log(`${lp} Thread ${threadId} message ${message.id} is our own — not delivering`);
      } else if (decision.reason === 'rate-limited') {
        console.warn(`${lp} Thread ${threadId} from ${sender} rate-limited, dropping`);
      }
      return DELIVERY_SKIP;
    }

    // Download media for trigger message (after policy checks)
    const localPaths = await downloadMediaParts(message.parts, client, label, lp);
    const attachments = formatAttachments(message.parts, localPaths);

    if ((content.length + attachments.length) > MAX_CONTENT_LENGTH) {
      console.warn(`${lp} Thread ${threadId} from ${sender} rejected — content too large (${content.length + attachments.length} bytes)`);
      return POLICY_REJECT;
    }

    const lifecycleBlock = buildLifecycleBlock(snapshot);
    const hasCurrentMessage = !!message.id;

    // Build C4 message with XML tags (consistent with Lark/TG format)
    const parts = [
      buildThreadHeader({ displayPrefix: dp, threadId, sender, hasMessage: hasCurrentMessage, catchup }),
    ];

    // Thread context: previous messages (excluding trigger) — no media download for context
    const contextMsgs = (snapshot.newMessages || []).filter(m => m.id !== message.id);
    if (contextMsgs.length > 0) {
      const lines = contextMsgs.map(m => {
        const ctxAtt = formatAttachments(m.parts);
        return `[${escapeXml(msgSender(m))}]: ${escapeXml(m.content || '')}${escapeXml(ctxAtt)}`;
      });
      parts.push(`<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n`);
    }

    if (lifecycleBlock) parts.push(lifecycleBlock);

    // Smart mode hint
    if (isInteractiveDelivery && !catchup && !isRealMention && perThreadMode === 'smart') {
      parts.push('<smart-mode>\nDecide whether to respond. Reply with exactly [SKIP] when a response is unnecessary.\n</smart-mode>\n\n');
    }

    // Reply-to context (like TG's replying-to format)
    if (message.reply_to_message) {
      const reply = message.reply_to_message;
      const replySender = escapeXml(reply.sender_name || reply.sender_id || 'unknown');
      const replyContent = escapeXml(reply.content || '');
      const replyAtt = escapeXml(formatAttachments(reply.parts));
      parts.push(`<replying-to>\n[${replySender}]: ${replyContent}${replyAtt}\n</replying-to>\n\n`);
    }

    // Current message (includes non-text attachments with local paths when downloaded)
    if (hasCurrentMessage) {
      parts.push(`<current-message>\n${escapeXml(content)}${escapeXml(attachments)}\n</current-message>`);
    }

    // Include trigger message ID in endpoint for reply-to on send (like TG's msg: pattern)
    const msgIdSuffix = hasCurrentMessage ? `|msg:${message.id}` : '';
    if (hasCurrentMessage) {
      console.log(`${lp} Thread ${threadId} from ${sender}${catchup ? ' (catch-up)' : ''} (${snapshot.bufferedCount} buffered)`);
    } else {
      console.log(`${lp} Thread ${threadId} lifecycle delivery (${reason})`);
    }
    // Awaited for BOTH live and replay: only a C4 acknowledgement makes this
    // message "delivered" (see the handler's gate.mark()). The delivery id is
    // stable per (thread, message) so the C4 spool and `--request-id` treat a
    // replay as the same delivery, while a lifecycle notice gets a fresh one.
    await sendToC4Awaited(C4_CHANNEL, c4Endpoint(label, `thread:${threadId}${msgIdSuffix}`), parts.join(''), {
      deliveryId: hasCurrentMessage
        ? `hxa:${label}:thread:${threadId}:${message.id}`
        : `hxa:${label}:thread-lifecycle:${threadId}:${randomUUID()}`,
      assistantIdentity: hasCurrentMessage
        ? stableC4Identity(label, 'thread', `${threadId}:${message.id}`)
        : null,
    });
    return DELIVERY_OK;
  }

  threadCtx.onMention(async ({ threadId, message, snapshot, reason }) => {
    try {
      // zylos-lab-hxa-access: groupPolicy=disabled must stop every thread
      // delivery (messages, invites, thread_created), not only reason==='message'.
      if ((org.access?.groupPolicy || 'open') === 'disabled') {
        console.log(`${lp} Thread ${threadId} skipped (groupPolicy: disabled)`);
        return;
      }
      const wire = message || {};
      const at = Number(wire.created_at) || Date.now();
      if (gate.isSeen(wire.id)) {
        console.log(`${lp} Thread ${threadId} message ${wire.id} already handled, skipping realtime duplicate`);
        return;
      }
      if (wire.id) gate.begin(wire.id);
      let outcome;
      let error;
      try {
        outcome = await deliverThread({ threadId, message, snapshot, reason, catchup: false });
      } catch (err) {
        error = err;
      }
      settleLiveDelivery({
        outcome, error, id: wire.id, at, gate,
        markGap: () => catchupState.markGap(label),
        save: () => catchupState.scheduleSave(),
      });
      if (error) throw error;
    } catch (err) {
      console.error(`${lp} Thread handler error: ${redactSecrets(err?.message || err)}`);
    }
  });

  client.on('thread_message', (msg) => {
    const message = msg.message || {};
    if (isSelf(message.sender_id, message.metadata)) return;
    const sender = message.sender_name || message.sender_id || 'unknown';
    const content = message.content || '';
    console.log(`${lp} Thread ${msg.thread_id} from ${sender} (buffered): ${content.substring(0, 80)}`);
  });
  client.on('thread_updated', (msg) => {
    const thread = msg.thread || {};
    const changes = msg.changes || [];
    const topic = thread.topic || 'untitled';
    console.log(`${lp} Thread updated: "${topic}" changes: ${changes.join(', ')}`);
  });

  client.on('thread_artifact', (msg) => {
    const threadId = msg.thread_id;
    const artifact = msg.artifact || {};
    const action = msg.action || 'added';
    console.log(`${lp} Thread ${threadId} artifact ${action}: ${artifact.artifact_key}`);
  });

  client.on('thread_participant', (msg) => {
    const threadId = msg.thread_id;
    const botName = msg.bot_name || msg.bot_id;
    const action = msg.action;
    const by = msg.by ? ` (by ${msg.by})` : '';
    const labelTag = msg.label ? ` [${msg.label}]` : '';
    console.log(`${lp} Thread ${threadId}: ${botName} ${action}${by}`);
  });

  client.on('thread_status_changed', (msg) => {
    const threadId = msg.thread_id;
    const topic = msg.topic || 'untitled';
    const from = msg.from || 'unknown';
    const to = msg.to || 'unknown';
    const by = msg.by ? ` (by ${msg.by})` : '';
    console.log(`${lp} Thread status changed: "${topic}" ${from} -> ${to}${by}`);
  });

  client.on('bot_online', (msg) => {
    console.log(`${lp} ${msg.bot?.name || msg.bot?.id || 'unknown'} is online`);
  });

  client.on('bot_offline', (msg) => {
    console.log(`${lp} ${msg.bot?.name || msg.bot?.id || 'unknown'} is offline`);
  });

  client.on('bot_join_request', (msg) => {
    const botName = msg.bot?.name || msg.bot?.id || 'unknown';
    const botId = msg.bot?.id || 'unknown';
    console.log(`${lp} Bot join request: ${botName} (awaiting approval)`);
    const formatted = `[${dp}] [priority:high] [action:notify-owner] Bot "${botName}" (id: ${botId}) is requesting to join the org (pending admin approval)`;
    sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), formatted, {
      deliveryId: `hxa:${label}:bot-join:${msg.bot?.id || randomUUID()}`,
    }).catch(err => console.error(`${lp} Bot join C4 queue error: ${redactSecrets(err?.message || err)}`));
  });

  client.on('bot_status_changed', (msg) => {
    const status = msg.join_status || 'unknown';
    const botName = msg.name || msg.bot_id || 'unknown';
    console.log(`${lp} Bot status changed: ${botName} → ${status}`);
    const formatted = `[${dp}] Bot "${botName}" status changed to ${status}${msg.reason ? ` (reason: ${msg.reason})` : ''}`;
    sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), formatted, {
      deliveryId: `hxa:${label}:bot-status:${msg.bot_id || msg.name || randomUUID()}:${msg.join_status || 'unknown'}`,
    }).catch(err => console.error(`${lp} Bot status C4 queue error: ${redactSecrets(err?.message || err)}`));
  });

  // ─── Connection Lifecycle ──────────────────────────────

  // Catch-up: recover messages missed while offline. Runs on the first
  // connection (baseline, nothing replayed) and after every reconnect.
  // Errors are logged and retried on the next reconnect; realtime stays up.
  const catchup = new CatchupRunner({
    client,
    label,
    state: catchupState,
    gate, // shared with the realtime handlers: one de-dup view per connection
    multiOrg: isMultiOrg,
    log: (m) => console.log(redactSecrets(`${lp} ${m}`)), // single choke point: every catch-up log line is redacted

    // Reuse the realtime DM pipeline verbatim (policy, media, C4 format).
    deliverMessage: async ({ kind, message, channelId, threadId }) => {
      // Throwing keeps the message queued for the next run; policy rejections
      // and self-echo resolve normally so they are not retried forever.
      if (kind === 'thread') {
        const snapshot = { thread: { id: threadId }, participants: [], newMessages: [message], bufferedCount: 0, artifacts: [], lifecycleEvents: [] };
        await deliverThread({ threadId, message, snapshot, reason: 'message', catchup: true });
        return;
      }
      // Same intake seam as the socket: the policy gate (including its signed
      // rejection notice), the in-flight guard and the stable C4 delivery
      // identity must all apply to a replayed DM exactly as they do live.
      // `deliverDm` alone would skip the gate, so a replayed denial would be
      // silently accepted and a pending notice could never retry.
      // The runner knows the channel id it scanned; the message row may not
      // carry one. Keep it on the normalized message so `processDm` addresses
      // the same target the scan did.
      const outcome = await processDm(
        { ...message, channel_id: message?.channel_id || channelId },
        'catchup',
        // The runner reserved this id before calling back; tell the intake
        // seam that reservation is ours so it does not defer itself.
        { ownReservations: message?.id ? [message.id] : [] },
      );
      // A policy retry (notice still backing off) is not a final answer: throw
      // so the runner keeps the message queued instead of marking it handled.
      if (outcome?.action === 'retry') {
        const err = new Error(`DM ${message?.id} still awaiting policy-notice retry`);
        err.retryable = true;
        throw err;
      }
    },

    // One notice line before a large replay. Goes to the same channel as the
    // messages themselves (admin endpoint) so it shows up in context.
    deliverSummary: async (text) => {
      // Best effort: a summary line is an aid, not a guarantee. Await it so a
      // spool failure is LOGGED here instead of escaping as an unhandled
      // rejection (which can take the process down), but never let it stop the
      // replay itself.
      try {
        await sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), text);
      } catch (err) {
        console.warn(`${lp} Catch-up summary not delivered: ${redactSecrets(err?.message || err)}`);
      }
    },

    // Invites / status changes that happened while offline: reuse the realtime
    // notification path (admin channel) so they are visible, not just logged.
    deliverEvent: async (event) => {
      // Offline lifecycle events go through the SAME policy boundary as the
      // realtime handlers: groupPolicy=disabled means thread activity is not
      // delivered at all, invites included (their metadata names the topic).
      const decision = decideCatchupEvent({ access: org.access, event });
      if (decision.verdict === POLICY_REJECT) {
        console.log(`${lp} catch-up event ${event.type} dropped (${decision.reason})`);
        return;
      }
      const text = formatCatchupEventLine({ label, event, multiOrg: isMultiOrg });
      if (event.type === 'thread_invited' || event.type === 'thread_status_changed') {
        try {
          await sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), text);
        } catch (err) {
          console.warn(`${lp} Catch-up event notice not delivered: ${redactSecrets(err?.message || err)}`);
        }
      } else {
        console.log(`${lp} catch-up event: ${text}`);
      }
    },
  });

  client.on('close', () => {
    catchupState.markGap(label);
    catchupState.scheduleSave();
  });

  client.on('reconnecting', ({ attempt, delay }) => {
    catchupState.markGap(label);
    catchupState.scheduleSave();
    console.log(`${lp} Reconnecting (attempt ${attempt}, delay ${delay}ms)...`);
  });

  client.on('reconnected', ({ attempts }) => {
    console.log(`${lp} Reconnected after ${attempts} attempt(s)`);
    // Two independent recovery paths, both fire-and-forget so realtime event
    // handling is never blocked: catch-up replays the hub event log from the
    // watermark, and the inbox poll asks the hub for anything the socket
    // missed while it looked healthy. Both de-duplicate on message id.
    catchup.run('reconnected').catch(err => {
      console.error(`${lp} Catch-up run error: ${redactSecrets(err?.message || err)}`);
    });
    dmReconciler.pollOnce().catch(err => {
      console.warn(`${lp} Immediate DM reconciliation after reconnect failed: ${redactSecrets(err?.message || err)}`);
    });
  });

  client.on('reconnect_failed', ({ attempts }) => {
    console.error(`${lp} Reconnect failed after ${attempts} attempts`);
  });

  client.on('error', (err) => {
    console.error(`${lp} Error: ${redactSecrets(err?.message || err)}`);
  });

  client.on('session_invalidated', ({ code, reason }) => {
    console.error(`${lp} Session invalidated (code ${code}): ${reason || 'unknown'}`);
    console.error(`${lp} SDK will not auto-reconnect — exiting for PM2 restart`);
    process.exit(1);
  });

  client.on('*', (msg) => {
    if (msg?.type && !HANDLED_EVENTS.has(msg.type)) {
      console.log(`${lp} Unhandled event: ${msg.type}`, JSON.stringify(msg).substring(0, 200));
    }
  });

  connections.set(label, { client, threadCtx, config: org, catchup, dmReconciler, diagnostics });
}

// ─── Start All Connections ─────────────────────────────────

console.log(`[hxa-connect] Starting ${connections.size} org connection(s): ${orgLabels.join(', ')}`);

async function connectOrg(label, { client, threadCtx, catchup, dmReconciler, diagnostics, config: org }) {
  const lp = logPrefix(label);
  const INITIAL_DELAY = 3000;
  const MAX_DELAY = 60000;
  const BACKOFF = 1.5;
  let attempt = 0;

  console.log(`${lp} Connecting as "${org.agentName}" to ${org.hubUrl} (org: ${org.orgId})`);

  while (attempt < MAX_CONNECT_ATTEMPTS) {
    try {
      await client.connect();
      console.log(`${lp} WebSocket connected`);
      diagnostics.connected();
      await threadCtx.start();
      console.log(`${lp} ThreadContext started (mention filter for @${org.agentName})`);
      // First connection: the catch-up run establishes the baseline (or resumes
      // an unfinished replay) and is serialised with the reconnect trigger
      // inside the runner. The inbox reconciler starts polling on the same
      // boundary, so a DM that never arrived over the socket is still found.
      catchup.run('connected').catch(err => {
        console.error(`${lp} Catch-up run error: ${redactSecrets(err?.message || err)}`);
      });
      await dmReconciler.start();
      console.log(`${lp} Durable DM inbox reconciliation started (interval=${DM_RECONCILE_INTERVAL_MS}ms)`);
      return;
    } catch (err) {
      try { client.disconnect(); } catch {}
      attempt++;
      const delay = Math.min(INITIAL_DELAY * Math.pow(BACKOFF, attempt - 1), MAX_DELAY);
      console.error(`${lp} Connection attempt ${attempt} failed: ${redactSecrets(err.message)}`);
      if (attempt >= MAX_CONNECT_ATTEMPTS) {
        console.error(`${lp} Giving up after ${attempt} attempts`);
        try { client.disconnect(); } catch {}
        connections.delete(label);
        return;
      }
      console.log(`${lp} Retrying in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

await Promise.allSettled(
  [...connections.entries()].map(([label, conn]) => connectOrg(label, conn))
);

if (connections.size === 0) {
  console.error('[hxa-connect] No orgs connected successfully — exiting');
  process.exit(1);
}

console.log(`[hxa-connect] ${connections.size} org(s) connected`);
console.log(`[hxa-connect] Proxy: ${PROXY_URL || 'none'}`);
console.log(`[hxa-connect] C4 durable spool: ${C4_SPOOL_DIR}`);
console.log(`[hxa-connect] C4 assistant response stream: ${supportsAssistantResponseStream ? 'enabled' : 'legacy fallback'}`);

// Graceful shutdown
function shutdown() {
  console.log('[hxa-connect] Shutting down...');
  for (const { client, threadCtx, catchup, dmReconciler } of connections.values()) {
    catchup?.dispose?.();
    dmReconciler?.stop();
    threadCtx.stop();
    client.disconnect();
  }
  c4Queue.stop();
  try { catchupState.flush(); } catch {}
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
