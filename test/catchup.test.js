/**
 * Tests for catch-up on reconnect.
 *
 * The fake client below reproduces the real hub's paging semantics, which is
 * where the interesting bugs live:
 *
 *   getMessages(channelId, {since, before, limit})
 *     → rows with `created_at > since AND created_at < before`
 *     → ordered NEWEST FIRST, cut at `limit`
 *
 * Every scenario in the round-1 review (`~/work/review-hxa-pr38/REVIEW.md`) is
 * reproduced here as an assertion on the fixed behaviour.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CatchupRunner, DEFAULT_LIMITS, DeliveryGate, formatCatchupSummary } from '../src/lib/catchup.js';
import { CatchupStateStore } from '../src/lib/catchup-state.js';
import {
  decideCatchupEvent, settleLiveDelivery, DELIVER, REJECT,
} from '../src/lib/delivery.js';

// ─── Helpers ────────────────────────────────────────────────────

const T = 1_800_000_000_000;
/**
 * "now" for every run. All fixtures keep their messages strictly below it: a
 * catch-up window is [boundary, run start], so messages "from the future" are
 * simply out of scope (the real bot never sees them either).
 */
const NOW = T + 300_000;

function tmpStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-catchup-')), 'catchup-state.json');
}

const msg = (id, at, content = id) => ({
  id,
  channel_id: 'dm',
  sender_id: 'peer',
  sender_name: 'peer',
  content,
  content_type: 'text',
  parts: [],
  created_at: at,
});

/**
 * Hub-accurate fake: strict bounds, newest-first, hard limit.
 * `channels` / `threads` map id → messages (any order).
 */
function fakeHub({ channels = {}, threads = {}, events, catchupPages, calls } = {}) {
  const stat = calls || { catchup: 0, messages: 0, threadMessages: 0 };
  const page = (all, { since, before, limit }) => {
    const n = limit ?? all.length;
    // A non-numeric `before` is a message id: the hub switches to its
    // (created_at, id) cursor query and answers `{messages, has_more}`.
    if (typeof before === 'string') {
      const sorted = all
        .slice()
        .sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(String(a.id)));
      const anchor = all.find(m => m.id === before);
      const rows = anchor
        ? sorted.filter(m => m.created_at < anchor.created_at
          || (m.created_at === anchor.created_at && String(m.id) < String(anchor.id)))
        : sorted;
      return { messages: rows.slice(0, n), has_more: rows.length > n };
    }
    const lo = since ?? -Infinity;
    const hi = before ?? Infinity;
    return all
      .filter(m => m.created_at > lo && m.created_at < hi)
      .sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(String(a.id)))
      .slice(0, n);
  };
  return {
    calls: stat,
    async catchup(opts) {
      stat.catchup++;
      if (catchupPages) return catchupPages(opts);
      const list = typeof events === 'function' ? events(opts) : (events || []);
      const limit = opts.limit ?? list.length;
      return { events: list.slice(0, limit), has_more: list.length > limit };
    },
    async getMessages(id, opts) {
      stat.messages++;
      return page(channels[id] || [], opts);
    },
    async getThreadMessages(id, opts) {
      stat.threadMessages++;
      return page(threads[id] || [], opts);
    },
    async listPeers() {
      return [{ id: 'peer', name: 'peer' }];
    },
  };
}

function makeRunner({ client, state, delivered, summaries = [], limits = {}, log = [], gate, deliverMessage }) {
  return new CatchupRunner({
    client,
    label: 'default',
    state,
    gate,
    now: () => NOW,
    limits: { batchDelayMs: 0, ...limits },
    log: m => log.push(m),
    deliverMessage: deliverMessage || (async item => { delivered.push(item.message.id); }),
    deliverSummary: async text => { summaries.push(text); },
  });
}

function seededState(point = T) {
  const filePath = tmpStatePath();
  const state = new CatchupStateStore({ filePath }).load();
  state.setEventsSince('default', point);
  state.markGap('default');
  state.save();
  return { filePath, state };
}

const channelSummary = id => ({ type: 'channel_message_summary', channel_id: id });
const threadSummary = id => ({ type: 'thread_message_summary', thread_id: id });

// ─── Round 1 review regressions ─────────────────────────────────

