import fs from 'fs';

const KNOWN_PART_TYPES = new Set(['text', 'markdown', 'image', 'file', 'link', 'json']);
const KNOWN_MSG_FIELDS = new Set([
  'id', 'channel_id', 'sender_id', 'sender_name', 'content', 'content_type',
  'parts', 'metadata', 'created_at', 'reply_to_message', 'mention_all',
  'thread_id', 'org_id',
]);

const PURE_PUNCTUATION_RE = /^[\p{P}\p{S}\s]+$/u;

let _whitelist = null;

export function effectiveText(message) {
  let text = message.content || '';
  if (message.parts) {
    for (const p of message.parts) {
      if (typeof p.content === 'string' && (p.type === 'text' || p.type === 'markdown' || p.type === 'json' || !p.type)) {
        if (text && p.content) text += '\n';
        text += p.content;
      }
    }
  }
  return text;
}

export function loadWhitelist(filePath) {
  let newWhitelist;
  try {
    if (!fs.existsSync(filePath)) {
      process.stderr.write(`[message-classify] WARN whitelist not found: ${filePath} — whitelist matching disabled (fail-open)\n`);
      return { loaded: false, reason: 'file_not_found', count: 0, preserved: _whitelist !== null };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) {
      process.stderr.write(`[message-classify] WARN whitelist invalid (not an array): ${filePath} — preserving previous whitelist (fail-open)\n`);
      return { loaded: false, reason: 'invalid_format', count: 0, preserved: _whitelist !== null };
    }
    if (entries.length === 0) {
      newWhitelist = null; // empty array = disable matching; does NOT preserve previous whitelist
    } else {
      newWhitelist = new Set(entries.map(e => String(e).trim()));
    }
  } catch (err) {
    process.stderr.write(`[message-classify] WARN whitelist load failed: ${err.message} — preserving previous whitelist (fail-open)\n`);
    return { loaded: false, reason: err.message, count: 0, preserved: _whitelist !== null };
  }
  _whitelist = newWhitelist;
  if (newWhitelist === null) {
    process.stderr.write(`[message-classify] whitelist cleared (empty array): ${filePath}\n`);
    return { loaded: true, reason: 'cleared', count: 0 };
  }
  return { loaded: true, count: _whitelist.size };
}

export function isWhitelistMatch(text) {
  if (!_whitelist) return false;
  return _whitelist.has(text.trim());
}

export function isPurePunctuation(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return PURE_PUNCTUATION_RE.test(trimmed);
}

export function isLikelyNonSubstantive(message) {
  for (const key of Object.keys(message)) {
    if (!KNOWN_MSG_FIELDS.has(key) && message[key] !== undefined) return false;
  }
  if (message.parts?.some(p => ['image', 'file', 'link'].includes(p.type))) return false;
  if (message.parts?.some(p => !KNOWN_PART_TYPES.has(p.type))) return false;
  const text = effectiveText(message).trim();
  if (!text) return true;
  return isWhitelistMatch(text) || isPurePunctuation(text);
}

export function resetWhitelist() {
  _whitelist = null;
}

export { KNOWN_PART_TYPES, KNOWN_MSG_FIELDS, PURE_PUNCTUATION_RE };
