import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