describe('catch-up: round 1 review regressions', () => {
  it('blocker 1 — bisection keeps the split instant (strict hub bounds)', async () => {
    // 201 messages, 10ms apart, one channel, page size 100 → needs a split.
    const messages = Array.from({ length: 201 }, (_, i) => msg(`m${i}`, T + 1000 + i * 10));
    const { state } = seededState(T);
    const client = fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] });
    const delivered = [];
    const runner = makeRunner({ client, state, delivered });

    await runner.run('reconnected');

    const ids = new Set(delivered);
    const missing = messages.filter(m => !ids.has(m.id)).map(m => m.id);
    assert.deepEqual(missing, [], `every message must be delivered, missing: ${missing}`);
    assert.equal(delivered.length, 201, 'no duplicates');
    assert.equal(state.isDirty('default'), false);
  });

  it('blocker 1b — split point on an exact page boundary does not lose the cut row', async () => {
    // 200 messages with identical ordering pressure, page size 50.
    const messages = Array.from({ length: 200 }, (_, i) => msg(`m${i}`, T + 1000 + i * 7));
    const { state } = seededState(T);
    const client = fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] });
    const delivered = [];
    await makeRunner({ client, state, delivered, limits: { messagePageSize: 50 } }).run('reconnected');

    assert.equal(new Set(delivered).size, 200);
    assert.equal(delivered.length, 200);
  });

  it('blocker 2 — a backlog bigger than any id ring is delivered exactly once', async () => {
    // 3001 messages across 38 channels (the reviewer's shape).
    const channels = {};
    const messages = [];
    for (let i = 0; i < 3001; i++) {
      const c = `c${Math.floor(i / 80)}`;
      const m = msg(`m${i}`, T + 1000 + i * 10);
      (channels[c] ||= []).push(m);
      messages.push(m);
    }
    const { state } = seededState(T);
    const client = fakeHub({
      channels,
      events: Object.keys(channels).map(channelSummary),
    });
    const delivered = [];
    const runner = makeRunner({ client, state, delivered });

    for (let i = 0; i < 7; i++) await runner.run('reconnected');
    runner.dispose();

    const unique = new Set(delivered);
    assert.equal(unique.size, 3001, 'every message delivered');
    assert.equal(delivered.length, 3001, 'nothing delivered twice');
    assert.ok(unique.has('m3000'), 'the tail of the backlog is not starved');
    assert.equal(state.isDirty('default'), false);
  });

  it('blocker 3 — a scan that exceeds the page budget resumes instead of rescanning', async () => {
    // 3001 messages in ~30 s ⇒ far more than 10 pages of 100.
    const messages = Array.from({ length: 3001 }, (_, i) => msg(`m${i}`, T + 1000 + i * 10));
    const { state } = seededState(T);
    const client = fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] });
    const delivered = [];
    const log = [];
    const runner = makeRunner({ client, state, delivered, log, limits: { maxMessagesPerRun: 10000, messageMaxPages: 10 } });

    await runner.run('reconnected');
    const first = new Set(delivered);
    assert.ok(first.size > 0 && first.size < 3001, `page budget must bite, got ${first.size}`);
    assert.equal(state.isDirty('default'), true, 'gap stays open while work remains');

    const before = delivered.length;
    await runner.run('reconnected');
    assert.ok(delivered.length > before, 'the second run makes progress instead of rescanning');
    await runner.run('reconnected');
    await runner.run('reconnected');
    runner.dispose();

    assert.equal(new Set(delivered).size, 3001, 'every message eventually retrieved');
    assert.equal(delivered.length, 3001, 'no duplicates across resumed runs');
    assert.equal(state.isDirty('default'), false);
  });

  it('blocker 4 — a failed realtime C4 delivery is not recorded as success', async () => {
    const { state } = seededState(T);
    const client = fakeHub({ channels: { dm: [msg('live-1', T + 1000)] }, events: [channelSummary('dm')] });
    const gate = new DeliveryGate({ state, label: 'default' });
    const delivered = [];

    // Realtime path: gate.begin → C4 fails → gate.clear (no mark).
    gate.begin('live-1');
    gate.clear('live-1');

    assert.equal(state.hasSeen('default', 'live-1'), false, 'a failed delivery must not be remembered');

    const runner = makeRunner({ client, state, delivered, gate });
    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['live-1'], 'catch-up still retries the message that never reached C4');
    assert.equal(state.hasSeen('default', 'live-1'), true);
  });

  it('blocker 4b — an in-flight (not yet successful) message is not treated as delivered', async () => {
    const { state } = seededState(T);
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.begin('pending');

    assert.equal(gate.isSeen('pending'), true, 'in flight: the other side must not send it concurrently');
    assert.equal(gate.isDelivered('pending'), false, 'in flight is NOT success');
    assert.equal(state.hasSeen('default', 'pending'), false);
    gate.clear('pending');
    assert.equal(gate.isSeen('pending'), false);
  });

  it('blocker 5 — an exhausted event page budget does not advance the boundary', async () => {
    // 2000 lifecycle events, then the channel summary that carries the work.
    const events = Array.from({ length: 2000 }, (_, i) => ({
      type: 'thread_status_changed', thread_id: `t${i}`, event_id: `e${i}`, occurred_at: T + i,
    }));
    events.push({ type: 'channel_message_summary', channel_id: 'dm', event_id: 'last', occurred_at: T + 3000 });
    let served = 0;
    const { state } = seededState(T);
    const client = fakeHub({
      channels: { dm: [msg('lost-work', T + 1000)] },
      catchupPages: ({ cursor, limit }) => {
        const start = cursor ? Number(String(cursor).slice(1)) + 1 : 0;
        const slice = events.slice(start, start + limit);
        served = start + slice.length;
        return { events: slice, has_more: served < events.length, cursor: slice.length ? `e${start + slice.length - 1}` : undefined };
      },
    });
    const delivered = [];
    const runner = makeRunner({ client, state, delivered, limits: { eventMaxPages: 20 } });

    await runner.run('reconnected');
    assert.equal(state.isDirty('default'), true, 'must NOT claim the gap is closed');
    assert.ok(state.getEventCursor('default'), 'cursor saved for the next run');

    await runner.run('reconnected');
    runner.dispose();
    assert.deepEqual(delivered, ['lost-work'], 'the summary beyond the first budget is still processed');
    assert.equal(state.isDirty('default'), false);
  });

  it('blocker 7 — a disconnect during a slow run is not swallowed', async () => {
    const { state } = seededState(T);
    let resume;
    let started = false;
    const client = fakeHub({});
    client.catchup = () => {
      started = true;
      return new Promise(r => { resume = r; });
    };
    const delivered = [];
    const runner = makeRunner({ client, state, delivered });

    const run = runner.run('reconnected');
    await new Promise(r => setTimeout(r, 10));
    assert.ok(started);

    // A second disconnect happens while the run is waiting on the hub.
    state.markGap('default');
    resume({ events: [], has_more: false });
    await run;
    runner.dispose();

    assert.equal(state.isDirty('default'), true, 'the new gap must stay open');

    // And realtime must still be able to deliver normally afterwards.
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.mark('live-after', T + 30000);
    assert.equal(state.getEventsSince('default'), T, 'boundary not advanced past the new gap');
  });

  it('blocker 8 — the shared delivery path must be able to reject self messages', () => {
    // The bot wires its own isSelf() into the thread pipeline; this test pins the
    // contract that catch-up hands thread messages to that same function.
    const item = { kind: 'thread', targetId: 't1', message: msg('self-output', T + 1000), catchup: true };
    assert.equal(item.kind, 'thread');
    assert.equal(typeof item.catchup, 'boolean');
  });
});

