/**
 * Round-3 review: the six extra assertions from the reviewer's probes.
 *
 * Source of truth (do not weaken these assertions):
 *   ~/work/mylos-1112pm/w-n/probe-r2-tied-ids.mjs
 *   ~/work/mylos-1112pm/w-n/probe-r2-inflight.mjs
 *   ~/work/mylos-1112pm/w-n/probe-r2-thread-target.mjs
 *   ~/work/mylos-1112pm/w-n/probe-r2-auto-findings.mjs
 *
 * Each test states the exact input the reviewer used, so a fix that only moves
 * the numbers cannot pass. Order: one describe block per blocker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { CatchupRunner, DeliveryGate } from '../src/lib/catchup.js';
import { CatchupStateStore } from '../src/lib/catchup-state.js';
import * as deliveryLib from '../src/lib/delivery.js';
import { settleLiveDelivery, DELIVER } from '../src/lib/delivery.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOT_SOURCE = fs.readFileSync(path.join(ROOT, 'src/bot.js'), 'utf8');

function stateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-r3-')), 'state.json');
}

function seeded(T) {
  const state = new CatchupStateStore({ filePath: stateFile() }).load();
  state.setEventsSince('default', T);
  state.markGap('default');
  return state;
}

const msg = (id, at, extra = {}) => ({
  id, channel_id: 'dm', sender_id: 'peer', sender_name: 'peer',
  content: 'synthetic', created_at: at, parts: [], ...extra,
});

/** Slice out one function body from bot.js, exactly like the reviewer's probe. */
function extract(source, needle, from = 0) {
  const start = source.indexOf(needle, from);
  assert.notEqual(start, -1, `bot.js no longer contains ${needle}`);
  return start;
}

// ─── 1 · same-millisecond ties, timestamp page has no id order ───────────────

describe('r3 blocker 1 — an unordered timestamp page of tied rows', () => {
  it('delivers all 150 rows when the timestamp page keeps returning the lowest 100 ids', async () => {
    // Reviewer's fixture verbatim: uuid-000…uuid-149, all at one millisecond.
    // The timestamp query has no id tiebreak, so it stably returns the first
    // 100 rows it stored — exactly the LOWEST ids. A cursor started at the
    // "largest id seen" can only walk downwards and never reaches uuid-100+.
    const T = Date.now() - 60_000;
    const state = seeded(T);
    const all = Array.from({ length: 150 }, (_, i) => msg(`uuid-${String(i).padStart(3, '0')}`, T + 1000));

    const client = {
      async catchup() {
        return { events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: T + 1000 }], has_more: false };
      },
      async getMessages(_, o) {
        if (typeof o.before === 'string') {
          const anchor = all.find(x => x.id === o.before);
          if (!anchor) return { messages: [], has_more: false };
          const rows = all
            .filter(m => m.created_at < anchor.created_at
              || (m.created_at === anchor.created_at && m.id < anchor.id))
            .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
          return { messages: rows.slice(0, o.limit), has_more: rows.length > o.limit };
        }
        // No id tiebreak: stable order = insertion order, newest-first by time.
        return all
          .filter(m => m.created_at > o.since && m.created_at < o.before)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, o.limit);
      },
      async getThreadMessages() { return []; },
    };

    const delivered = [];
    const runner = new CatchupRunner({
      client, state, label: 'default', now: () => T + 30_000,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async x => delivered.push(x.message.id),
    });
    for (let i = 0; i < 4; i++) await runner.run();
    runner.dispose();

    const summary = {
      expected: 150,
      delivered: delivered.length,
      unique: new Set(delivered).size,
      dirty: state.isDirty('default'),
      missing: all.filter(x => !delivered.includes(x.id)).length,
    };
    assert.equal(summary.unique, 150,
      `id cursor must include rows above the arbitrary timestamp-page anchor: ${JSON.stringify(summary)}`);
    assert.equal(summary.delivered, 150, `nothing twice: ${JSON.stringify(summary)}`);
  });

  it('does not lose the tail when the final id page hits the per-run cap', async () => {
    // pageSize 3, maxMessagesPerRun 2, seven rows in one millisecond whose
    // timestamp page returns the OLDEST three (m5,m6,m7 by time is impossible
    // here — the reviewer used the id order m1..m7 with the page giving the
    // highest ids first). The cap must not commit a half-read page.
    const T = Date.now() - 60_000;
    const state = seeded(T);
    const all = Array.from({ length: 7 }, (_, i) => msg(`m${i + 1}`, T + 1000));

    const client = {
      async catchup() {
        return { events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: T + 1000 }], has_more: false };
      },
      async getMessages(_, o) {
        if (typeof o.before === 'string') {
          const anchor = all.find(x => x.id === o.before);
          if (!anchor) return { messages: [], has_more: false };
          const rows = all
            .filter(m => m.created_at < anchor.created_at
              || (m.created_at === anchor.created_at && m.id < anchor.id))
            .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
          return { messages: rows.slice(0, o.limit), has_more: rows.length > o.limit };
        }
        return all
          .filter(m => m.created_at > o.since && m.created_at < o.before)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, o.limit);
      },
      async getThreadMessages() { return []; },
    };

    const delivered = [];
    const runner = new CatchupRunner({
      client, state, label: 'default', now: () => T + 30_000,
      limits: { batchDelayMs: 0, messagePageSize: 3, maxMessagesPerRun: 2 },
      log: () => {},
      deliverMessage: async x => delivered.push(x.message.id),
    });
    for (let i = 0; i < 10; i++) await runner.run();
    runner.dispose();

    assert.equal(new Set(delivered).size, 7, `all seven delivered, got ${JSON.stringify(delivered)}`);
    assert.equal(delivered.length, 7, `and exactly once, got ${JSON.stringify(delivered)}`);
  });
});

