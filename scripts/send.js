#!/usr/bin/env node
/**
 * zylos-hxa-connect send interface
 *
 * Usage:
 *   node send.js <endpoint> "<message>"              — Send (org resolved from endpoint)
 *   node send.js --org coco <endpoint> "<message>"   — Send via specific org (debug override)
 *
 * Media (same convention as the feishu send.js):
 *   node send.js <endpoint> "[MEDIA:image]/abs/path/pic.png"
 *   node send.js <endpoint> "[MEDIA:file]/abs/path/report.pdf"
 *   node send.js <endpoint> "[MEDIA:image]/abs/path/pic.png\noptional caption"
 *   — the first line is the absolute path, everything after the first newline
 *     is the caption. Bad type / relative path / missing file exit 1 and never
 *     fall back to sending the path as text.
 *
 * Called by C4 comm-bridge to send outbound messages via HXA-Connect SDK.
 *
 * Endpoint encoding (set by bot.js):
 *   "bot-name"                 → DM to bot-name, default org
 *   "thread:uuid"              → Thread message, default org
 *   "org:coco|bot-name"        → DM to bot-name, org "coco"
 *   "org:coco|thread:uuid"     → Thread message, org "coco"
 *
 * Backward compatible: endpoints without org: prefix use the default org.
 */

import { HxaConnectClient } from '@coco-xyz/hxa-connect-sdk';
// zylos-lab-hxa-redact: never log tokens/tickets/Authorization values.
import { redactSecrets } from '../src/lib/redact.js';
import {
  MediaMessageError,
  deliverMessage,
  parseMediaMessage,
  uploadMedia,
} from '../src/lib/media-send.js';
import { migrateConfig, resolveOrgs, setupFetchProxy } from '../src/env.js';

const ORG_PREFIX_RE = /^org:([a-z0-9][a-z0-9-]*)\|(.+)$/;

function parseEndpoint(raw) {
  const m = raw.match(ORG_PREFIX_RE);
  if (m) return { orgLabel: m[1], target: m[2] };
  return { orgLabel: null, target: raw };
}

const rawArgs = process.argv.slice(2);

let orgOverride = null;
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--org' && i + 1 < rawArgs.length) {
    orgOverride = rawArgs[++i];
  } else {
    args.push(rawArgs[i]);
  }
}

if (args.length < 2) {
  console.error('Usage: node send.js [--org <label>] <endpoint> "<message>"');
  console.error('');
  console.error('Endpoint formats:');
  console.error('  <bot_name>              DM (default org)');
  console.error('  thread:<id>             Thread message (default org)');
  console.error('  org:<label>|<bot_name>  DM via specific org');
  console.error('  org:<label>|thread:<id> Thread message via specific org');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

// Parse the [MEDIA:...] prefix before any network work so a bad attachment
// fails loudly instead of leaking the path into the chat as text.
let mediaRequest = null;
try {
  mediaRequest = parseMediaMessage(message);
} catch (err) {
  if (err instanceof MediaMessageError) {
    console.error(`Error: ${redactSecrets(err.message)}`);
    process.exit(1);
  }
  throw err;
}

// Uploaded attachment (set once, before the send; reused by the reply_to retry)
let attachment = null;

// Content goes into the message body: caption for media (undefined when empty,
// matching the verified reference call), the whole message for plain text.
const outboundContent = mediaRequest ? (mediaRequest.text || undefined) : message;

async function prepareAttachment() {
  if (!mediaRequest || attachment) return;
  attachment = await uploadMedia(client, mediaRequest);
}

// [SKIP] check helper — used by sendAsThread to filter smart-mode no-ops
const isSkipResponse = /^\s*\[SKIP\]\s*$/i.test(message);

const { orgLabel: endpointOrg, target: rawTarget } = parseEndpoint(rawEndpoint);

// Extract msg:<id> for reply-to (like TG's msg: pattern)
const MSG_SUFFIX_RE = /\|msg:([a-f0-9-]+)$/i;
const msgMatch = rawTarget.match(MSG_SUFFIX_RE);
const replyToId = msgMatch ? msgMatch[1] : null;
const target = msgMatch ? rawTarget.slice(0, msgMatch.index) : rawTarget;

const config = migrateConfig();
const resolved = resolveOrgs(config);
const orgLabels = Object.keys(resolved.orgs);

const effectiveLabel = orgOverride || endpointOrg || (resolved.orgs.default ? 'default' : orgLabels[0]);

const org = resolved.orgs[effectiveLabel];
if (!org) {
  console.error(`Error: org "${effectiveLabel}" not found. Available: ${orgLabels.join(', ')}`);
  process.exit(1);
}

if (!org.hubUrl) {
  console.error(`Error: no hub_url configured for org "${effectiveLabel}"`);
  process.exit(1);
}

await setupFetchProxy();

const client = new HxaConnectClient({
  url: org.hubUrl,
  token: org.agentToken,
  ...(org.orgId && { orgId: org.orgId }),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sendAsThread(threadId) {
  // Filter [SKIP] responses from smart mode — only for confirmed thread sends
  if (isSkipResponse) {
    console.log(`[hxa-connect] [SKIP] response filtered — not sending to thread ${threadId}`);
    return;
  }
  const { usedReplyTo } = await deliverMessage(
    client,
    { kind: 'thread', threadId },
    outboundContent,
    attachment ? attachment.parts : undefined,
    replyToId,
  );
  if (attachment) {
    console.log(`Sent ${mediaRequest.type} to thread ${threadId}${usedReplyTo ? ` (reply_to: ${replyToId})` : ''}: ${attachment.name} (${attachment.size} bytes, file ${attachment.fileId})`);
  } else {
    console.log(`Sent to thread ${threadId}${usedReplyTo ? ` (reply_to: ${replyToId})` : ''}: ${message.substring(0, 50)}...`);
  }
}

async function sendAsDM(to) {
  await deliverMessage(client, { kind: 'dm', to }, outboundContent, attachment ? attachment.parts : undefined, null);
  if (attachment) {
    console.log(`Sent ${mediaRequest.type} to ${to}: ${attachment.name} (${attachment.size} bytes, file ${attachment.fileId})`);
  } else {
    console.log(`Sent to ${to}: ${message.substring(0, 50)}...`);
  }
}

try {
  if (target.startsWith('channel:')) {
    console.error(`Error: Cannot reply to group channel directly (HXA-Connect API limitation).`);
    console.error(`Use a bot name for DM or thread:<id> for thread messages.`);
    process.exit(1);
  }

  // Upload once, after routing rejects bad targets and before any send/retry.
  await prepareAttachment();

  if (target.startsWith('thread:')) {
    await sendAsThread(target.slice('thread:'.length));
  } else if (UUID_RE.test(target)) {
    try {
      await client.getThread(target);
      await sendAsThread(target);
    } catch (threadErr) {
      if (threadErr?.body?.code === 'NOT_FOUND' || threadErr?.status === 404) {
        await sendAsDM(target);
      } else {
        throw threadErr;
      }
    }
  } else {
    await sendAsDM(target);
  }
} catch (err) {
  if (err instanceof MediaMessageError) {
    console.error(`Error: ${redactSecrets(err.message)}`);
    process.exit(1);
  }
  console.error(`Error sending to ${target}: ${redactSecrets(err.message)}`);
  process.exit(1);
}