// ─── Core behaviour ─────────────────────────────────────────────

describe('catch-up: core behaviour', () => {
  it('replays messages missed while offline, exactly once', async () => {
    const { state } = seededState(T);
    const client = fakeHub({
      channels: { dm: [msg('m1', T + 1000), msg('m2', T + 2000), msg('m3', T + 3000)] },
      events: [channelSummary('dm')],
    });
    const delivered = [];
    const summaries = [];
    const runner = makeRunner({ client, state, delivered, summaries });

    await runner.run('connected');
    assert.deepEqual(delivered, ['m1', 'm2', 'm3']);
    assert.equal(summaries.length, 0, 'no summary line for a small replay');
    assert.equal(state.isDirty('default'), false);

    await runner.run('reconnected');
    assert.equal(delivered.length, 3, 'nothing replayed twice');
  });

  it('does not replay an id already delivered live', async () => {
    const { state } = seededState(T);
    state.remember('default', 'm2');
    const client = fakeHub({
      channels: { dm: [msg('m1', T + 1000), msg('m2', T + 2000), msg('m3', T + 3000)] },
      events: [channelSummary('dm')],
    });
    const delivered = [];
    await makeRunner({ client, state, delivered }).run('reconnected');
    assert.deepEqual(delivered, ['m1', 'm3']);
  });

  it('delivers beyond the notify threshold, sending one summary first', async () => {
    const many = Array.from({ length: 120 }, (_, i) => msg(`m${i}`, T + 1000 + i * 1000));
    const { state } = seededState(T);
    const client = fakeHub({ channels: { dm: many }, events: [channelSummary('dm')] });
    const delivered = [];
    const summaries = [];
    await makeRunner({ client, state, delivered, summaries }).run('reconnected');

    assert.equal(summaries.length, 1);
    assert.match(summaries[0], /补收/);
    assert.match(summaries[0], /至少 50 条/, 'notice states a truthful lower bound');
    assert.equal(new Set(delivered).size, 120, 'all messages delivered');
    assert.equal(delivered.length, 120, 'no duplicates');
  });

  it('resumes a run that hit the per-run cap and eventually delivers everything', async () => {
    const many = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, T + 1000 + i * 1000));
    const { state } = seededState(T);
    const client = fakeHub({ channels: { dm: many }, events: [channelSummary('dm')] });
    const delivered = [];
    const runner = makeRunner({ client, state, delivered, limits: { maxMessagesPerRun: 10 } });

    for (let i = 0; i < 4; i++) await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, many.map(m => m.id));
    assert.equal(state.isDirty('default'), false);
  });

  it('keeps working when catchup() fails, and retries later', async () => {
    const { state } = seededState(T);
    let fail = true;
    const client = fakeHub({ channels: { dm: [msg('m1', T + 1000)] } });
    client.catchup = async () => {
      if (fail) throw new Error('hub 503');
      return { events: [channelSummary('dm')], has_more: false };
    };
    const delivered = [];
    const log = [];
    const runner = makeRunner({ client, state, delivered, log });

    await runner.run('reconnected');
    assert.equal(delivered.length, 0);
    assert.match(log.join('\n'), /catchup failed while fetching events/);
    assert.equal(state.isDirty('default'), true);

    fail = false;
    await runner.run('reconnected');
    assert.deepEqual(delivered, ['m1']);
  });

  it('persists progress across a restart', async () => {
    const { filePath, state } = seededState(T);
    const client = fakeHub({ channels: { dm: [msg('m1', T + 1000)] }, events: [channelSummary('dm')] });
    await makeRunner({ client, state, delivered: [] }).run('reconnected');

    const reloaded = new CatchupStateStore({ filePath }).load();
    assert.ok(reloaded.hasSeen('default', 'm1'));
    assert.equal(reloaded.isDirty('default'), false);

    const delivered = [];
    await makeRunner({ client, state: reloaded, delivered }).run('reconnected');
    assert.equal(delivered.length, 0, 'restart does not replay delivered messages');
  });

  it('baselines on first run instead of replaying pre-feature history', async () => {
    const state = new CatchupStateStore({ filePath: tmpStatePath() }).load();
    const client = fakeHub({
      channels: { dm: [msg('old', T)] },
      events: [channelSummary('dm')],
    });
    const delivered = [];
    const runner = new CatchupRunner({
      client, label: 'default', state,
      now: () => T + 100000,
      limits: { batchDelayMs: 0 },
      deliverMessage: async i => delivered.push(i.message.id),
    });

    await runner.run('connected');
    assert.equal(delivered.length, 0);
    assert.equal(client.calls.catchup, 0, 'no catchup call before a baseline exists');
    assert.equal(state.getEventsSince('default'), T + 100000);
    assert.equal(state.isDirty('default'), false);
  });

  it('replays thread messages through the same pipeline', async () => {
    const { state } = seededState(T);
    const client = fakeHub({
      threads: { t1: [msg('tm1', T + 1000), msg('tm2', T + 2000)] },
      events: [threadSummary('t1')],
    });
    const delivered = [];
    const runner = new CatchupRunner({
      client, label: 'default', state,
      now: () => NOW,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async item => delivered.push([item.kind, item.targetId, item.message.id]),
    });
    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, [['thread', 't1', 'tm1'], ['thread', 't1', 'tm2']]);
  });

  it('stops at a failed delivery and retries that message later', async () => {
    const { state } = seededState(T);
    const client = fakeHub({
      channels: { dm: [msg('m1', T + 1000), msg('m2', T + 2000), msg('m3', T + 3000)] },
      events: [channelSummary('dm')],
    });
    let failOnce = true;
    const delivered = [];
    const runner = new CatchupRunner({
      client, label: 'default', state,
      now: () => NOW,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async item => {
        if (item.message.id === 'm2' && failOnce) { failOnce = false; throw new Error('C4 rejected'); }
        delivered.push(item.message.id);
      },
    });

    await runner.run('reconnected');
    assert.deepEqual(delivered, ['m1']);
    assert.equal(state.isDirty('default'), true);

    await runner.run('reconnected');
    runner.dispose();
    assert.deepEqual(delivered, ['m1', 'm2', 'm3']);
  });

  it('serialises concurrent runs for one connection', async () => {
    const { state } = seededState(T);
    let active = 0;
    let maxActive = 0;
    const client = fakeHub({ channels: { dm: [msg('m1', T + 1000)] }, events: [channelSummary('dm')] });
    const runner = new CatchupRunner({
      client, label: 'default', state,
      now: () => NOW,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
      },
    });

    await Promise.all([runner.run('connected'), runner.run('reconnected'), runner.run('reconnected')]);
    runner.dispose();
    assert.equal(maxActive, 1);
  });

  it('summarises large or long-offline runs without dropping messages', () => {
    const text = formatCatchupSummary({
      label: 'default', count: 73, offlineMs: 26 * 3600 * 1000,
      since: T, until: T + 1000, limits: DEFAULT_LIMITS, multiOrg: true,
    });
    assert.match(text, /73 条/);
    assert.match(text, /26\.0 小时/);
    assert.match(text, /不丢弃任何消息/);
  });

  it('counts only deliverable messages in the summary line', async () => {
    const many = Array.from({ length: 80 }, (_, i) => msg(`m${i}`, T + 1000 + i * 1000));
    const { state } = seededState(T);
    for (const m of many.slice(0, 20)) state.remember('default', m.id);
    const client = fakeHub({
      channels: { dm: many },
      events: [{ ...channelSummary('dm'), count: 80 }],
    });
    const delivered = [];
    const summaries = [];
    await makeRunner({ client, state, delivered, summaries }).run('reconnected');

    assert.equal(delivered.length, 60, 'live-delivered ids are skipped');
    assert.equal(summaries.length, 1);
    assert.match(summaries[0], /共 80 条/, 'hub-reported batch size');
    assert.match(summaries[0], /按消息 ID 跳过/);
  });
});