// ─── 2 · backlog older than the delivered-id retention ──────────────────────

describe('r3 blocker 2 — a backlog older than the 48h retention', () => {
  it('does not replay 5001 old messages after the first run completed them', async () => {
    // Reviewer's fixture: created_at is 72h before "now", 5001 rows, bigger
    // than the 5000-id ring. After the first run the retention prune must not
    // make them deliverable again.
    const T = Date.now() - 72 * 3600_000;
    const state = new CatchupStateStore({ filePath: stateFile() }).load();
    state.setEventsSince('default', T);
    state.markGap('default');

    const messages = Array.from({ length: 5001 }, (_, i) =>
      msg(`m${String(i).padStart(5, '0')}`, T + 1000 + i * 10));

    const client = {
      async catchup() {
        return {
          events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: messages.at(-1).created_at }],
          has_more: false,
        };
      },
      async getMessages(_, o) {
        if (typeof o.before === 'string') {
          const at = messages.find(x => x.id === o.before);
          if (!at) return { messages: [], has_more: false };
          const rows = messages
            .filter(m => m.created_at < at.created_at
              || (m.created_at === at.created_at && m.id < at.id))
            .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
          return { messages: rows.slice(0, o.limit), has_more: rows.length > o.limit };
        }
        return messages
          .filter(m => m.created_at > o.since && m.created_at < o.before)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, o.limit);
      },
      async getThreadMessages() { return []; },
    };

    const delivered = [];
    const runner = new CatchupRunner({
      client, state, label: 'default',
      limits: { batchDelayMs: 0, batchSize: 10000, maxMessagesPerRun: 10000, messageMaxPages: 10000 },
      log: () => {},
      deliverMessage: async x => delivered.push(x.message.id),
    });
    await runner.run();
    const first = delivered.length;
    await runner.run();
    runner.dispose();

    assert.equal(first, 5001, `first run must retrieve the whole backlog, got ${first}`);
    assert.equal(delivered.length, 5001,
      `a completed old backlog must not be replayed, got ${delivered.length} deliveries / ${new Set(delivered).size} unique`);
  });
});

// ─── 3 · the scan's high-water mark grows between runs ──────────────────────

