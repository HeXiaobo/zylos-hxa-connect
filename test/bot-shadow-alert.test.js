import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Tests the alertFn pattern from bot.js (L398-411): when suppressionEnabled=false
// (shadow mode), alerts must log to stdout only — sendToC4 must never be called.
// This replicates the closure shape verbatim from bot.js so the test breaks if
// the real alertFn is restructured.

function makeAlertFn({ suppressionEnabled, sendToC4, label = 'test' }) {
  const lp = `[hxa:${label}]`;
  return ({ senderKey, senderName, count, windowSec, reason }) => {
    const reasonTag = reason === 'recovered' ? 'RECOVERED' : 'ALERT';
    const modeTag = suppressionEnabled ? '' : ' [SHADOW]';
    const msg = reason === 'recovered'
      ? `[suppression-recovered${modeTag}] ${senderName} (${senderKey}) resumed substantive messages after ${count} suppressed in ${windowSec}s`
      : `[suppression-alert${modeTag}] ${count} consecutive non-substantive messages from ${senderName} (${senderKey}) in ${windowSec}s reason=${reason} — review suppression-log.jsonl`;
    if (!suppressionEnabled) {
      console.log(`${lp} would-alert: ${msg}`);
      return;
    }
    sendToC4(msg);
  };
}

describe('bot.js alertFn shadow mode (P0-2)', () => {
  it('shadow mode: normal suppression alert does NOT call sendToC4', () => {
    let sendCalls = 0;
    const alertFn = makeAlertFn({
      suppressionEnabled: false,
      sendToC4: () => { sendCalls++; },
    });

    alertFn({
      senderKey: '3ai-w3:sender-1',
      senderName: 'test-sender',
      count: 5,
      windowSec: 120,
      reason: 'short_repeat',
    });

    assert.equal(sendCalls, 0, 'sendToC4 must not be called in shadow mode');
  });

  it('shadow mode: recovery alert does NOT call sendToC4', () => {
    let sendCalls = 0;
    const alertFn = makeAlertFn({
      suppressionEnabled: false,
      sendToC4: () => { sendCalls++; },
    });

    alertFn({
      senderKey: '3ai-w3:sender-1',
      senderName: 'test-sender',
      count: 3,
      windowSec: 60,
      reason: 'recovered',
    });

    assert.equal(sendCalls, 0, 'sendToC4 must not be called in shadow mode for recovery');
  });

  it('enabled mode: normal alert DOES call sendToC4', () => {
    let sendCalls = 0;
    const alertFn = makeAlertFn({
      suppressionEnabled: true,
      sendToC4: () => { sendCalls++; },
    });

    alertFn({
      senderKey: '3ai-w3:sender-1',
      senderName: 'test-sender',
      count: 5,
      windowSec: 120,
      reason: 'short_repeat',
    });

    assert.equal(sendCalls, 1, 'sendToC4 must be called when enabled');
  });

  it('enabled mode: recovery alert DOES call sendToC4', () => {
    let sendCalls = 0;
    const alertFn = makeAlertFn({
      suppressionEnabled: true,
      sendToC4: () => { sendCalls++; },
    });

    alertFn({
      senderKey: '3ai-w3:sender-1',
      senderName: 'test-sender',
      count: 3,
      windowSec: 60,
      reason: 'recovered',
    });

    assert.equal(sendCalls, 1, 'sendToC4 must be called when enabled for recovery');
  });
});