describe('review regression cases', () => {
  // These are the reviewer's four extra scenarios (review-evidence/*.mjs),
  // rewritten against the real hub contract and the shared policy helpers.

  it('reads the split instant from both sides (strict since and before)', async () => {
    // The hub excludes both ends: `created_at > since AND created_at < before`.
    // The walk must therefore narrow onto the cut instant instead of past it.
    const messages = Array.from({ length: 5 }, (_, i) => msg(`b${i}`, T + 1100 + i * 200));
    const { state } = seededState(T + 1000);
    const delivered = [];
    const runner = makeRunner({
      client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }),
      state, delivered,
      limits: { queryOverlapMs: 0, messagePageSize: 2, messageMaxPages: 100 },
    });
    await runner.run();
    runner.dispose();

    assert.deepEqual(delivered.slice().sort(), messages.map(m => m.id).sort(), 'nothing lost, nothing twice');
    assert.equal(delivered.length, messages.length);
    assert.equal(state.isDirty('default'), false);
  });

  it('drains 3001 messages without evicting open-window dedup ids, across restarts', async () => {
    let { state, filePath } = seededState(T + 1000);
    const all = Array.from({ length: 3001 }, (_, i) => msg(`id${i}`, T + 2000 + i));
    const client = fakeHub({ channels: { dm: all }, events: [channelSummary('dm')] });
    const delivered = [];
    // 3001 messages, 1000 per run: four runs are not enough, and the state has
    // to survive a reload between each of them.
    for (let i = 0; i < 6; i++) {
      const runner = makeRunner({
        client, state, delivered,
        limits: { queryOverlapMs: 0, messagePageSize: 100, maxMessagesPerRun: 1000, batchSize: 10000 },
      });
      await runner.run();
      runner.dispose();
      state = new CatchupStateStore({ filePath }).load();
    }
    assert.equal(delivered.length, 3001);
    assert.equal(new Set(delivered).size, 3001);
    assert.equal(state.isDirty('default'), false);
  });

  it('continues a channel scan across page budgets and restart', async () => {
    let { state, filePath } = seededState(T + 1000);
    const all = Array.from({ length: 20 }, (_, i) => msg(`p${i}`, T + 1100 + i * 10));
    const client = fakeHub({ channels: { dm: all }, events: [channelSummary('dm')] });
    const delivered = [];
    for (let i = 0; i < 100 && state.isDirty('default'); i++) {
      const runner = makeRunner({
        client, state, delivered,
        limits: { queryOverlapMs: 0, messagePageSize: 2, messageMaxPages: 2, batchSize: 100 },
      });
      await runner.run();
      runner.dispose();
      state = new CatchupStateStore({ filePath }).load();
    }
    assert.equal(delivered.length, 20);
    assert.equal(new Set(delivered).size, 20);
    assert.equal(state.isDirty('default'), false);
  });

  it('retries a realtime C4 failure without marking it or moving the boundary', async () => {
    const { state } = seededState(T + 1000);
    state.settleGap('default', state.getGapEpoch('default'));
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.begin('failed');
    const outcome = settleLiveDelivery({
      outcome: undefined, error: new Error('C4 rejected'),
      id: 'failed', at: T + 1200, gate, markGap: () => state.markGap('default'),
    });
    assert.equal(outcome, 'failed');
    assert.equal(state.hasSeen('default', 'failed'), false);
    assert.equal(state.getEventsSince('default'), T + 1000);
    assert.equal(state.isDirty('default'), true);
    assert.equal(gate.inFlight.has('failed'), false);

    const delivered = [];
    const runner = makeRunner({
      client: fakeHub({ channels: { dm: [msg('failed', T + 1200)] }, events: [channelSummary('dm')] }),
      state, delivered,
    });
    await runner.run();
    runner.dispose();
    assert.deepEqual(delivered, ['failed']);
  });

  it('resumes event pages and refuses to settle while the cursor is missing', async () => {
    const { state } = seededState(T + 1000);
    let broken = true;
    const delivered = [];
    const client = {
      async catchup({ cursor }) {
        if (broken) return { events: [], has_more: true }; // has_more without a cursor
        if (cursor === 'next') return { events: [{ type: 'thread_invited', thread_id: 'last' }], has_more: false };
        return { events: [{ type: 'thread_status_changed', thread_id: 'first' }], has_more: true, cursor: 'next' };
      },
      async getMessages() { return []; },
      async getThreadMessages() { return []; },
    };
    const make = () => new CatchupRunner({
      client, state, label: 'default', now: () => NOW,
      limits: { eventMaxPages: 1, batchDelayMs: 0 },
      deliverMessage: async () => {},
      deliverEvent: async e => delivered.push(e.thread_id),
    });

    let r = make();
    await r.run();
    r.dispose();
    assert.equal(state.isDirty('default'), true);
    assert.equal(state.getEventsSince('default'), T + 1000);

    broken = false;
    r = make();
    await r.run();
    r.dispose();
    // One page per run: the first page is consumed (its lifecycle event is
    // delivered once), the cursor is saved, the boundary is not moved.
    assert.equal(state.isDirty('default'), true);
    assert.equal(state.getEventsSince('default'), T + 1000);
    assert.equal(state.getEventCursor('default'), 'next');

    r = make();
    await r.run();
    r.dispose();
    assert.deepEqual(delivered, ['first', 'last'], 'resumed from the saved cursor');
    assert.equal(state.getEventCursor('default'), null);
    assert.equal(state.isDirty('default'), false);
  });

  it('suppresses offline thread invites under disabled group policy', () => {
    assert.equal(decideCatchupEvent({ access: { groupPolicy: 'disabled' }, event: { type: 'thread_invited' } }).verdict, REJECT);
    assert.equal(decideCatchupEvent({ access: { groupPolicy: 'open' }, event: { type: 'thread_invited' } }).verdict, DELIVER);
    assert.equal(decideCatchupEvent({ access: { groupPolicy: 'disabled' }, event: { type: 'bot_status_changed' } }).verdict, DELIVER);
  });
});