describe('r3 blocker 3 — growing hi while an old window is still open', () => {
  it('queries and delivers messages that arrived between run A and run B', async () => {
    // Reviewer's fixture: run A exhausted its budget with hi = T+10000; a
    // message lands at T+15000; run B sees the summary at T+15000.
    const T = Date.now() - 60_000;
    const state = seeded(T);
    state.extendTarget('default', 'channel', 'dm', T + 10000);

    const message = msg('between-runs', T + 15000);
    const queries = [];
    const client = {
      async catchup() {
        return { events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: T + 15000 }], has_more: false };
      },
      async getMessages(_, o) {
        queries.push({ before: o.before - T });
        return [message].filter(m => m.created_at > o.since && m.created_at < o.before);
      },
      async getThreadMessages() { return []; },
    };

    const delivered = [];
    const runner = new CatchupRunner({
      client, state, label: 'default', now: () => T + 20000,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async x => delivered.push(x.message.id),
    });
    await runner.run();
    runner.dispose();

    assert.deepEqual(delivered, ['between-runs'],
      `the message that arrived between the runs must be delivered; queries=${JSON.stringify(queries)}`);
    assert.equal(state.isDirty('default'), false);
  });
});

// ─── 4 · the real bot returns 'delivered', not DELIVER ─────────────────────

describe('r3 blocker 4 — the real DM pipeline return value', () => {
  it('records a genuinely successful live DM as delivered', async () => {
    // Reviewer's probe: run the real `deliverDm` body with stubbed C4, then
    // feed its return value to settleLiveDelivery.
    const start = extract(BOT_SOURCE, 'const deliverDm = async (');
    const end = BOT_SOURCE.indexOf('\n  };', start) + 5;
    let c4Calls = 0;
    const ctx = vm.createContext({
      // The real constants (plus the aliases bot.js imports), so the sandbox
      // cannot drift from the module.
      ...deliveryLib,
      DELIVERY_OK: deliveryLib.DELIVERED,
      DELIVERY_SKIP: deliveryLib.SKIP,
      decideDmDelivery: () => ({ verdict: 'deliver' }),
      POLICY_REJECT: 'rejected',
      POLICY_DELIVER: DELIVER,
      org: { access: {} },
      isSelf: () => false,
      getRateLimiter: () => ({ consume: () => true }),
      label: 'default',
      downloadMediaParts: async () => ({}),
      client: {},
      lp: 'synthetic',
      formatAttachments: () => '',
      MAX_CONTENT_LENGTH: 50000,
      buildDmContent: () => 'synthetic',
      dp: 'synthetic',
      sendToC4Awaited: async () => { c4Calls++; },
      C4_CHANNEL: 'fake',
      c4Endpoint: () => 'fake',
      console: { log() {}, warn() {} },
    });
    vm.runInContext(`${BOT_SOURCE.slice(start, end)}\nglobalThis.deliver = deliverDm;`, ctx);

    const outcome = await ctx.deliver({ message: { id: 'ok', sender_id: 'peer', sender_name: 'peer', content: 'synthetic' } });

    const state = seeded(Date.now() - 60_000);
    // Start from a closed gap, so the assertion measures what the settle does.
    state.settleGap('default', state.getGapEpoch('default'));
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.begin('ok');
    const result = settleLiveDelivery({
      outcome, id: 'ok', at: Date.now(), gate,
      markGap: () => state.markGap('default'),
    });

    assert.equal(c4Calls, 1, 'C4 was really called once');
    assert.equal(result, 'delivered', `success must be recorded as delivered, not "${result}"`);
    assert.equal(state.hasSeen('default', 'ok'), true, 'and remembered, so replay skips it');
    assert.equal(state.isDirty('default'), false, 'a success must not open a gap');
  });

  it('records a rejected live DM without opening a gap', async () => {
    const start = extract(BOT_SOURCE, 'const deliverDm = async (');
    const end = BOT_SOURCE.indexOf('\n  };', start) + 5;
    const ctx = vm.createContext({
      ...deliveryLib,
      decideDmDelivery: () => ({ verdict: 'rejected', reason: 'dmPolicy:allowlist' }),
      POLICY_REJECT: 'rejected',
      POLICY_DELIVER: DELIVER,
      org: { access: {} }, isSelf: () => false,
      getRateLimiter: () => ({ consume: () => true }),
      label: 'default', downloadMediaParts: async () => ({}), client: {},
      lp: 'synthetic', formatAttachments: () => '', MAX_CONTENT_LENGTH: 50000,
      buildDmContent: () => 'synthetic', dp: 'synthetic',
      sendToC4Awaited: async () => { throw new Error('must not be called'); },
      C4_CHANNEL: 'fake', c4Endpoint: () => 'fake',
      console: { log() {}, warn() {} },
    });
    vm.runInContext(`${BOT_SOURCE.slice(start, end)}\nglobalThis.deliver = deliverDm;`, ctx);

    const outcome = await ctx.deliver({ message: { id: 'no', sender_id: 'stranger', content: 'synthetic' } });
    const state = seeded(Date.now() - 60_000);
    // Start from a closed gap, so the assertion measures what the settle does.
    state.settleGap('default', state.getGapEpoch('default'));
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.begin('no');
    const result = settleLiveDelivery({
      outcome, id: 'no', at: Date.now(), gate,
      markGap: () => state.markGap('default'),
    });

    assert.equal(outcome, 'rejected', `policy verdict must survive as 'rejected', got ${outcome}`);
    assert.equal(state.hasSeen('default', 'no'), true);
    assert.equal(state.isDirty('default'), false, 'a policy rejection is final, not a gap');
  });
});

