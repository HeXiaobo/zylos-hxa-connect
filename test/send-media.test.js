/**
 * Tests for outbound media support in the C4 send interface.
 *
 * Covers the [MEDIA:image] / [MEDIA:file] contract used by scripts/send.js:
 * parsing, path validation, MIME mapping, parts construction, delivery
 * (DM + thread), the reply_to retry (upload must happen once), and the
 * unchanged plain-text path.
 *
 * The fake client mirrors the @coco-xyz/hxa-connect-sdk surface actually used:
 *   uploadFile(buffer, name, mimeType) -> FileRecord
 *   getFileUrl(fileId) -> string
 *   send(to, content?, opts?{parts})
 *   sendThreadMessage(threadId, content?, opts?{parts, reply_to})
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MediaMessageError,
  buildMediaParts,
  deliverMessage,
  mimeForPath,
  parseMediaMessage,
  prepareMediaFile,
  uploadMedia,
} from '../src/lib/media-send.js';

// ─── Fixtures ───────────────────────────────────────────────────

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-media-send-'));
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_PATH = path.join(TMP_DIR, 'shot.png');
fs.writeFileSync(PNG_PATH, PNG_BYTES);
const PDF_PATH = path.join(TMP_DIR, 'report.pdf');
fs.writeFileSync(PDF_PATH, Buffer.from('%PDF-1.4\n'));

after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeFakeClient(options = {}) {
  const { rec = { id: 'file-1', url: 'https://hub.example/api/files/file-1', name: 'x', mime_type: null, size: 0 }, threadError = null } = options;
  const calls = { upload: [], send: [], thread: [] };
  let threadAttempt = 0;

  const client = {
    calls,
    async uploadFile(buffer, name, mimeType) {
      calls.upload.push({ buffer, name, mimeType });
      return rec;
    },
    getFileUrl(fileId) {
      return `https://hub.example/api/files/${fileId}`;
    },
    async send(to, content, opts) {
      calls.send.push({ to, content, opts });
      return { channel_id: 'ch-1', message: {} };
    },
    async sendThreadMessage(threadId, content, opts) {
      threadAttempt += 1;
      calls.thread.push({ threadId, content, opts });
      if (threadError && threadAttempt === 1) throw threadError;
      return {};
    },
  };
  return client;
}

const mediaError = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a MediaMessageError, nothing was thrown');
};

// ─── parseMediaMessage ──────────────────────────────────────────

describe('parseMediaMessage', () => {
  it('parses a single-line image message', () => {
    assert.deepEqual(parseMediaMessage(`[MEDIA:image]${PNG_PATH}`), {
      type: 'image',
      filePath: PNG_PATH,
      text: '',
    });
  });

  it('parses image + caption (everything after the first newline)', () => {
    const parsed = parseMediaMessage(`[MEDIA:image]${PNG_PATH}\n  看这张图\n第二行  \n`);
    assert.equal(parsed.type, 'image');
    assert.equal(parsed.filePath, PNG_PATH);
    assert.equal(parsed.text, '看这张图\n第二行');
  });

  it('parses a single-line file message', () => {
    assert.deepEqual(parseMediaMessage(`[MEDIA:file]${PDF_PATH}`), {
      type: 'file',
      filePath: PDF_PATH,
      text: '',
    });
  });

  it('trims spaces around the path and keeps spaces inside it', () => {
    const parsed = parseMediaMessage('[MEDIA:file]  /tmp/a b/c.pdf  ');
    assert.equal(parsed.filePath, '/tmp/a b/c.pdf');
  });

  it('ignores [MEDIA:] that is not at the start of the message', () => {
    assert.equal(parseMediaMessage(`see [MEDIA:image]${PNG_PATH}`), null);
    assert.equal(parseMediaMessage(`/tmp/x.png [MEDIA:image]`), null);
  });

  it('returns null for plain text', () => {
    assert.equal(parseMediaMessage('hello\nworld'), null);
  });

  it('rejects unsupported media types instead of sending text', () => {
    const err = mediaError(() => parseMediaMessage('[MEDIA:card]/tmp/card.json'));
    assert.ok(err instanceof MediaMessageError);
    assert.match(err.message, /\[MEDIA:card\] is not supported/);
    assert.match(err.message, /supported: image, file/);
  });

  it('rejects a media prefix without a path', () => {
    assert.match(mediaError(() => parseMediaMessage('[MEDIA:image]')).message, /missing a file path/);
    assert.match(mediaError(() => parseMediaMessage('[MEDIA:image]\n  caption only')).message, /missing a file path/);
  });
});

// ─── prepareMediaFile ───────────────────────────────────────────

describe('prepareMediaFile', () => {
  it('reads a regular file and derives name/mime/size', () => {
    const file = prepareMediaFile(PNG_PATH, 'image');
    assert.equal(file.name, 'shot.png');
    assert.equal(file.mime, 'image/png');
    assert.equal(file.size, PNG_BYTES.length);
    assert.deepEqual(file.buffer, PNG_BYTES);
  });

  it('rejects relative paths', () => {
    const err = mediaError(() => prepareMediaFile('shot.png', 'image'));
    assert.ok(err instanceof MediaMessageError);
    assert.match(err.message, /needs an absolute file path/);
    assert.match(err.message, /shot\.png/);
  });

  it('rejects missing files', () => {
    const missing = path.join(TMP_DIR, 'nope.png');
    assert.match(mediaError(() => prepareMediaFile(missing, 'image')).message, /file not found/);
  });

  it('rejects directories', () => {
    const err = mediaError(() => prepareMediaFile(TMP_DIR, 'file'));
    assert.ok(err instanceof MediaMessageError);
    assert.match(err.message, /not a regular file/);
  });
});

// ─── mimeForPath ────────────────────────────────────────────────

describe('mimeForPath', () => {
  const cases = {
    'a.png': 'image/png',
    'a.jpg': 'image/jpeg',
    'a.jpeg': 'image/jpeg',
    'a.gif': 'image/gif',
    'a.webp': 'image/webp',
    'a.bmp': 'image/bmp',
    'a.svg': 'image/svg+xml',
    'a.pdf': 'application/pdf',
    'a.txt': 'text/plain',
    'a.md': 'text/markdown',
    'a.csv': 'text/csv',
    'a.json': 'application/json',
    'a.zip': 'application/zip',
    'a.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'a.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'a.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'a.mp3': 'audio/mpeg',
    'a.mp4': 'video/mp4',
    'a.EXE': 'application/octet-stream',
    'noext': 'application/octet-stream',
  };

  for (const [name, expected] of Object.entries(cases)) {
    it(`maps ${name} to ${expected}`, () => {
      assert.equal(mimeForPath(`/tmp/${name}`), expected);
    });
  }
});

// ─── buildMediaParts ────────────────────────────────────────────

describe('buildMediaParts', () => {
  const base = {
    url: 'https://hub.example/api/files/f1',
    name: 'shot.png',
    mime: 'image/png',
    size: 8,
  };

  it('image without caption → image + file', () => {
    assert.deepEqual(buildMediaParts({ ...base, type: 'image', text: '' }), [
      { type: 'image', url: base.url, alt: 'shot.png' },
      { type: 'file', url: base.url, name: 'shot.png', mime_type: 'image/png', size: 8 },
    ]);
  });

  it('image with caption → text + image + file', () => {
    assert.deepEqual(buildMediaParts({ ...base, type: 'image', text: 'caption' }), [
      { type: 'text', content: 'caption' },
      { type: 'image', url: base.url, alt: 'shot.png' },
      { type: 'file', url: base.url, name: 'shot.png', mime_type: 'image/png', size: 8 },
    ]);
  });

  it('file → file part only', () => {
    assert.deepEqual(buildMediaParts({ ...base, type: 'file', text: '' }), [
      { type: 'file', url: base.url, name: 'shot.png', mime_type: 'image/png', size: 8 },
    ]);
  });
});

// ─── uploadMedia + delivery ─────────────────────────────────────

describe('uploadMedia', () => {
  it('uploads the buffer once and builds parts from the record', async () => {
    const client = makeFakeClient();
    const uploaded = await uploadMedia(client, parseMediaMessage(`[MEDIA:image]${PNG_PATH}`));

    assert.equal(client.calls.upload.length, 1);
    assert.equal(client.calls.upload[0].name, 'shot.png');
    assert.equal(client.calls.upload[0].mimeType, 'image/png');
    assert.deepEqual(client.calls.upload[0].buffer, PNG_BYTES);

    assert.equal(uploaded.fileId, 'file-1');
    assert.equal(uploaded.url, 'https://hub.example/api/files/file-1');
    assert.equal(uploaded.size, PNG_BYTES.length);
    assert.deepEqual(uploaded.parts, [
      { type: 'image', url: 'https://hub.example/api/files/file-1', alt: 'shot.png' },
      { type: 'file', url: 'https://hub.example/api/files/file-1', name: 'shot.png', mime_type: 'image/png', size: PNG_BYTES.length },
    ]);
  });

  it('falls back to getFileUrl when the record has no url', async () => {
    const client = makeFakeClient({ rec: { id: 'file-2', name: 'shot.png', mime_type: 'image/png', size: 8, created_at: 0 } });
    const uploaded = await uploadMedia(client, parseMediaMessage(`[MEDIA:image]${PNG_PATH}`));
    assert.equal(uploaded.url, 'https://hub.example/api/files/file-2');
  });

  it('keeps the caption in the parts for a file message', async () => {
    const client = makeFakeClient();
    const uploaded = await uploadMedia(client, parseMediaMessage(`[MEDIA:file]${PDF_PATH}\n\n  报告见附件  `));
    assert.deepEqual(uploaded.parts.map((p) => p.type), ['text', 'file']);
    assert.equal(uploaded.parts[0].content, '报告见附件');
    assert.equal(uploaded.parts[1].mime_type, 'application/pdf');
    assert.equal(uploaded.parts[1].size, 9);
  });
});

describe('deliverMessage', () => {
  it('DM image, no caption → content undefined + parts', async () => {
    const client = makeFakeClient();
    const media = parseMediaMessage(`[MEDIA:image]${PNG_PATH}`);
    const uploaded = await uploadMedia(client, media);

    await deliverMessage(client, { kind: 'dm', to: 'data-bot' }, media.text || undefined, uploaded.parts, null);

    assert.equal(client.calls.send.length, 1);
    assert.equal(client.calls.send[0].to, 'data-bot');
    assert.equal(client.calls.send[0].content, undefined);
    assert.deepEqual(client.calls.send[0].opts, { parts: uploaded.parts });
    assert.equal(client.calls.upload.length, 1);
  });

  it('DM image with caption → caption as content + text part first', async () => {
    const client = makeFakeClient();
    const media = parseMediaMessage(`[MEDIA:image]${PNG_PATH}\n这是说明`);
    const uploaded = await uploadMedia(client, media);

    await deliverMessage(client, { kind: 'dm', to: 'data-bot' }, media.text || undefined, uploaded.parts, null);

    const call = client.calls.send[0];
    assert.equal(call.content, '这是说明');
    assert.deepEqual(call.opts.parts.map((p) => p.type), ['text', 'image', 'file']);
    assert.equal(call.opts.parts[0].content, '这是说明');
  });

  it('DM file → content undefined + single file part', async () => {
    const client = makeFakeClient();
    const media = parseMediaMessage(`[MEDIA:file]${PDF_PATH}`);
    const uploaded = await uploadMedia(client, media);

    await deliverMessage(client, { kind: 'dm', to: 'data-bot' }, media.text || undefined, uploaded.parts, null);

    assert.equal(client.calls.send[0].content, undefined);
    assert.deepEqual(client.calls.send[0].opts.parts.map((p) => p.type), ['file']);
  });

  it('thread + reply_to failure retries without reply_to, keeps parts, uploads once', async () => {
    const client = makeFakeClient({ threadError: Object.assign(new Error('gone'), { status: 400 }) });
    const media = parseMediaMessage(`[MEDIA:image]${PNG_PATH}\n说明`);
    const uploaded = await uploadMedia(client, media);

    const result = await deliverMessage(
      client,
      { kind: 'thread', threadId: 'thread-1' },
      media.text || undefined,
      uploaded.parts,
      'reply-1',
    );

    assert.deepEqual(result, { usedReplyTo: false });
    assert.equal(client.calls.upload.length, 1, 'upload must happen only once');
    assert.equal(client.calls.thread.length, 2);
    assert.deepEqual(client.calls.thread[0], {
      threadId: 'thread-1',
      content: '说明',
      opts: { parts: uploaded.parts, reply_to: 'reply-1' },
    });
    assert.deepEqual(client.calls.thread[1], {
      threadId: 'thread-1',
      content: '说明',
      opts: { parts: uploaded.parts },
    });
    assert.equal(client.calls.send.length, 0);
  });

  it('thread send keeps reply_to when it works', async () => {
    const client = makeFakeClient();
    const media = parseMediaMessage(`[MEDIA:image]${PNG_PATH}`);
    const uploaded = await uploadMedia(client, media);

    const result = await deliverMessage(client, { kind: 'thread', threadId: 't1' }, undefined, uploaded.parts, 'reply-9');

    assert.deepEqual(result, { usedReplyTo: true });
    assert.equal(client.calls.thread.length, 1);
    assert.deepEqual(client.calls.thread[0].opts, { parts: uploaded.parts, reply_to: 'reply-9' });
  });

  it('thread send propagates unrelated errors (no retry)', async () => {
    const client = makeFakeClient({ threadError: Object.assign(new Error('boom'), { status: 500 }) });
    await assert.rejects(
      () => deliverMessage(client, { kind: 'thread', threadId: 't1' }, 'hi', undefined, 'reply-1'),
      /boom/,
    );
    assert.equal(client.calls.thread.length, 1);
  });

  // ─── plain text must stay identical to the pre-media behaviour ───

  it('plain text DM → send(to, message) with undefined opts', async () => {
    const client = makeFakeClient();
    await deliverMessage(client, { kind: 'dm', to: 'bob' }, 'hello\nworld', undefined, null);

    assert.deepEqual(client.calls.send, [
      { to: 'bob', content: 'hello\nworld', opts: undefined },
    ]);
    assert.equal(client.calls.upload.length, 0);
  });

  it('plain text thread with reply_to → opts is exactly { reply_to }', async () => {
    const client = makeFakeClient();
    await deliverMessage(client, { kind: 'thread', threadId: 't1' }, 'hello', undefined, 'r1');

    assert.deepEqual(client.calls.thread, [
      { threadId: 't1', content: 'hello', opts: { reply_to: 'r1' } },
    ]);
  });

  it('plain text thread without reply_to → opts is undefined', async () => {
    const client = makeFakeClient();
    await deliverMessage(client, { kind: 'thread', threadId: 't1' }, 'hello', undefined, null);

    assert.deepEqual(client.calls.thread, [
      { threadId: 't1', content: 'hello', opts: undefined },
    ]);
  });
});

// ─── failures must never touch the client ───────────────────────

describe('invalid media never reaches the client', () => {
  it('relative path throws before any upload/send', () => {
    const client = makeFakeClient();
    const media = parseMediaMessage('[MEDIA:image]shot.png');
    assert.throws(() => prepareMediaFile(media.filePath, media.type), MediaMessageError);
    assert.equal(client.calls.upload.length, 0);
    assert.equal(client.calls.send.length, 0);
    assert.equal(client.calls.thread.length, 0);
  });

  it('missing file throws before any upload/send', async () => {
    const client = makeFakeClient();
    const media = parseMediaMessage(`[MEDIA:image]${path.join(TMP_DIR, 'gone.png')}`);
    await assert.rejects(() => uploadMedia(client, media), /file not found/);
    assert.equal(client.calls.upload.length, 0);
    assert.equal(client.calls.send.length, 0);
  });

  it('card type throws at parse time, before the client exists', () => {
    const client = makeFakeClient();
    assert.throws(() => parseMediaMessage('[MEDIA:card]/tmp/x.json'), MediaMessageError);
    assert.equal(client.calls.upload.length + client.calls.send.length + client.calls.thread.length, 0);
  });
});
