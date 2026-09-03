import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  effectiveText, isLikelyNonSubstantive, isWhitelistMatch, isPurePunctuation,
  loadWhitelist, resetWhitelist, KNOWN_MSG_FIELDS,
} from '../src/lib/message-classify.js';

let tmpDir;

function writeWhitelist(patterns) {
  const fp = path.join(tmpDir, 'patterns.json');
  fs.writeFileSync(fp, JSON.stringify(patterns));
  return fp;
}

describe('effectiveText', () => {
  it('returns top-level content when no parts', () => {
    assert.equal(effectiveText({ content: 'hello' }), 'hello');
  });

  it('returns empty string for empty message', () => {
    assert.equal(effectiveText({}), '');
  });

  it('concatenates text/markdown/json parts', () => {
    const msg = {
      content: 'top',
      parts: [
        { type: 'text', content: 'part1' },
        { type: 'markdown', content: '**bold**' },
        { type: 'json', content: '{"a":1}' },
      ],
    };
    assert.equal(effectiveText(msg), 'top\npart1\n**bold**\n{"a":1}');
  });

  it('ignores image/file/link part content', () => {
    const msg = {
      content: '',
      parts: [
        { type: 'image', content: 'data:image/png;base64,...' },
        { type: 'file', content: '/path/to/file' },
        { type: 'link', content: 'https://example.com' },
      ],
    };
    assert.equal(effectiveText(msg), '');
  });

  it('ignores parts with non-string content', () => {
    const msg = {
      content: '',
      parts: [{ type: 'text', content: 42 }],
    };
    assert.equal(effectiveText(msg), '');
  });

  it('handles parts-only message (empty top-level content)', () => {
    const msg = {
      content: '',
      parts: [{ type: 'text', content: 'only in parts' }],
    };
    assert.equal(effectiveText(msg), 'only in parts');
  });
});

describe('isPurePunctuation', () => {
  it('matches single CJK period', () => {
    assert.equal(isPurePunctuation('。'), true);
  });

  it('matches mixed punctuation and symbols', () => {
    assert.equal(isPurePunctuation('...!?'), true);
  });

  it('does not match text with punctuation', () => {
    assert.equal(isPurePunctuation('好。'), false);
  });

  it('does not match empty string', () => {
    assert.equal(isPurePunctuation(''), false);
  });

  it('does not match whitespace-only', () => {
    assert.equal(isPurePunctuation('   '), false);
  });

  it('matches punctuation with surrounding whitespace', () => {
    assert.equal(isPurePunctuation('  。  '), true);
  });
});

describe('whitelist', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-test-'));
    resetWhitelist();
  });

  afterEach(() => {
    resetWhitelist();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid whitelist', () => {
    const fp = writeWhitelist(['好。', '收到。']);
    const r = loadWhitelist(fp);
    assert.equal(r.loaded, true);
    assert.equal(r.count, 2);
  });

  it('fail-open on missing file', () => {
    const r = loadWhitelist('/nonexistent/patterns.json');
    assert.equal(r.loaded, false);
    assert.equal(r.reason, 'file_not_found');
  });

  it('empty array clears whitelist', () => {
    const fp1 = writeWhitelist(['hello']);
    loadWhitelist(fp1);
    assert.equal(isWhitelistMatch('hello'), true);
    const fp2 = writeWhitelist([]);
    const r = loadWhitelist(fp2);
    assert.equal(r.loaded, true);
    assert.equal(r.reason, 'cleared');
    assert.equal(r.count, 0);
    assert.equal(isWhitelistMatch('hello'), false);
  });

  it('fail-open on invalid JSON', () => {
    const fp = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(fp, 'not json');
    const r = loadWhitelist(fp);
    assert.equal(r.loaded, false);
  });

  it('preserves whitelist on non-array JSON (invalid_format)', () => {
    const fp1 = writeWhitelist(['hello']);
    loadWhitelist(fp1);
    assert.equal(isWhitelistMatch('hello'), true);
    const fp2 = path.join(tmpDir, 'obj.json');
    fs.writeFileSync(fp2, JSON.stringify({ not: 'array' }));
    const r = loadWhitelist(fp2);
    assert.equal(r.loaded, false);
    assert.equal(r.reason, 'invalid_format');
    assert.equal(r.preserved, true);
    assert.equal(isWhitelistMatch('hello'), true);
  });

  it('matches loaded patterns exactly', () => {
    const fp = writeWhitelist(['好。', '收到。']);
    loadWhitelist(fp);
    assert.equal(isWhitelistMatch('好。'), true);
    assert.equal(isWhitelistMatch('收到。'), true);
    assert.equal(isWhitelistMatch('不好。'), false);
  });

  it('no matches when whitelist not loaded', () => {
    assert.equal(isWhitelistMatch('好。'), false);
  });

  it('preserves good whitelist on failed reload', () => {
    const fp = writeWhitelist(['好。', '收到。']);
    loadWhitelist(fp);
    assert.equal(isWhitelistMatch('好。'), true);
    const r = loadWhitelist('/nonexistent/patterns.json');
    assert.equal(r.loaded, false);
    assert.equal(r.preserved, true);
    assert.equal(isWhitelistMatch('好。'), true);
  });

  it('trims whitespace for matching', () => {
    const fp = writeWhitelist(['好。']);
    loadWhitelist(fp);
    assert.equal(isWhitelistMatch('  好。  '), true);
  });
});