// ─── 5 · a live delivery still in flight while catch-up scans ───────────────

describe('r3 blocker 5 — in-flight live delivery during a scan', () => {
  it('keeps the gap open while a live delivery is still in flight, then replays it', async () => {
    // Reviewer's probe verbatim: gate.begin('pending-live') BEFORE the run,
    // summary + message at T+10000, another event at T+20000, run at T+30000.
    const T = Date.now() - 60_000;
    const state = seeded(T);
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.begin('pending-live');

    const events = [
      { type: 'channel_message_summary', channel_id: 'dm', occurred_at: T + 10000 },
      { type: 'bot_status_changed', occurred_at: T + 20000 },
    ];
    const message = msg('pending-live', T + 10000);
    const delivered = [];
    const client = {
      async catchup({ since }) { return { events: events.filter(e => e.occurred_at > since), has_more: false }; },
      async getMessages() { return [message]; },
      async getThreadMessages() { return []; },
    };
    const runner = new CatchupRunner({
      client, state, gate, label: 'default', now: () => T + 30000,
      limits: { batchDelayMs: 0 }, log: () => {},
      deliverMessage: async x => delivered.push(x.message.id),
      deliverEvent: async () => {},
    });
    await runner.run();
    const afterScan = {
      boundary: state.getEventsSince('default') - T,
      dirty: state.isDirty('default'),
      inFlight: gate.inFlight.size,
      delivered: delivered.length,
    };

    settleLiveDelivery({
      error: new Error('synthetic late C4 failure'),
      id: message.id, at: message.created_at, gate,
      markGap: () => state.markGap('default'), save: () => state.save(),
    });
    await runner.run();
    runner.dispose();

    const after = {
      boundary: state.getEventsSince('default') - T,
      dirty: state.isDirty('default'),
      delivered: delivered.length,
    };
    assert.deepEqual(delivered, ['pending-live'],
      `failed live message must still be delivered by replay; afterScan=${JSON.stringify(afterScan)} after=${JSON.stringify(after)}`);
  });

  it('never records an in-flight id as handled in the scan state', async () => {
    // Same interleaving, but the window stays open (page budget bites), so the
    // target record survives and can be inspected.
    const T = Date.now() - 60_000;
    const state = seeded(T);
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.begin('pending-live');

    const message = msg('pending-live', T + 10000);
    const client = {
      async catchup() {
        return { events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: T + 10000 }], has_more: false };
      },
      async getMessages() { return [message]; },
      async getThreadMessages() { return []; },
    };
    const runner = new CatchupRunner({
      client, state, gate, label: 'default', now: () => T + 30000,
      limits: { batchDelayMs: 0, messageMaxPages: 0 }, log: () => {},
      deliverMessage: async () => {},
      deliverEvent: async () => {},
    });
    await runner.run();
    runner.dispose();

    const target = state.getTarget('default', 'channel', 'dm');
    const ids = target ? target.ids.map(([id]) => id) : [];
    assert.equal(ids.includes('pending-live'), false,
      `an in-flight id must not be written into the open window: ${JSON.stringify(ids)}`);
    assert.equal(state.isDirty('default'), true, 'and the gap must stay open');
  });
});

