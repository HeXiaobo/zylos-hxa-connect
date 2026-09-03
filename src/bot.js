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
import { isThreadAllowed, isSenderAllowed } from './lib/auth.js';
import { C4DeliveryQueue } from './lib/c4-delivery-queue.js';
import { DmInboxReconciler, DmInboxState } from './lib/dm-inbox-reconciler.js';
import {
  DmPolicyRejectionStore,
  createDmPolicyGate,
  createDmPolicyRejectionHandler,
} from './lib/dm-policy-rejection.js';
import { dmResponseEndpoint } from './lib/assistant-response-delivery.js';
import { getMediaBaseDir, generateFilename } from './lib/media.js';
import { getRuntimePaths } from './lib/config-path.js';
import { SuppressionTracker } from './lib/suppression-tracker.js';
import { effectiveText, isLikelyNonSubstantive, loadWhitelist } from './lib/message-classify.js';

const {
  c4ReceivePath: C4_RECEIVE,
  c4SpoolDir: C4_SPOOL_DIR,
  dataDir: DATA_DIR,
  dmInboxStatePath: DM_INBOX_STATE_PATH,
  dmPolicyRejectionDir: DM_POLICY_REJECTION_DIR,
} = getRuntimePaths();
const configuredDmReconcileInterval = Number.parseInt(process.env.HXA_DM_RECONCILE_INTERVAL_MS || '15000', 10);
const DM_POLICY_NOTICE_SECRET = process.env.HXA_DM_POLICY_NOTICE_SECRET;
const DM_POLICY_NOTICE_PREVIOUS_SECRET = process.env.HXA_DM_POLICY_NOTICE_PREVIOUS_SECRET;
const DM_POLICY_NOTICE_SECRETS = {
  current: DM_POLICY_NOTICE_SECRET,
  previous: DM_POLICY_NOTICE_PREVIOUS_SECRET ? [DM_POLICY_NOTICE_PREVIOUS_SECRET] : [],
};
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
    console.warn(`${lp} Failed to create media dir ${orgDir}: ${err.message}`);
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
      console.warn(`${lp} Media download error for ${part.url}: ${err.message}`);
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

  const isSelf = (id, metadata) => {
    if (!org.agentId || id !== org.agentId) return false;
    // Human-authored messages via Web UI should not be treated as self-echo
    const meta = typeof metadata === 'string'
      ? (() => { try { return JSON.parse(metadata); } catch { return null; } })()
      : metadata;
    if (meta?.provenance?.authored_by === 'human') return false;
    return true;
  };

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

  const dmInFlight = new Map();

  const suppressionEnabled = process.env.HXA_SUPPRESS_ENABLED === '1' || process.env.HXA_SUPPRESS_ENABLED === 'true';
  console.log(`${lp} Suppression ${suppressionEnabled ? 'enabled' : 'disabled (default)'} via HXA_SUPPRESS_ENABLED=${process.env.HXA_SUPPRESS_ENABLED || '(unset)'}`);

  const suppressionTracker = new SuppressionTracker({
    logPath: path.join(DATA_DIR, 'suppression-log.jsonl'),
    alertThreshold: 5,
    suppressAfter: 1,
    alertCooldownMs: 1_800_000,
    alertFn: ({ senderKey, senderName, count, windowSec, reason }) => {
      const reasonTag = reason === 'recovered' ? 'RECOVERED' : 'ALERT';
      const modeTag = suppressionEnabled ? '' : ' [SHADOW]';
      const msg = reason === 'recovered'
        ? `[suppression-recovered${modeTag}] ${senderName} (${senderKey}) resumed substantive messages after ${count} suppressed in ${windowSec}s`
        : `[suppression-alert${modeTag}] ${count} consecutive non-substantive messages from ${senderName} (${senderKey}) in ${windowSec}s reason=${reason} — review suppression-log.jsonl`;
      if (!suppressionEnabled) {
        console.log(`${lp} would-alert: ${msg}`);
        return;
      }
      sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), msg, {
        deliveryId: `hxa:${label}:suppression-${reasonTag.toLowerCase()}:${Date.now()}`,
      }).catch(err => console.error(`${lp} suppression ${reasonTag.toLowerCase()} send failed: ${err.message}`));
    },
  });

  console.log(`${lp} Suppression config: suppressAfter=${suppressionTracker.suppressAfter} alertThreshold=${suppressionTracker.alertThreshold} maxRepeatLength=${suppressionTracker.maxRepeatLength} windowMs=${suppressionTracker.windowMs}`);

  const whitelistPath = process.env.HXA_NOINFO_PATTERNS_FILE || path.join(DATA_DIR, 'known-noinfo-patterns.json');
  const wlResult = loadWhitelist(whitelistPath);
  console.log(`${lp} Whitelist ${wlResult.loaded ? `loaded (${wlResult.count} patterns)` : `not loaded: ${wlResult.reason}`} from ${whitelistPath}`);

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

  async function processDm(raw, source) {
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
      const policyResult = await dmPolicyGate.evaluate(message, {
        source,
        access: org.access,
      });
      if (policyResult.action !== 'continue') {
        console.log(`${lp} DM discarded id=${message.id} source=${source} sender=${sender} reason=${policyResult.reason}${policyResult.notificationStatus ? ` notification=${policyResult.notificationStatus}` : ''}`);
        return policyResult;
      }

      const msgText = effectiveText(message);
      const nonSubstantive = isLikelyNonSubstantive(message);
      const { suppress, consecutiveCount, reason } = suppressionTracker.evaluate({
        messageId: message.id, senderId: message.sender_id,
        senderName: sender, orgLabel: label,
        content: msgText, context: 'dm', nonSubstantive,
      });
      if (suppress && suppressionEnabled) {
        suppressionTracker.persistSuppressed(message, { context: 'dm', orgLabel: label, source, effectiveText: msgText, reason });
        console.log(`${lp} DM suppressed id=${message.id} source=${source} sender=${sender} reason=${reason} count=${consecutiveCount}`);
        return { action: 'suppressed', reason: reason || 'unknown', consecutiveCount };
      } else if (suppress) {
        suppressionTracker.persistSuppressed(message, { context: 'dm', orgLabel: label, source, effectiveText: msgText, reason });
        console.log(`${lp} DM would-suppress id=${message.id} source=${source} sender=${sender} reason=${reason} (shadow mode)`);
      }

      const rlKey = `${label}:dm:${message.sender_id || sender}`;
      if (!getRateLimiter(rlKey).consume()) {
        console.warn(`${lp} DM deferred id=${message.id} source=${source} sender=${sender} reason=rate_limit`);
        return { action: 'retry', reason: 'rate_limit' };
      }

      const localPaths = await downloadMediaParts(message.parts, client, label, lp);
      const attachments = formatAttachments(message.parts, localPaths);
      if ((message.content.length + attachments.length) > MAX_CONTENT_LENGTH) {
        console.warn(`${lp} DM discarded id=${message.id} source=${source} sender=${sender} reason=content_too_large bytes=${message.content.length + attachments.length}`);
        return { action: 'discarded', reason: 'content_too_large' };
      }

      console.log(`${lp} DM from ${sender} id=${message.id} source=${source}: ${msgText.substring(0, 80)}`);
      const formatted = `[${dp} DM] ${sender} said: ${message.content}${attachments}`;
      const queued = await sendToC4(C4_CHANNEL, dmResponseEndpoint(label, sender, message.id, {
        multiOrg: isMultiOrg,
      }), formatted, {
        deliveryId: `hxa:${label}:dm:${message.id}`,
        assistantIdentity: stableC4Identity(label, 'dm', message.id),
      });
      return { action: 'accepted', ...queued };
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
      console.error(`${lp} DM handler error: ${err.message}`);
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

  threadCtx.onMention(async ({ threadId, message, snapshot, reason }) => {
    try {
      const sender = msgSender(message);
      const content = message.content || '';
      const isInteractiveDelivery = reason === 'message';

      // groupPolicy / sender policy apply to interactive thread messages only.
      if (isInteractiveDelivery && !isThreadAllowed(org.access, threadId)) {
        console.log(`${lp} Thread ${threadId} rejected (groupPolicy: ${org.access?.groupPolicy || 'open'})`);
        return;
      }
      if (isInteractiveDelivery && !isSenderAllowed(org.access, threadId, sender)) {
        console.log(`${lp} Sender ${sender} rejected in thread ${threadId}`);
        return;
      }

      const isRealMention = mentionRe.test(extractText(message)) || !!message.mention_all;
      const perThreadMode = getThreadMode(threadId);

      // Mention-mode gating only applies to interactive thread messages.
      if (isInteractiveDelivery && perThreadMode === 'mention' && !isRealMention) {
        return;
      }

      const hasCurrentMessage = !!message.id;

      if (hasCurrentMessage && isInteractiveDelivery) {
        console.log(`${lp} Thread msg fields: ${Object.keys(message).join(',')}`);
      }

      if (hasCurrentMessage && isInteractiveDelivery) {
        const threadMsgText = effectiveText(message);
        const threadNonSubstantive = isLikelyNonSubstantive(message);
        const { suppress, consecutiveCount, reason: suppressReason } = suppressionTracker.evaluate({
          messageId: message.id, senderId: message.sender_id,
          senderName: sender, orgLabel: label,
          content: threadMsgText, context: `thread:${threadId}`, nonSubstantive: threadNonSubstantive,
        });
        if (suppress && suppressionEnabled) {
          suppressionTracker.persistSuppressed(message, { context: `thread:${threadId}`, orgLabel: label, source: 'thread', effectiveText: threadMsgText, reason: suppressReason });
          console.log(`${lp} Thread ${threadId} from ${sender} suppressed reason=${suppressReason} count=${consecutiveCount}`);
          return;
        } else if (suppress) {
          suppressionTracker.persistSuppressed(message, { context: `thread:${threadId}`, orgLabel: label, source: 'thread', effectiveText: threadMsgText, reason: suppressReason });
          console.log(`${lp} Thread ${threadId} from ${sender} would-suppress reason=${suppressReason} count=${consecutiveCount} (shadow mode)`);
        }
      }

      if (isInteractiveDelivery) {
        const rlKey = `${label}:thread:${message.sender_id || sender}`;
        if (!getRateLimiter(rlKey).consume()) {
          console.warn(`${lp} Thread ${threadId} from ${sender} rate-limited, dropping`);
          return;
        }
      }

      // Download media for trigger message (after policy checks)
      const localPaths = await downloadMediaParts(message.parts, client, label, lp);
      const attachments = formatAttachments(message.parts, localPaths);

      if ((content.length + attachments.length) > MAX_CONTENT_LENGTH) {
        console.warn(`${lp} Thread ${threadId} from ${sender} rejected — content too large (${content.length + attachments.length} bytes)`);
        return;
      }

      const lifecycleBlock = buildLifecycleBlock(snapshot);

      // Build C4 message with XML tags (consistent with Lark/TG format)
      const parts = [
        hasCurrentMessage
          ? `[${dp} Thread:${threadId}] ${sender} said: `
          : `[${dp} Thread:${threadId}] System update: `,
      ];

      // Thread context: previous messages (excluding trigger) — no media download for context
      const contextMsgs = snapshot.newMessages.filter(m => m.id !== message.id);
      if (contextMsgs.length > 0) {
        const lines = contextMsgs.map(m => {
          const ctxAtt = formatAttachments(m.parts);
          return `[${escapeXml(msgSender(m))}]: ${escapeXml(m.content || '')}${escapeXml(ctxAtt)}`;
        });
        parts.push(`<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n`);
      }

      if (lifecycleBlock) parts.push(lifecycleBlock);

      // Smart mode hint
      if (isInteractiveDelivery && !isRealMention && perThreadMode === 'smart') {
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
        console.log(`${lp} Thread ${threadId} from ${sender} (${snapshot.bufferedCount} buffered)`);
      } else {
        console.log(`${lp} Thread ${threadId} lifecycle delivery (${reason})`);
      }
      await sendToC4(C4_CHANNEL, c4Endpoint(label, `thread:${threadId}${msgIdSuffix}`), parts.join(''), {
        deliveryId: hasCurrentMessage
          ? `hxa:${label}:thread:${threadId}:${message.id}`
          : `hxa:${label}:thread-lifecycle:${threadId}:${randomUUID()}`,
        assistantIdentity: hasCurrentMessage
          ? stableC4Identity(label, 'thread', `${threadId}:${message.id}`)
          : null,
      });
    } catch (err) {
      console.error(`${lp} Thread handler error: ${err.message}`);
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
    }).catch(err => console.error(`${lp} Bot join C4 queue error: ${err.message}`));
  });

  client.on('bot_status_changed', (msg) => {
    const status = msg.join_status || 'unknown';
    const botName = msg.name || msg.bot_id || 'unknown';
    console.log(`${lp} Bot status changed: ${botName} → ${status}`);
    const formatted = `[${dp}] Bot "${botName}" status changed to ${status}${msg.reason ? ` (reason: ${msg.reason})` : ''}`;
    sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), formatted, {
      deliveryId: `hxa:${label}:bot-status:${msg.bot_id || msg.name || randomUUID()}:${msg.join_status || 'unknown'}`,
    }).catch(err => console.error(`${lp} Bot status C4 queue error: ${err.message}`));
  });

  // ─── Connection Lifecycle ──────────────────────────────

  client.on('reconnecting', ({ attempt, delay }) => {
    console.log(`${lp} Reconnecting (attempt ${attempt}, delay ${delay}ms)...`);
  });

  client.on('reconnected', ({ attempts }) => {
    console.log(`${lp} Reconnected after ${attempts} attempt(s)`);
    dmReconciler.pollOnce().catch(err => {
      console.warn(`${lp} Immediate DM reconciliation after reconnect failed: ${err.message}`);
    });
  });

  client.on('reconnect_failed', ({ attempts }) => {
    console.error(`${lp} Reconnect failed after ${attempts} attempts`);
  });

  client.on('error', (err) => {
    console.error(`${lp} Error: ${err?.message || err}`);
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

  connections.set(label, { client, threadCtx, dmReconciler, config: org });
}

// ─── Start All Connections ─────────────────────────────────

console.log(`[hxa-connect] Starting ${connections.size} org connection(s): ${orgLabels.join(', ')}`);

async function connectOrg(label, { client, threadCtx, dmReconciler, config: org }) {
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
      await threadCtx.start();
      console.log(`${lp} ThreadContext started (mention filter for @${org.agentName})`);
      await dmReconciler.start();
      console.log(`${lp} Durable DM inbox reconciliation started (interval=${DM_RECONCILE_INTERVAL_MS}ms)`);
      return;
    } catch (err) {
      try { client.disconnect(); } catch {}
      attempt++;
      const delay = Math.min(INITIAL_DELAY * Math.pow(BACKOFF, attempt - 1), MAX_DELAY);
      console.error(`${lp} Connection attempt ${attempt} failed: ${err.message}`);
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
  for (const { client, threadCtx, dmReconciler } of connections.values()) {
    dmReconciler.stop();
    threadCtx.stop();
    client.disconnect();
  }
  c4Queue.stop();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
