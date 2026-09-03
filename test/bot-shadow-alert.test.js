import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SuppressionTracker } from '../src/lib/suppression-tracker.js';

// WARNING: this closure is a replica of bot.js L398-411, NOT imported.
// If bot.js alertFn changes, update here. The real gate is in bot.js;
// this test verifies the pattern shape, not the actual runtime closure.
//
// After shadow-mode decision (Mylos, session 174): shadow alerts DO send
// to C4 with [SHADOW] prefix. The early return was removed in bot.js.

function makeAlertFn(suppressionEnabled, sent) {
  return ({ senderKey, senderName, count, windowSec, reason }) => {
    const modeTag = suppressionEnabled ? '' : ' [SHADOW]';
    const msg = reason === 'recovered'
      ? `[suppression-recovered${modeTag}] ${senderName} (${senderKey}) resumed after ${count} in ${windowSec}s`
      : `[suppression-alert${modeTag}] ${count} consecutive from ${senderName} (${senderKey}) reason=${reason}`;
    if (!suppressionEnabled) {
      // shadow mode: still send (with [SHADOW] tag), no early return
    }
    sent.push(msg);
  };
}

function drive(suppressionEnabled) {
  const sent = [];
  const t = new SuppressionTracker({
    logPath: './tmp/shadow-test-' + Date.now() + '.jsonl',
    alertThreshold: 3,
    suppressAfter: 1,
    alertFn: makeAlertFn(suppressionEnabled, sent),
  });
  const ev = (c, ns) => t.evaluate({
    messageId: 'm' + Math.random(),
    senderId: 's1',
    senderName: 'peer',
    orgLabel: 'o',
    content: c,
    nonSubstantive: ns,
  });
  for (let i = 0; i < 4; i++) ev('收到', true);
  ev('一条真正的实质消息', false);
  return sent;
}

const ALERTFN_SHA = '7d09eae502e22afe75e1ec04a4c49700b7cb427d2487e2d58f3a9ca543652227';

function findAlertFnRange(src) {
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+alertFn:\s*\(/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  const baseIndent = lines[start].match(/^(\s*)/)[1].length;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth <= 0) return [start + 1, i + 1]; // 1-indexed inclusive
  }
  return null;
}

function extractNormalized(src) {
  const range = findAlertFnRange(src);
  if (!range) return null;
  const lines = src.split('\n').slice(range[0] - 1, range[1]);
  const normalized = lines.join('\n').replace(/\s+/g, ' ').replace(/ +/g, ' ') + '\n';
  return { range, normalized };
}

describe('alertFn drift detection (bot.js ↔ test replica)', () => {
  it('bot.js alertFn closure matches known hash — update replica if this fails', () => {
    const src = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf-8');
    const result = extractNormalized(src);
    assert.ok(result, 'could not locate alertFn closure in bot.js — signature pattern not found');
    const sha = createHash('sha256').update(result.normalized).digest('hex');
    assert.equal(sha, ALERTFN_SHA,
      `bot.js alertFn (L${result.range[0]}-${result.range[1]}) changed — ` +
      'this test replica is now stale. Read the new bot.js closure, update ' +
      'makeAlertFn() above and ALERTFN_SHA, then re-run.');
  });

  it('two-half control: mutating the closure changes the hash (positive)', () => {
    const src = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf-8');
    const original = extractNormalized(src);
    assert.ok(original, 'precondition: closure found');
    const mutated = original.normalized.replace('suppression-alert', 'suppression-TAMPERED');
    const sha = createHash('sha256').update(mutated).digest('hex');
    assert.notEqual(sha, ALERTFN_SHA, 'mutated closure must produce a different hash');
  });

  it('two-half control: inserting a blank line above the closure keeps the hash (negative)', () => {
    const src = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf-8');
    const original = extractNormalized(src);
    assert.ok(original, 'precondition: closure found in original');
    const lines = src.split('\n');
    lines.splice(original.range[0] - 2, 0, '');
    const shifted = lines.join('\n');
    const result = extractNormalized(shifted);
    assert.ok(result, 'closure must still be found after blank-line insertion');
    const sha = createHash('sha256').update(result.normalized).digest('hex');
    assert.equal(sha, ALERTFN_SHA, 'blank line above closure must not change the hash');
  });
});

describe('shadow gate (alertFn in bot.js, integrated pipeline)', () => {
  it('positive control: live mode sends alert + recovery without [SHADOW] tag', () => {
    const sent = drive(true);
    assert.equal(sent.length, 2, 'live mode must produce exactly 2 sends (alert + recovery)');
    assert.ok(sent.some(m => m.includes('suppression-alert') && !m.includes('[SHADOW]')), 'threshold alert missing or has wrong tag');
    assert.ok(sent.some(m => m.includes('suppression-recovered') && !m.includes('[SHADOW]')), 'recovery alert missing or has wrong tag');
  });

  it('shadow mode: sends alert + recovery WITH [SHADOW] tag (not suppressed)', () => {
    const sent = drive(false);
    assert.equal(sent.length, 2, 'shadow mode must also produce 2 sends (visible in C4 with [SHADOW])');
    assert.ok(sent.some(m => m.includes('[SHADOW]') && m.includes('suppression-alert')), 'shadow alert must carry [SHADOW] tag');
    assert.ok(sent.some(m => m.includes('[SHADOW]') && m.includes('suppression-recovered')), 'shadow recovery must carry [SHADOW] tag');
  });

  it('shadow mode messages are distinguishable from live mode messages', () => {
    const live = drive(true);
    const shadow = drive(false);
    for (const msg of shadow) {
      assert.ok(msg.includes('[SHADOW]'), `shadow message must include [SHADOW]: ${msg}`);
    }
    for (const msg of live) {
      assert.ok(!msg.includes('[SHADOW]'), `live message must not include [SHADOW]: ${msg}`);
    }
  });
});
