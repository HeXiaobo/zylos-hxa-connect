import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SuppressionTracker } from '../src/lib/suppression-tracker.js';

let tmpDir;
let logPath;

function makeTracker(opts = {}) {
  return new SuppressionTracker({
    logPath,
    alertThreshold: opts.alertThreshold ?? 5,
    suppressAfter: opts.suppressAfter ?? 1,
    windowMs: opts.windowMs ?? 3_600_000,
    repeatWindowMs: opts.repeatWindowMs ?? 1_800_000,
    alertCooldownMs: opts.alertCooldownMs ?? 1_800_000,
    maxRepeatLength: opts.maxRepeatLength ?? 50,
    alertFn: opts.alertFn ?? null,
  });
}

function msg(id, content, overrides = {}) {
  return {
    messageId: id,
    senderId: overrides.senderId ?? 'sender-1',
    senderName: overrides.senderName ?? 'veda',
    orgLabel: overrides.orgLabel ?? '3ai-w3',
    content,
    context: overrides.context ?? 'dm',
    nonSubstantive: overrides.nonSubstantive ?? false,
  };
}

describe('SuppressionTracker', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-test-'));
    logPath = path.join(tmpDir, 'suppression-log.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('whitelist/punctuation path (nonSubstantive=true)', () => {
    it('suppresses 2nd consecutive non-substantive message', () => {
      const tracker = makeTracker();
      const r1 = tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      assert.equal(r1.suppress, false, 'first passes');
      const r2 = tracker.evaluate(msg('m2', '（等 diff）', { nonSubstantive: true }));
      assert.equal(r2.suppress, true, 'second suppressed');
      assert.equal(r2.consecutiveCount, 2);
      assert.equal(r2.reason, 'whitelist_or_punctuation');
    });

    it('resets on substantive message (nonSubstantive=false, different content)', () => {
      const tracker = makeTracker();
      tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      tracker.evaluate(msg('m2', '（等 diff）', { nonSubstantive: true }));
      tracker.evaluate(msg('m3', '这是一条实质性消息，内容足够长', { nonSubstantive: false }));
      const r = tracker.evaluate(msg('m4', '收到。', { nonSubstantive: true }));
      assert.equal(r.suppress, false, 'counter should have reset');
      assert.equal(r.consecutiveCount, 1);
    });
  });

  describe('repetition detection (nonSubstantive=false but byte-identical)', () => {
    it('suppresses 2nd consecutive identical short message', () => {
      const tracker = makeTracker();
      const r1 = tracker.evaluate(msg('m1', '明白'));
      assert.equal(r1.suppress, false, 'first passes');
      const r2 = tracker.evaluate(msg('m2', '明白'));
      assert.equal(r2.suppress, true, 'second identical suppressed');
      assert.equal(r2.reason, 'short_repeat');
    });

    it('does not suppress different short messages', () => {
      const tracker = makeTracker();
      const r1 = tracker.evaluate(msg('m1', '明白'));
      assert.equal(r1.suppress, false);
      const r2 = tracker.evaluate(msg('m2', '了解'));
      assert.equal(r2.suppress, false, 'different content should pass');
    });

    it('does not suppress long identical messages', () => {
      const tracker = makeTracker({ maxRepeatLength: 10 });
      const long = '这条消息超过了最大重复长度限制';
      const r1 = tracker.evaluate(msg('m1', long));
      assert.equal(r1.suppress, false);
      const r2 = tracker.evaluate(msg('m2', long));
      assert.equal(r2.suppress, false, 'long repeat should not suppress');
    });

    it('suppresses 3rd+ identical messages', () => {
      const tracker = makeTracker();
      tracker.evaluate(msg('m1', '等你'));
      tracker.evaluate(msg('m2', '等你'));
      const r3 = tracker.evaluate(msg('m3', '等你'));
      assert.equal(r3.suppress, true);
      assert.equal(r3.consecutiveCount, 2);
    });

    it('resets when different message arrives', () => {
      const tracker = makeTracker();
      tracker.evaluate(msg('m1', '明白'));
      tracker.evaluate(msg('m2', '明白'));
      tracker.evaluate(msg('m3', '一条完全不同的长消息内容'));
      const r = tracker.evaluate(msg('m4', '明白'));
      assert.equal(r.suppress, false, 'counter should reset after different message');
    });
  });

  describe('real-sample regression (Veda 46-message sample)', () => {
    const SHOULD_SUPPRESS = [
      { content: '（不再回复此线程）', count: 7 },
      { content: '好，理解一致。等你的范围。', count: 1 },
      { content: '好。', count: 1 },
      { content: '等你的 diff。', count: 1 },
      { content: '（等 diff，无需再回执）', count: 1 },
      { content: '（等 diff）', count: 8 },
    ];

    const SHOULD_NOT_SUPPRESS_LENGTHS = [
      83, 103, 120, 136, 225, 278, 295, 299, 329, 332,
      349, 353, 355, 420, 433, 533, 596, 633, 675, 713,
      722, 763, 787, 835,
    ];

    it('replays 19-message suppression burst: whitelist + repetition combined', () => {
      const tracker = makeTracker();
      const allShort = [];
      for (const { content, count } of SHOULD_SUPPRESS) {
        for (let i = 0; i < count; i++) allShort.push(content);
      }
      assert.equal(allShort.length, 19);

      let passed = 0;
      let suppressed = 0;
      let id = 0;
      for (const content of allShort) {
        const r = tracker.evaluate(msg(`m${++id}`, content, { nonSubstantive: true }));
        if (r.suppress) suppressed++;
        else passed++;
      }
      assert.equal(passed, 1, 'exactly 1 passes (the first)');
      assert.equal(suppressed, 18, '18 suppressed');
    });

    it('interleaved: substantive resets, next non-substantive passes', () => {
      const tracker = makeTracker();
      let id = 0;
      const r1 = tracker.evaluate(msg(`m${++id}`, '好。', { nonSubstantive: true }));
      assert.equal(r1.suppress, false);

      const r2 = tracker.evaluate(msg(`m${++id}`, '等你的 diff。', { nonSubstantive: true }));
      assert.equal(r2.suppress, true);

      tracker.evaluate(msg(`m${++id}`, '一条实质性长消息内容来重置计数器', { nonSubstantive: false }));

      const r3 = tracker.evaluate(msg(`m${++id}`, '（等 diff）', { nonSubstantive: true }));
      assert.equal(r3.suppress, false, 'counter reset');

      const r4 = tracker.evaluate(msg(`m${++id}`, '好。', { nonSubstantive: true }));
      assert.equal(r4.suppress, true);
    });
  });

  describe('repetition regression (Veda-requested test groups)', () => {
    it('group 2: same content sent N times — 2nd+ suppressed', () => {
      const tracker = makeTracker();
      let id = 0;
      const results = [];
      for (let i = 0; i < 8; i++) {
        results.push(tracker.evaluate(msg(`m${++id}`, '好的。')));
      }
      assert.equal(results[0].suppress, false, 'first passes');
      for (let i = 1; i < 8; i++) {
        assert.equal(results[i].suppress, true, `msg ${i + 1} should be suppressed (repetition)`);
        assert.equal(results[i].reason, 'short_repeat');
      }
    });

    it('group 3: N different short messages — all pass', () => {
      const tracker = makeTracker();
      const phrases = ['好的', '明白', '了解', '收到', '没问题', '可以', '知道了', '行'];
      let id = 0;
      for (const phrase of phrases) {
        const r = tracker.evaluate(msg(`m${++id}`, phrase));
        assert.equal(r.suppress, false, `"${phrase}" should pass (all different)`);
      }
    });
  });

  describe('Veda requirement #4: cross-sender and A/B alternation', () => {
    it('same content, different senders — first from each passes (buckets independent)', () => {
      const tracker = makeTracker();
      const senders = ['sender-a', 'sender-b', 'sender-c'];
      let id = 0;
      for (const senderId of senders) {
        const r = tracker.evaluate(msg(`m${++id}`, '好的。', { senderId, senderName: senderId }));
        assert.equal(r.suppress, false, `first msg from ${senderId} should pass`);
      }
    });

    it('same content, same sender repeated across interleaved senders — per-sender repeat fires', () => {
      const tracker = makeTracker();
      let id = 0;
      const r1 = tracker.evaluate(msg(`m${++id}`, '好的。', { senderId: 'sender-a', senderName: 'a' }));
      assert.equal(r1.suppress, false, 'sender-a first passes');
      tracker.evaluate(msg(`m${++id}`, '好的。', { senderId: 'sender-b', senderName: 'b' }));
      const r3 = tracker.evaluate(msg(`m${++id}`, '好的。', { senderId: 'sender-a', senderName: 'a' }));
      assert.equal(r3.suppress, true, 'sender-a 2nd identical suppressed (per-sender consecutive)');
      assert.equal(r3.reason, 'short_repeat');
    });

    it('same sender, A/B/A/B alternating — all pass (consecutive means same content)', () => {
      const tracker = makeTracker();
      let id = 0;
      const contents = ['好的', '明白'];
      for (let i = 0; i < 8; i++) {
        const content = contents[i % 2];
        const r = tracker.evaluate(msg(`m${++id}`, content));
        assert.equal(r.suppress, false, `msg ${i + 1} "${content}" should pass (alternating breaks repetition)`);
      }
    });
  });

  describe('cross-org alternation', () => {
    it('same sender on two orgs has independent counters — 2 pass, 17 suppressed', () => {
      const tracker = makeTracker();
      const orgs = ['3ai-w3', '3ai'];
      let id = 0;
      let passed = 0;
      let suppressed = 0;
      for (let i = 0; i < 19; i++) {
        const orgLabel = orgs[i % 2];
        const r = tracker.evaluate(msg(`m${++id}`, '（等 diff）', { orgLabel, nonSubstantive: true }));
        if (r.suppress) suppressed++;
        else passed++;
      }
      assert.equal(passed, 2, '1 pass per org = 2 total');
      assert.equal(suppressed, 17);
    });
  });

  describe('alert threshold', () => {
    it('fires alert at threshold and respects 30-min cooldown', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertThreshold: 3,
        alertFn: (info) => alerts.push(info),
      });
      for (let i = 1; i <= 5; i++) {
        tracker.evaluate(msg(`m${i}`, '好', { nonSubstantive: true }));
      }
      assert.equal(alerts.length, 1, 'alert fires once at threshold');
      assert.equal(alerts[0].count, 3);
    });
  });

  describe('recovery alert', () => {
    it('fires recovery alert when substantive message arrives after suppression', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertFn: (info) => alerts.push(info),
      });
      tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      tracker.evaluate(msg('m2', '（等 diff）', { nonSubstantive: true }));
      tracker.evaluate(msg('m3', '一条实质性长消息', { nonSubstantive: false }));
      const recoveryAlerts = alerts.filter(a => a.reason === 'recovered');
      assert.equal(recoveryAlerts.length, 1);
      assert.equal(recoveryAlerts[0].count, 1, 'reports actual suppressed count, not seen count');
    });

    it('fires recovery after exactly 1 suppression via short_repeat (defect-1 boundary)', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertFn: (info) => alerts.push(info),
      });
      tracker.evaluate(msg('m1', 'X'));
      const r2 = tracker.evaluate(msg('m2', 'X'));
      assert.equal(r2.suppress, true, 'second identical suppressed');
      tracker.evaluate(msg('m3', 'Y'));
      const recoveryAlerts = alerts.filter(a => a.reason === 'recovered');
      assert.equal(recoveryAlerts.length, 1, 'recovery fires even with count=1');
      assert.equal(recoveryAlerts[0].count, 1, 'exactly 1 was suppressed');
    });

    it('whitelist path: recovery count = actual suppressed, not seen (defect-2 boundary)', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertFn: (info) => alerts.push(info),
      });
      tracker.evaluate(msg('m1', 'a', { nonSubstantive: true }));
      tracker.evaluate(msg('m2', 'b', { nonSubstantive: true }));
      tracker.evaluate(msg('m3', 'c', { nonSubstantive: true }));
      tracker.evaluate(msg('m4', 'substantive long message here', { nonSubstantive: false }));
      const recoveryAlerts = alerts.filter(a => a.reason === 'recovered');
      assert.equal(recoveryAlerts.length, 1);
      assert.equal(recoveryAlerts[0].count, 2, 'reports 2 suppressed (not 3 seen)');
    });

    it('no recovery alert when no messages were suppressed', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertFn: (info) => alerts.push(info),
      });
      tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      tracker.evaluate(msg('m2', '一条实质性长消息', { nonSubstantive: false }));
      const recoveryAlerts = alerts.filter(a => a.reason === 'recovered');
      assert.equal(recoveryAlerts.length, 0, 'no suppression occurred, no recovery');
    });
  });

  describe('window expiry', () => {
    it('resets counter when gap exceeds window', () => {
      const tracker = makeTracker({ windowMs: 100 });
      tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      return new Promise(resolve => setTimeout(resolve, 150)).then(() => {
        const r = tracker.evaluate(msg('m2', '好。', { nonSubstantive: true }));
        assert.equal(r.suppress, false, 'counter resets after window expires');
        assert.equal(r.consecutiveCount, 1);
      });
    });

    it('does not fire recovery alert on window expiry', () => {
      const alerts = [];
      const tracker = makeTracker({
        windowMs: 100,
        alertFn: (info) => alerts.push(info),
      });
      tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      tracker.evaluate(msg('m2', '（等 diff）', { nonSubstantive: true }));
      return new Promise(resolve => setTimeout(resolve, 150)).then(() => {
        tracker.evaluate(msg('m3', '一条实质性长消息', { nonSubstantive: false }));
        const recoveryAlerts = alerts.filter(a => a.reason === 'recovered');
        assert.equal(recoveryAlerts.length, 0, 'window expired silently — no recovery alert');
      });
    });
  });

  describe('persistSuppressed marker', () => {
    it('writes unknown marker when reason is missing', () => {
      const tracker = makeTracker();
      const message = { id: 'm1', content: '好', sender_id: 's1' };
      tracker.persistSuppressed(message, { context: 'dm', orgLabel: '3ai-w3', source: 'poll' });
      const suppressedPath = path.join(tmpDir, 'suppressed-messages.jsonl');
      const lines = fs.readFileSync(suppressedPath, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.marker, 'unknown');
      assert.deepEqual(entry.message, message);
    });

    it('passes through reason when provided', () => {
      const tracker = makeTracker();
      const message = { id: 'm2', content: '好。', sender_id: 's1' };
      tracker.persistSuppressed(message, { context: 'dm', orgLabel: '3ai-w3', source: 'poll', reason: 'whitelist_or_punctuation' });
      const suppressedPath = path.join(tmpDir, 'suppressed-messages.jsonl');
      const lines = fs.readFileSync(suppressedPath, 'utf-8').trim().split('\n');
      const entry = JSON.parse(lines[lines.length - 1]);
      assert.equal(entry.marker, 'whitelist_or_punctuation');
    });
  });

  describe('thread context', () => {
    it('thread and DM from same sender share counter', () => {
      const tracker = makeTracker();
      const r1 = tracker.evaluate(msg('m1', '好。', { context: 'dm', nonSubstantive: true }));
      assert.equal(r1.suppress, false);
      const r2 = tracker.evaluate(msg('m2', '好。', { context: 'thread:t1', nonSubstantive: true }));
      assert.equal(r2.suppress, true, 'same sender, different context, still suppressed');
    });
  });

  describe('tracker contract (evaluate/persist decoupling)', () => {
    it('evaluate returns suppress=true without auto-calling persistSuppressed', () => {
      const tracker = makeTracker();
      tracker.evaluate(msg('m1', '好', { nonSubstantive: true }));
      const r = tracker.evaluate(msg('m2', '好。', { nonSubstantive: true }));
      assert.equal(r.suppress, true);
      const suppressedPath = path.join(tmpDir, 'suppressed-messages.jsonl');
      assert.equal(fs.existsSync(suppressedPath), false, 'persistSuppressed not called by evaluate');
    });

    it('alertFn fires at threshold', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertThreshold: 3,
        alertFn: (info) => alerts.push(info),
      });
      for (let i = 1; i <= 3; i++) {
        tracker.evaluate(msg(`m${i}`, '好', { nonSubstantive: true }));
      }
      assert.equal(alerts.length, 1, 'alertFn called at threshold');
      assert.equal(alerts[0].count, 3);
      assert.ok(alerts[0].reason);
    });

    it('alertFn receives recovery reason when substantive arrives', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertFn: (info) => alerts.push(info),
      });
      tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      tracker.evaluate(msg('m2', '（等 diff）', { nonSubstantive: true }));
      tracker.evaluate(msg('m3', '实质性消息', { nonSubstantive: false }));
      const recovery = alerts.filter(a => a.reason === 'recovered');
      assert.equal(recovery.length, 1);
      assert.equal(recovery[0].senderName, 'veda');
    });
    // Shadow gate (if !suppressionEnabled return) tested end-to-end in bot-shadow-alert.test.js
  });

  describe('combined: repetition + whitelist', () => {
    it('whitelist catches non-repeating patterns, repetition catches repeating unknowns', () => {
      const tracker = makeTracker();
      let id = 0;

      const r1 = tracker.evaluate(msg(`m${++id}`, '好。', { nonSubstantive: true }));
      assert.equal(r1.suppress, false, 'first whitelisted passes');

      const r2 = tracker.evaluate(msg(`m${++id}`, '（等 diff）', { nonSubstantive: true }));
      assert.equal(r2.suppress, true, '2nd whitelisted message suppressed');

      // Substantive message resets counter
      tracker.evaluate(msg(`m${++id}`, '这是一条实质性消息需要处理', { nonSubstantive: false }));

      // Non-whitelisted different short message — passes (not whitelisted, not repeated)
      const r4 = tracker.evaluate(msg(`m${++id}`, '明白'));
      assert.equal(r4.suppress, false, 'non-whitelisted different message passes');

      // Repetition: same non-whitelisted content → suppressed
      const r5 = tracker.evaluate(msg(`m${++id}`, '明白'));
      assert.equal(r5.suppress, true, 'identical repeat suppressed');
      assert.equal(r5.reason, 'short_repeat');

      const r6 = tracker.evaluate(msg(`m${++id}`, '明白'));
      assert.equal(r6.suppress, true, '3rd identical still suppressed');

      // Different content breaks the repetition
      const r7 = tracker.evaluate(msg(`m${++id}`, '等你的 v9'));
      assert.equal(r7.suppress, false, 'different content after repeat passes');
    });
  });

  describe('empty-content guard (GAP-2: empty effectiveText must not trigger short_repeat)', () => {
    it('two consecutive empty-content messages are not treated as short_repeat', () => {
      const tracker = makeTracker();
      const r1 = tracker.evaluate(msg('m1', ''));
      assert.equal(r1.suppress, false, 'first empty-content message passes');
      assert.equal(r1.reason, null);

      const r2 = tracker.evaluate(msg('m2', ''));
      assert.equal(r2.suppress, false, 'second empty-content message also passes — empty strings are not repeatable content');
      assert.equal(r2.reason, null);
    });

    it('empty-content messages do not accumulate into suppression even after many sends', () => {
      const tracker = makeTracker({ suppressAfter: 1 });
      for (let i = 1; i <= 5; i++) {
        const r = tracker.evaluate(msg(`m${i}`, ''));
        assert.equal(r.suppress, false, `empty-content message #${i} must not be suppressed`);
      }
    });

    it('whitespace-only messages are treated as empty (trimmed to empty string)', () => {
      const tracker = makeTracker();
      const r1 = tracker.evaluate(msg('m1', '   '));
      assert.equal(r1.suppress, false);
      const r2 = tracker.evaluate(msg('m2', '\t\n'));
      assert.equal(r2.suppress, false, 'whitespace-only message not treated as repeat of prior whitespace');
    });
  });

  describe('GAP-3: empty event must not trigger false recovered alert', () => {
    it('empty content after suppression streak does not fire recovered (when correctly classified)', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertThreshold: 3,
        suppressAfter: 1,
        alertFn: (info) => alerts.push(info),
      });
      for (let i = 1; i <= 4; i++) {
        tracker.evaluate(msg(`m${i}`, '收到', { nonSubstantive: true }));
      }
      assert.ok(alerts.some(a => a.reason !== 'recovered'), 'should have triggered alert');
      const prevAlertCount = alerts.length;
      tracker.evaluate(msg('m-empty', '', { nonSubstantive: true }));
      const newAlerts = alerts.slice(prevAlertCount);
      const recoveryAlerts = newAlerts.filter(a => a.reason === 'recovered');
      assert.equal(recoveryAlerts.length, 0, 'empty content must NOT trigger recovered alert');
    });

    it('real substantive message after suppression DOES fire recovered', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertThreshold: 3,
        suppressAfter: 1,
        alertFn: (info) => alerts.push(info),
      });
      for (let i = 1; i <= 4; i++) {
        tracker.evaluate(msg(`m${i}`, '收到', { nonSubstantive: true }));
      }
      tracker.evaluate(msg('m-real', '这是一条有实质内容的消息', { nonSubstantive: false }));
      assert.ok(alerts.some(a => a.reason === 'recovered'), 'real content should trigger recovered');
    });
  });

  describe('GAP-3 early return: empty content produces zero alerts (Veda scenario)', () => {
    it('4 empty events + 1 real message → zero alerts fired', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertThreshold: 3,
        suppressAfter: 1,
        alertFn: (info) => alerts.push(info),
      });
      for (let i = 1; i <= 4; i++) {
        const r = tracker.evaluate(msg(`e${i}`, ''));
        assert.equal(r.suppress, false, `empty event #${i} not suppressed`);
        assert.equal(r.consecutiveCount, 0, `empty event #${i} does not increment counter`);
      }
      const r = tracker.evaluate(msg('m-real', '这是一条真正的消息'));
      assert.equal(r.suppress, false, 'first real message passes');
      assert.equal(alerts.length, 0, 'zero alerts — no whitelist_or_punctuation, no recovered');
    });

    it('empty content between two non-substantive streaks does not reset counter', () => {
      const tracker = makeTracker({ suppressAfter: 1 });
      tracker.evaluate(msg('m1', '好', { nonSubstantive: true }));
      tracker.evaluate(msg('m-empty', ''));
      const r = tracker.evaluate(msg('m2', '嗯', { nonSubstantive: true }));
      assert.equal(r.suppress, true, 'streak continues past empty content');
      assert.equal(r.consecutiveCount, 2, 'counter unaffected by empty interjection');
    });

    it('no alert has windowSec=0 (false alert fingerprint)', () => {
      const alerts = [];
      const tracker = makeTracker({
        alertThreshold: 2,
        suppressAfter: 0,
        alertFn: (info) => alerts.push(info),
      });
      for (let i = 0; i < 10; i++) {
        tracker.evaluate(msg(`m${i}`, '', { nonSubstantive: i % 2 === 0 }));
      }
      tracker.evaluate(msg('m-real', '真消息'));
      const zeroWindowAlerts = alerts.filter(a => a.windowSec === 0);
      assert.equal(zeroWindowAlerts.length, 0, 'window=0s is a false alert fingerprint — must never fire');
    });
  });

  describe('repeatWindowMs (v9: freshness window for repeat detection)', () => {
    it('does not treat as repeat when gap exceeds repeatWindowMs', () => {
      const tracker = makeTracker({ repeatWindowMs: 100, windowMs: 3_600_000 });
      tracker.evaluate(msg('m1', '好的'));
      return new Promise(resolve => setTimeout(resolve, 150)).then(() => {
        const r = tracker.evaluate(msg('m2', '好的'));
        assert.equal(r.suppress, false, 'same content after repeatWindow expiry is not a repeat');
        assert.equal(r.reason, null, 'classified as substantive');
      });
    });

    it('treats as repeat within repeatWindowMs', () => {
      const tracker = makeTracker({ repeatWindowMs: 5_000, windowMs: 3_600_000 });
      tracker.evaluate(msg('m1', '好的'));
      const r = tracker.evaluate(msg('m2', '好的'));
      assert.equal(r.suppress, true, 'same content within repeatWindow is repeat');
      assert.equal(r.reason, 'short_repeat');
    });

    it('whitelist path still works after repeatWindow expires (within windowMs)', () => {
      const tracker = makeTracker({ repeatWindowMs: 100, windowMs: 3_600_000 });
      tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      return new Promise(resolve => setTimeout(resolve, 150)).then(() => {
        const r = tracker.evaluate(msg('m2', '好。', { nonSubstantive: true }));
        assert.equal(r.suppress, true, 'whitelist path still counts even after repeat freshness expires');
        assert.equal(r.reason, 'whitelist_or_punctuation');
      });
    });
  });

  describe('config validation (v9: fail-open with warning)', () => {
    it('falls back to default on invalid maxRepeatLength', () => {
      const tracker = makeTracker({ maxRepeatLength: -1 });
      tracker.evaluate(msg('m1', '好的'));
      const r = tracker.evaluate(msg('m2', '好的'));
      assert.equal(r.suppress, true, 'repeat detection works with fallback default');
    });

    it('falls back to default on NaN windowMs', () => {
      const tracker = makeTracker({ windowMs: NaN });
      const r1 = tracker.evaluate(msg('m1', '好。', { nonSubstantive: true }));
      assert.equal(r1.suppress, false, 'tracker functions with fallback');
      const r2 = tracker.evaluate(msg('m2', '好。', { nonSubstantive: true }));
      assert.equal(r2.suppress, true, 'suppression works normally');
    });

    it('falls back to default on zero repeatWindowMs', () => {
      const tracker = makeTracker({ repeatWindowMs: 0 });
      tracker.evaluate(msg('m1', '好的'));
      const r = tracker.evaluate(msg('m2', '好的'));
      assert.equal(r.suppress, true, 'repeat works with fallback (default 30min > 0ms gap)');
    });
  });

  describe('stale counter sweep (v9: periodic cleanup)', () => {
    it('does not crash after many evaluations', () => {
      const tracker = makeTracker({ windowMs: 50 });
      for (let i = 0; i < 150; i++) {
        tracker.evaluate(msg(`m${i}`, `content-${i}`, { senderId: `sender-${i % 10}` }));
      }
    });
  });
});