// ─── 8 · runner → bot callback contract ─────────────────────────────────────

describe('r3 blocker 8 — the runner/bot callback field names', () => {
  it('hands the scanned thread id to the real bot callback', async () => {
    // Reviewer's probe verbatim: extract the real `deliverMessage` callback
    // from bot.js and feed it the runner's argument shape.
    const start = extract(BOT_SOURCE, 'deliverMessage: async ({ kind, message, channelId, threadId }) => {');
    const from = BOT_SOURCE.indexOf('deliverMessage: ', start) + 'deliverMessage: '.length;
    const end = BOT_SOURCE.indexOf('\n    },', from) + 6;

    const calls = [];
    const ctx = vm.createContext({
      deliverThread: async x => calls.push({ threadId: x.threadId, snapshotId: x.snapshot.thread.id }),
      deliverDm: async () => {},
    });
    vm.runInContext(`globalThis.callback = ${BOT_SOURCE.slice(from, end)}`, ctx);

    const T = Date.now() - 60_000;
    const state = seeded(T);
    const client = {
      async catchup() {
        return { events: [{ type: 'thread_message_summary', thread_id: 'thread-real', occurred_at: T + 1000 }], has_more: false };
      },
      async getThreadMessages() {
        return [{ id: 'incoming', sender_id: 'peer', created_at: T + 1000, content: 'synthetic' }];
      },
      async getMessages() { return []; },
    };
    const runner = new CatchupRunner({
      client, state, label: 'default', now: () => T + 30000,
      limits: { batchDelayMs: 0 }, log: () => {},
      deliverMessage: ctx.callback,
    });
    await runner.run();
    runner.dispose();

    assert.equal(calls.length, 1, `the callback must be called exactly once: ${JSON.stringify(calls)}`);
    assert.equal(calls[0].threadId, 'thread-real', 'actual bot callback must receive the scanned thread ID');
    assert.equal(calls[0].snapshotId, 'thread-real', 'and the snapshot it builds must carry it too');
  });

  it('uses the same field name for channels', async () => {
    // Channel deliveries must not regress while threadId is wired through.
    const start = extract(BOT_SOURCE, 'deliverMessage: async ({ kind, message, channelId, threadId }) => {');
    const from = BOT_SOURCE.indexOf('deliverMessage: ', start) + 'deliverMessage: '.length;
    const end = BOT_SOURCE.indexOf('\n    },', from) + 6;

    const calls = [];
    const ctx = vm.createContext({
      deliverThread: async () => {},
      deliverDm: async x => calls.push({ channelId: x.channelId }),
    });
    vm.runInContext(`globalThis.callback = ${BOT_SOURCE.slice(from, end)}`, ctx);

    const T = Date.now() - 60_000;
    const state = seeded(T);
    const client = {
      async catchup() {
        return { events: [{ type: 'channel_message_summary', channel_id: 'dm-real', occurred_at: T + 1000 }], has_more: false };
      },
      async getMessages() { return [{ id: 'c1', sender_id: 'peer', created_at: T + 1000, content: 'synthetic' }]; },
      async getThreadMessages() { return []; },
    };
    const runner = new CatchupRunner({
      client, state, label: 'default', now: () => T + 30000,
      limits: { batchDelayMs: 0 }, log: () => {},
      deliverMessage: ctx.callback,
    });
    await runner.run();
    runner.dispose();

    assert.deepEqual(calls, [{ channelId: 'dm-real' }], `the scanned channel id must reach the callback: ${JSON.stringify(calls)}`);
  });
});