describe('isLikelyNonSubstantive', () => {
  let wlDir;

  beforeEach(() => {
    wlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ns-'));
    const fp = writeWhitelist(['好。', '收到。', '（等 diff）', '（不再回复此线程）']);
    loadWhitelist(fp);
  });

  afterEach(() => {
    resetWhitelist();
    fs.rmSync(wlDir, { recursive: true, force: true });
  });

  function writeWhitelist(patterns) {
    const fp = path.join(wlDir || tmpDir, 'patterns.json');
    fs.writeFileSync(fp, JSON.stringify(patterns));
    return fp;
  }

  it('returns true for whitelisted message', () => {
    const msg = {
      id: 'm1', sender_id: 's1', sender_name: 'veda',
      content: '好。', content_type: 'text', parts: [],
    };
    assert.equal(isLikelyNonSubstantive(msg), true);
  });

  it('returns true for pure punctuation message', () => {
    const msg = {
      id: 'm1', sender_id: 's1',
      content: '。', parts: [],
    };
    assert.equal(isLikelyNonSubstantive(msg), true);
  });

  it('returns false for short non-whitelisted message', () => {
    const msg = {
      id: 'm1', sender_id: 's1',
      content: '明白', parts: [],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for long message even if it starts like whitelist entry', () => {
    const msg = {
      id: 'm1', sender_id: 's1', sender_name: 'veda',
      content: '这是一条比较长的消息内容，已经超过了二十个字符的限制', content_type: 'text', parts: [],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for message with unknown fields (SDK thread shape)', () => {
    const msg = {
      id: 'm1', sender_id: 's1', sender_name: 'veda',
      content: '好。', content_type: 'text', parts: [],
      thread_id: 'thread-123',
      snapshot: { newMessages: [] },
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for message with image part', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '好。',
      parts: [{ type: 'image', url: 'https://example.com/img.png' }],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for message with file part', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '好。',
      parts: [{ type: 'file', name: 'doc.pdf' }],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for message with link part', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '好。',
      parts: [{ type: 'link', url: 'https://example.com' }],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for message with unknown part type', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '好。',
      parts: [{ type: 'audio', content: 'data' }],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for part without type field (fail-open)', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '好。',
      parts: [{ content: 'real payload without type' }],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('rejects null-valued unknown fields (fail-open)', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '好。',
      parts: [], extra_field: null,
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('ignores undefined-valued unknown fields', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '好。',
      parts: [], extra_field: undefined,
    };
    assert.equal(isLikelyNonSubstantive(msg), true);
  });

  it('returns false for non-whitelisted short text', () => {
    const msg = {
      id: 'm1', sender_id: 's1',
      content: '12345678901234567890',
      parts: [],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('returns false for non-whitelisted 21 char text', () => {
    const msg = {
      id: 'm1', sender_id: 's1',
      content: '123456789012345678901',
      parts: [],
    };
    assert.equal(isLikelyNonSubstantive(msg), false);
  });

  it('checks text from parts for whitelist', () => {
    const msg = {
      id: 'm1', sender_id: 's1', content: '',
      parts: [{ type: 'markdown', content: '好。' }],
    };
    assert.equal(isLikelyNonSubstantive(msg), true);
  });

  it('trims whitespace before matching', () => {
    const msg = {
      id: 'm1', sender_id: 's1',
      content: '   好。   ',
      parts: [],
    };
    assert.equal(isLikelyNonSubstantive(msg), true);
  });
});

describe('KNOWN_MSG_FIELDS coverage', () => {
  it('includes all 13 expected fields', () => {
    const expected = [
      'id', 'channel_id', 'sender_id', 'sender_name', 'content', 'content_type',
      'parts', 'metadata', 'created_at', 'reply_to_message', 'mention_all',
      'thread_id', 'org_id',
    ];
    for (const f of expected) {
      assert.ok(KNOWN_MSG_FIELDS.has(f), `missing field: ${f}`);
    }
    assert.equal(KNOWN_MSG_FIELDS.size, 13);
  });
});
