/**
 * Outbound media support for the C4 send interface (scripts/send.js).
 *
 * Wire format (same convention as the feishu send.js):
 *
 *   [MEDIA:image]/abs/path/pic.png
 *   [MEDIA:file]/abs/path/report.pdf
 *   [MEDIA:image]/abs/path/pic.png
 *   caption line(s) — optional, anything after the first newline
 *
 * The path lives on the first line only, so a caption can contain newlines.
 * A malformed prefix (bad type, relative path, missing file) must never fall
 * back to sending the path as text — callers get a MediaMessageError instead.
 */

import fs from 'node:fs';
import path from 'node:path';

const MEDIA_PREFIX_RE = /^\[MEDIA:([A-Za-z0-9_.-]+)\]([\s\S]*)$/;

export class MediaMessageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaMessageError';
  }
}

export const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

/**
 * MIME type for a path, keyed on the extension. Unknown extensions fall back
 * to application/octet-stream so the hub never rejects the upload.
 */
export function mimeForPath(filePath) {
  return MIME_BY_EXT[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Parse a `[MEDIA:<type>]` message.
 *
 * @returns {null | { type: 'image' | 'file', filePath: string, text: string }}
 *   null when the message is not a media message (plain text — unchanged path).
 * @throws {MediaMessageError} unsupported media type, missing path, empty path.
 */
export function parseMediaMessage(message) {
  const raw = String(message ?? '');
  const match = raw.match(MEDIA_PREFIX_RE);
  if (!match) return null;

  const type = match[1].toLowerCase();
  if (type !== 'image' && type !== 'file') {
    throw new MediaMessageError(
      `[MEDIA:${match[1]}] is not supported here (supported: image, file)`,
    );
  }

  const body = match[2] ?? '';
  const newlineAt = body.indexOf('\n');
  const firstLine = newlineAt === -1 ? body : body.slice(0, newlineAt);
  const text = newlineAt === -1 ? '' : body.slice(newlineAt + 1).trim();
  const filePath = firstLine.trim();

  if (!filePath) {
    throw new MediaMessageError(`[MEDIA:${type}] is missing a file path`);
  }

  return { type, filePath, text };
}

/**
 * Validate and read an attachment. Runs before any network call, so a bad
 * path fails loudly instead of being sent as text.
 *
 * @returns {{ filePath: string, name: string, mime: string, size: number, buffer: Buffer }}
 * @throws {MediaMessageError} relative path, missing file, not a regular file.
 */
export function prepareMediaFile(filePath, type = 'file') {
  const label = `[MEDIA:${type}]`;

  if (!path.isAbsolute(filePath)) {
    throw new MediaMessageError(`${label} needs an absolute file path, got: ${filePath}`);
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new MediaMessageError(`${label} file not found: ${filePath}`);
    }
    throw new MediaMessageError(`${label} cannot read ${filePath} (${err?.code || err?.message})`);
  }

  if (!stat.isFile()) {
    throw new MediaMessageError(`${label} not a regular file: ${filePath}`);
  }

  const buffer = fs.readFileSync(filePath);
  return {
    filePath,
    name: path.basename(filePath),
    mime: mimeForPath(filePath),
    size: buffer.length,
    buffer,
  };
}

/**
 * Build the wire parts for an uploaded attachment.
 * image → text? + image + file (recipients render the image and keep a file ref)
 * file  → text? + file
 */
export function buildMediaParts({ type, url, name, mime, size, text }) {
  const parts = [];
  if (text) parts.push({ type: 'text', content: text });
  if (type === 'image') {
    parts.push({ type: 'image', url, alt: name });
    parts.push({ type: 'file', url, name, mime_type: mime, size });
  } else {
    parts.push({ type: 'file', url, name, mime_type: mime, size });
  }
  return parts;
}

/**
 * Upload a parsed media message to the hub of the already-resolved client and
 * return everything the caller needs to send it. Uploads exactly once.
 *
 * @returns {Promise<{fileId: string, url: string, name: string, mime: string, size: number, parts: object[]}>}
 */
export async function uploadMedia(client, media) {
  const file = prepareMediaFile(media.filePath, media.type);
  const rec = await client.uploadFile(file.buffer, file.name, file.mime);
  if (!rec || (!rec.url && !rec.id)) {
    throw new Error('file upload returned no file id or url');
  }
  const url = rec.url || client.getFileUrl(rec.id);
  return {
    fileId: rec.id,
    url,
    name: file.name,
    mime: file.mime,
    size: file.size,
    parts: buildMediaParts({
      type: media.type,
      url,
      name: file.name,
      mime: file.mime,
      size: file.size,
      text: media.text,
    }),
  };
}

/**
 * Deliver one message to a DM target or a thread.
 *
 * route = { kind: 'dm', to } | { kind: 'thread', threadId }
 *
 * Text-only calls must stay byte-identical to the pre-media behaviour:
 *   send(to, message) / sendThreadMessage(id, message, reply_to ? { reply_to } : undefined)
 *
 * For thread sends the reply_to failure retry keeps the same parts, so the
 * attachment is never uploaded twice and never dropped by the retry.
 *
 * @returns {Promise<{ usedReplyTo: boolean }>}
 */
export async function deliverMessage(client, route, content, parts, replyToId) {
  const base = parts ? { parts } : undefined;

  if (route.kind !== 'thread') {
    await client.send(route.to, content, base);
    return { usedReplyTo: false };
  }

  const { threadId } = route;
  const opts = replyToId ? { ...(base || {}), reply_to: replyToId } : base;
  let usedReplyTo = !!replyToId;
  try {
    await client.sendThreadMessage(threadId, content, opts);
  } catch (err) {
    // If reply_to fails (message deleted), retry without it — still with parts.
    if (replyToId && (err?.status === 400 || err?.body?.code === 'NOT_FOUND')) {
      console.warn(`[hxa-connect] reply_to ${replyToId} failed, sending without reply`);
      await client.sendThreadMessage(threadId, content, base);
      usedReplyTo = false;
    } else {
      throw err;
    }
  }
  return { usedReplyTo };
}
