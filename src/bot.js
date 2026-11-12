/**
 * zylos-hxa-connect - HXA-Connect WebSocket client for Zylos Bot
 * Connects to HXA-Connect hubs via SDK and bridges messages to C4.
 * Supports multiple orgs simultaneously.
 *
 * Handles: DM, threads, artifacts, participant events.
 * Uses hxa-connect-sdk for WS (session-based auth, auto-reconnect, 1012 support).
 */

import * as hxaSdk from '@coco-xyz/hxa-connect-sdk';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { migrateConfig, resolveOrgs, setupFetchProxy, PROXY_URL } from './env.js';
import { isDmAllowed, isThreadAllowed, isSenderAllowed } from './lib/auth.js';
import { MEDIA_BASE_DIR, generateFilename } from './lib/media.js';
// zylos-lab-hxa-catchup: recover messages missed while offline / restarting.
import { CatchupRunner, DeliveryGate, formatCatchupEventLine } from './lib/catchup.js';
import { buildDmContent, buildThreadHeader } from './lib/format.js';
import { CatchupStateStore, resolveCatchupStatePath } from './lib/catchup-state.js';

const HOME = process.env.HOME;
const C4_RECEIVE = path.join(HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

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
  const orgDir = path.join(MEDIA_BASE_DIR, orgLabel);

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

// ─── C4 Concurrency Cap (M-07) ──────────────────────────

const MAX_CONCURRENT_C4 = 10;
let _activeC4Calls = 0;

const wsOptions = {
  maxPayload: MAX_WS_PAYLOAD,
  ...(PROXY_URL ? { agent: new HttpsProxyAgent(PROXY_URL) } : {}),
};

// ─── C4 Bridge ─────────────────────────────────────────────

function executeC4(c4Args) {
  return new Promise((resolve, reject) => {
    execFile('node', c4Args, { encoding: 'utf8' }, (error, stdout) => {
      if (!error) return resolve(stdout);
      try {
        const response = JSON.parse(error.stdout || stdout || '{}');
        if (response.ok === false && response.error?.message) {
          // Definitive rejection — retrying will not help.
          return reject(Object.assign(new Error(response.error.message), { c4Rejected: true }));
        }
      } catch {}
      reject(new Error(error.message));
    });
  });
}

function sendToC4(channel, endpoint, content) {
  if (!content) return;
  if (_activeC4Calls >= MAX_CONCURRENT_C4) {
    console.warn(`[hxa-connect] C4 concurrency cap reached (${MAX_CONCURRENT_C4}), dropping message`);
    return;
  }
  _activeC4Calls++;
  const c4Args = [C4_RECEIVE, '--channel', channel, '--endpoint', endpoint, '--json', '--content', content];

  execFile('node', c4Args, { encoding: 'utf8' }, (error, stdout) => {
    _activeC4Calls--;
    if (!error) {
      console.log(`[hxa-connect] -> C4: ${content.substring(0, 80)}...`);
      return;
    }
    try {
      const response = JSON.parse(error.stdout || stdout || '{}');
      if (response.ok === false && response.error?.message) {
        console.warn(`[hxa-connect] C4 rejected: ${response.error.message}`);
        return;
      }
    } catch {}
    console.warn(`[hxa-connect] C4 send failed, retrying: ${error.message}`);
    setTimeout(() => {
      if (_activeC4Calls >= MAX_CONCURRENT_C4) {
        console.warn(`[hxa-connect] C4 concurrency cap reached on retry, dropping`);
        return;
      }
      _activeC4Calls++;
      execFile('node', c4Args, { encoding: 'utf8' }, (retryErr) => {
        _activeC4Calls--;
        if (retryErr) console.error(`[hxa-connect] C4 retry failed: ${retryErr.message}`);
        else console.log(`[hxa-connect] -> C4 (retry): ${content.substring(0, 80)}...`);
      });
    }, 2000);
  });
}

/**
 * Awaited variant used by catch-up: the watermark may only move past a message
 * once C4 actually accepted it, otherwise a failed replay would be lost.
 * Throws on rejection so the runner stops and retries on the next reconnect.
 */
async function sendToC4Awaited(channel, endpoint, content) {
  if (!content) return;
  const c4Args = [C4_RECEIVE, '--channel', channel, '--endpoint', endpoint, '--json', '--content', content];
  const capExceeded = () => {
    const err = new Error(`C4 concurrency cap reached (${MAX_CONCURRENT_C4})`);
    err.retryable = true;
    return err;
  };

  if (_activeC4Calls >= MAX_CONCURRENT_C4) throw capExceeded();
  _activeC4Calls++;
  try {
    try {
      await executeC4(c4Args);
      console.log(`[hxa-connect] -> C4: ${content.substring(0, 80)}...`);
      return;
    } catch (err) {
      if (err.c4Rejected) throw err; // policy rejection: retrying will not help
      console.warn(`[hxa-connect] C4 send failed, retrying: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
    await executeC4(c4Args);
    console.log(`[hxa-connect] -> C4 (retry): ${content.substring(0, 80)}...`);
  } finally {
    _activeC4Calls--;
  }
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

const CATCHUP_STATE_PATH = resolveCatchupStatePath({ home: HOME });
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

  // A restart or a dropped socket means we may have missed messages: mark the
  // org dirty so realtime deliveries stop advancing the catch-up watermark
  // until a replay has confirmed the gap is covered.
  if (catchupState.getWatermark(label)) catchupState.setDirty(label, true);

  /** Advance the watermark past a message handled outside the shared pipeline. */
  const markHandled = (id, at) => {
    gate.mark(id, at);
    catchupState.scheduleSave();
  };

  /**
   * Single delivery pipeline for one DM message.
   * Used by both the realtime 'message' handler and catch-up, so policy,
   * attachment handling and C4 formatting stay identical.
   * Throw on failure so catch-up can retry the message on the next reconnect.
   */
  const deliverDm = async ({ message, sender_name: senderName, parts, catchup = false }) => {
    const sender = senderName || message.sender_name || 'unknown';
    const content = message.content || '';
    if (isSelf(message.sender_id, message.metadata)) return;

    if (!isDmAllowed(org.access, sender)) {
      console.log(`${lp} DM from ${sender} rejected (dmPolicy: ${org.access?.dmPolicy || 'open'})`);
      return;
    }

    if (!catchup) {
      // Rate limiting is a realtime-only concern; replayed messages are already
      // throttled in batches by the catch-up runner.
      const rlKey = `${label}:dm:${message.sender_id || sender}`;
      if (!getRateLimiter(rlKey).consume()) {
        console.warn(`${lp} DM from ${sender} rate-limited, dropping`);
        return;
      }
    }

    // Download media after policy checks to avoid wasted effort
    const msgParts = message.parts || parts;
    const localPaths = await downloadMediaParts(msgParts, client, label, lp);
    const attachments = formatAttachments(msgParts, localPaths);

    if ((content.length + attachments.length) > MAX_CONTENT_LENGTH) {
      console.warn(`${lp} DM from ${sender} rejected — content too large (${content.length + attachments.length} bytes)`);
      return;
    }

    console.log(`${lp} DM from ${sender}${catchup ? ' (catch-up)' : ''}: ${content.substring(0, 80)}`);
    const formatted = buildDmContent({ displayPrefix: dp, sender, content, attachments, catchup });
    if (catchup) {
      // Awaited so the watermark only advances once C4 accepted the message.
      await sendToC4Awaited(C4_CHANNEL, c4Endpoint(label, sender), formatted);
    } else {
      sendToC4(C4_CHANNEL, c4Endpoint(label, sender), formatted);
    }
  };

  // ─── Event Handlers ───────────────────────────────────

  client.on('message', async (msg) => {
    try {
      const wire = msg.message || {};
      const at = Number(wire.created_at) || Date.now();
      // Catch-up may already have delivered this id (and vice versa).
      if (gate.isSeen(wire.id)) {
        console.log(`${lp} DM ${wire.id} already handled, skipping realtime duplicate`);
        return;
      }
      gate.begin(wire.id);
      try {
        await deliverDm({ message: wire, sender_name: msg.sender_name, parts: msg.parts, catchup: false });
      } finally {
        gate.clear(wire.id);
      }
      markHandled(wire.id, at);
    } catch (err) {
      console.error(`${lp} DM handler error: ${err.message}`);
    }
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

    // groupPolicy / sender policy apply to interactive thread messages only.
    // Catch-up reuses them: a message that would not be delivered in realtime
    // is not delivered when replayed either.
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

    if (isInteractiveDelivery && !catchup) {
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
    if (catchup) {
      await sendToC4Awaited(C4_CHANNEL, c4Endpoint(label, `thread:${threadId}${msgIdSuffix}`), parts.join(''));
    } else {
      sendToC4(C4_CHANNEL, c4Endpoint(label, `thread:${threadId}${msgIdSuffix}`), parts.join(''));
    }
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
      try {
        await deliverThread({ threadId, message, snapshot, reason, catchup: false });
      } finally {
        gate.clear(wire.id);
      }
      markHandled(wire.id, at);
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
    sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), formatted);
  });

  client.on('bot_status_changed', (msg) => {
    const status = msg.join_status || 'unknown';
    const botName = msg.name || msg.bot_id || 'unknown';
    console.log(`${lp} Bot status changed: ${botName} → ${status}`);
    const formatted = `[${dp}] Bot "${botName}" status changed to ${status}${msg.reason ? ` (reason: ${msg.reason})` : ''}`;
    sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), formatted);
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
    log: (m) => console.log(`${lp} ${m}`),

    // Reuse the realtime DM pipeline verbatim (policy, media, C4 format).
    deliverMessage: async ({ kind, message, channelId, threadId }) => {
      if (kind === 'thread') {
        const snapshot = { thread: { id: threadId }, participants: [], newMessages: [message], bufferedCount: 0, artifacts: [], lifecycleEvents: [] };
        await deliverThread({ threadId, message, snapshot, reason: 'message', catchup: true });
        return;
      }
      await deliverDm({ message, parts: message.parts, catchup: true, channelId });
    },

    // One notice line before a large replay. Goes to the same channel as the
    // messages themselves (admin endpoint) so it shows up in context.
    deliverSummary: async (text) => {
      sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), text);
    },

    // Invites / status changes that happened while offline: reuse the realtime
    // notification path (admin channel) so they are visible, not just logged.
    deliverEvent: async (event) => {
      const text = formatCatchupEventLine({ label, event, multiOrg: isMultiOrg });
      if (event.type === 'thread_invited' || event.type === 'thread_status_changed') {
        sendToC4(C4_CHANNEL, c4Endpoint(label, 'admin'), text);
      } else {
        console.log(`${lp} catch-up event: ${text}`);
      }
    },
  });

  client.on('close', () => {
    catchupState.setDirty(label, true);
    catchupState.scheduleSave();
  });

  client.on('reconnecting', ({ attempt, delay }) => {
    catchupState.setDirty(label, true);
    catchupState.scheduleSave();
    console.log(`${lp} Reconnecting (attempt ${attempt}, delay ${delay}ms)...`);
  });

  client.on('reconnected', ({ attempts }) => {
    console.log(`${lp} Reconnected after ${attempts} attempt(s)`);
    // Fire and forget: catch-up is serialised internally and never blocks
    // realtime event handling.
    catchup.run('reconnected').catch(err => {
      console.error(`${lp} Catch-up run error: ${err?.message || err}`);
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

  connections.set(label, { client, threadCtx, config: org, catchup });
}

// ─── Start All Connections ─────────────────────────────────

console.log(`[hxa-connect] Starting ${connections.size} org connection(s): ${orgLabels.join(', ')}`);

async function connectOrg(label, { client, threadCtx, catchup, config: org }) {
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
      // First connection: establishes the baseline (or resumes an unfinished
      // replay). Serialised with the reconnect trigger inside the runner.
      catchup.run('connected').catch(err => {
        console.error(`${lp} Catch-up run error: ${err?.message || err}`);
      });
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

// Graceful shutdown
function shutdown() {
  console.log('[hxa-connect] Shutting down...');
  for (const { client, threadCtx, catchup } of connections.values()) {
    catchup?.dispose?.();
    threadCtx.stop();
    client.disconnect();
  }
  try { catchupState.flush(); } catch {}
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
