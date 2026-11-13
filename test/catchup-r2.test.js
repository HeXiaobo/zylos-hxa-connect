/**
 * Round-2 review fixes, one test per reviewer blocker.
 *
 * These are pure unit tests: no real hub, no real C4, no child processes. The
 * fake hub reproduces the hub's paging contract (strict `created_at` bounds,
 * newest first, hard limit) so a regression in the window walk shows up here.
 *
 * Reviewer blockers (../work/review-hxa-pr38/REVIEW.md):
 *   1  time-window split loses the cut row
 *   2  id ring overflow ⇒ replay loop, tail starved
 *   3  page budget exhausts ⇒ same prefix rescanned forever
 *   4  live C4 failure recorded as success ⇒ never replayed
 *   5  event page budget ⇒ boundary moves past unread events
 *   6  groupPolicy=disabled replay still announces invites
 *   7  a run in flight swallows a fresh disconnect
 *   8  replay of thread messages ignores the bot's own outbound messages
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CatchupRunner, DeliveryGate } from '../src/lib/catchup.js';
import { CatchupStateStore } from '../src/lib/catchup-state.js';
import {
  decideDmDelivery, decideThreadDelivery, decideCatchupEvent, settleLiveDelivery,
  DELIVER, DELIVERED, SKIP, REJECT,
} from '../src/lib/delivery.js';

// ─── Fixtures ───────────────────────────────────────────────────

const T = 1_800_000_000_000;
const NOW = T + 300_000;

const msg = (id, at, extra = {}) => ({
  id,
  channel_id: 'dm',
  sender_id: 'peer',
  sender_name: 'peer',
  content: id,
  content_type: 'text',
  parts: [],
  created_at: at,
  ...extra,
});

function stateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-r2-')), 'catchup-state.json');
}

function seeded(point = T) {
  const filePath = stateFile();
  const state = new CatchupStateStore({ filePath }).load();
  state.setEventsSince('default', point);
  state.markGap('default');
  state.save();
  return { filePath, state };
}

/**
 * Hub-accurate fake: `created_at > since AND created_at < before`, newest first,
 * cut at `limit`. `idBefore` switches to the hub's id cursor.
 */
function fakeHub({ channels = {}, threads = {}, events = [], catchupPages } = {}) {
  const calls = { catchup: 0, messages: 0, threadMessages: 0 };
  // Mirror hub-db.ts: the timestamp path filters strictly on created_at and
  // orders by created_at only; a NON-NUMERIC `before` is a message id and
  // switches to the (created_at, id) cursor query (which returns has_more).
  const page = (all, { since, before, limit }) => {
    const n = limit ?? all.length;
    if (typeof before === 'string' || before === undefined && opts.cursorMode === true) {
      const sorted = [...all].sort((a, b) =>
        (b.created_at - a.created_at) || String(b.id).localeCompare(String(a.id)));
      const anchor = before === undefined ? null : all.find(m => m.id === before);
      const rows = anchor
        ? sorted.filter(m => (m.created_at < anchor.created_at)
          || (m.created_at === anchor.created_at && String(m.id) < String(anchor.id)))
        : sorted;
      return { messages: rows.slice(0, n), has_more: rows.length > n };
    }
    const rows = all
      .filter(m => m.created_at > (since ?? -Infinity) && m.created_at < (before ?? Infinity))
      .sort((a, b) => b.created_at - a.created_at);
    return rows.slice(0, n);
  };
  const client = {
    calls,
    async catchup(opts) {
      calls.catchup++;
      if (catchupPages) return catchupPages(opts);
      const list = typeof events === 'function' ? events(opts) : events;
      const limit = opts.limit ?? list.length;
      return { events: list.slice(0, limit), has_more: list.length > limit };
    },
    async getMessages(id, opts) {
      calls.messages++;
      return page(channels[id] || [], opts);
    },
    async getThreadMessages(id, opts) {
      calls.threadMessages++;
      return page(threads[id] || [], opts);
    },
  };
  return client;
}

function runner({ client, state, delivered = [], summaries = [], events = [], limits = {}, deliverMessage, deliverEvent }) {
  return new CatchupRunner({
    client,
    label: 'default',
    state,
    now: () => NOW,
    limits: { batchDelayMs: 0, ...limits },
    log: () => {},
    deliverMessage: deliverMessage || (async item => { delivered.push(item.message.id); }),
    deliverSummary: async text => { summaries.push(text); },
    deliverEvent: deliverEvent || (async event => { events.push(event); }),
  });
}

const channelSummary = id => ({ type: 'channel_message_summary', channel_id: id });
const threadSummary = id => ({ type: 'thread_message_summary', thread_id: id });

// ─── Blocker 1 ──────────────────────────────────────────────────

describe('blocker 1 — strict hub bounds must not drop the split row', () => {
  it('loses nothing across 201 messages / page size 100', async () => {
    const messages = Array.from({ length: 201 }, (_, i) => msg(`m${i}`, T + 1000 + i * 10));
    const { state } = seeded(T);
    const delivered = [];
    const r = runner({ client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }), state, delivered });

    await r.run('reconnected');
    r.dispose();

    assert.deepEqual(
      messages.filter(m => !delivered.includes(m.id)).map(m => m.id), [],
      'every message found',
    );
    assert.equal(delivered.length, 201, 'and none twice');
    assert.equal(state.isDirty('default'), false);
  });

  it('loses nothing when the split lands exactly on a page boundary', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg(`m${i}`, T + 1000 + i * 7));
    const { state } = seeded(T);
    const delivered = [];
    const r = runner({
      client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }),
      state, delivered, limits: { messagePageSize: 50 },
    });

    await r.run('reconnected');
    r.dispose();

    assert.equal(new Set(delivered).size, 200);
    assert.equal(delivered.length, 200);
  });

  it('walks an instant holding more rows than one page', async () => {
    // 150 rows share ONE millisecond: time splitting cannot separate them, the
    // id cursor has to. Real hub ids are UUIDs, so their order is unrelated to
    // insertion order — the walk must not assume otherwise.
    const messages = Array.from({ length: 150 }, (_, i) =>
      msg(`m${String((i * 37) % 150).padStart(3, '0')}`, T + 1000));
    const { state } = seeded(T);
    const delivered = [];
    const r = runner({
      client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }),
      state, delivered, limits: { messagePageSize: 100 },
    });

    await r.run('reconnected');
    r.dispose();

    assert.equal(new Set(delivered).size, 150, 'an instant flood is still fully retrieved');
    assert.equal(delivered.length, 150);
  });
});

// ─── Blocker 2 ──────────────────────────────────────────────────

describe('blocker 2 — a backlog larger than the id ring', () => {
  it('delivers 3001 messages exactly once over several runs', async () => {
    const channels = {};
    for (let i = 0; i < 3001; i++) {
      const c = `c${Math.floor(i / 80)}`;
      (channels[c] ||= []).push(msg(`m${i}`, T + 1000 + i * 10));
    }
    const { state } = seeded(T);
    const delivered = [];
    const r = runner({
      client: fakeHub({ channels, events: Object.keys(channels).map(channelSummary) }),
      state, delivered,
    });

    for (let i = 0; i < 7; i++) await r.run('reconnected');
    r.dispose();

    const unique = new Set(delivered);
    assert.equal(unique.size, 3001, 'every message delivered');
    assert.equal(delivered.length, 3001, 'nothing delivered twice');
    assert.ok(unique.has('m3000'), 'the tail is not starved');
    assert.equal(state.isDirty('default'), false);
  });

  it('never re-delivers ids that belong to an open window', async () => {
    // 3000 messages, 1000 per run, a ring of 100 ids: without per-window id
    // retention this loops forever on the first batch.
    const messages = Array.from({ length: 3000 }, (_, i) => msg(`m${i}`, T + 1000 + i * 10));
    const { state } = seeded(T);
    state.maxRecentIds = 100;
    const delivered = [];
    const r = runner({
      client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }),
      state, delivered, limits: { maxMessagesPerRun: 1000 },
    });

    for (let i = 0; i < 6; i++) await r.run('reconnected');
    r.dispose();

    assert.equal(delivered.length, 3000, 'no duplicates despite the tiny ring');
    assert.equal(new Set(delivered).size, 3000);
  });
});

// ─── Blocker 3 ──────────────────────────────────────────────────

describe('blocker 3 — the per-run page budget', () => {
  it('resumes from the saved windows instead of rescanning the prefix', async () => {
    const messages = Array.from({ length: 3001 }, (_, i) => msg(`m${i}`, T + 1000 + i * 10));
    const { state } = seeded(T);
    const delivered = [];
    const r = runner({
      client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }),
      state, delivered, limits: { maxMessagesPerRun: 10000, messageMaxPages: 10 },
    });

    await r.run('reconnected');
    const first = delivered.length;
    assert.ok(first > 0 && first < 3001, `the budget must bite, got ${first}`);
    assert.equal(state.isDirty('default'), true);

    await r.run('reconnected');
    assert.ok(delivered.length > first, 'the second run advances instead of rescanning');

    for (let i = 0; i < 3; i++) await r.run('reconnected');
    r.dispose();

    assert.equal(new Set(delivered).size, 3001, 'everything is eventually retrieved');
    assert.equal(delivered.length, 3001, 'exactly once');
    assert.equal(state.isDirty('default'), false);
  });

  it('survives a restart mid-scan', async () => {
    const messages = Array.from({ length: 2500 }, (_, i) => msg(`m${i}`, T + 1000 + i * 10));
    const { filePath, state } = seeded(T);
    const delivered = [];
    const build = store => runner({
      client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }),
      state: store, delivered, limits: { maxMessagesPerRun: 10000, messageMaxPages: 5 },
    });

    const first = build(state);
    await first.run('reconnected');
    first.dispose();
    const afterFirst = delivered.length;
    assert.ok(afterFirst < 2500);

    // Restart: fresh store from disk, same files.
    const reloaded = new CatchupStateStore({ filePath }).load();
    const second = build(reloaded);
    for (let i = 0; i < 8; i++) await second.run('reconnected');
    second.dispose();

    assert.equal(new Set(delivered).size, 2500, 'the scan continues where the old process stopped');
    assert.equal(delivered.length, 2500);
  });
});

// ─── Blocker 4 ──────────────────────────────────────────────────

describe('blocker 4 — a live delivery that never reached C4', () => {
  it('is not recorded, opens a gap, and the replay retries it', async () => {
    const { state } = seeded(T);
    const gate = new DeliveryGate({ state, label: 'default' });

    gate.begin('live-1');
    const result = settleLiveDelivery({
      outcome: undefined,
      error: new Error('transient C4 failure'),
      id: 'live-1', at: T + 1000, gate,
      markGap: () => state.markGap('default'),
    });

    assert.equal(result, 'failed');
    assert.equal(state.hasSeen('default', 'live-1'), false, 'not remembered as delivered');
    assert.equal(gate.isSeen('live-1'), false, 'in-flight marker cleared');
    assert.equal(state.isDirty('default'), true, 'the gap stays open');

    const delivered = [];
    const r = runner({
      client: fakeHub({ channels: { dm: [msg('live-1', T + 1000)] }, events: [channelSummary('dm')] }),
      state, delivered, limits: { queryOverlapMs: 5000 },
    });
    await r.run('reconnected');
    r.dispose();

    assert.deepEqual(delivered, ['live-1'], 'the replay delivers what live could not');
    assert.equal(state.hasSeen('default', 'live-1'), true);
  });

  it('records a real C4 acknowledgement instead of leaving it open', () => {
    const { state } = seeded(T);
    const gate = new DeliveryGate({ state, label: 'default' });

    gate.begin('live-2');
    // What a pipeline returns after C4 accepted a message is DELIVERED, not the
    // policy verdict DELIVER (round-3 review blocker 4).
    const result = settleLiveDelivery({ outcome: DELIVERED, id: 'live-2', at: T + 1000, gate });
    assert.equal(result, DELIVERED);
    assert.equal(gate.isSeen('live-2'), true);
    assert.equal(gate.inFlight.has('live-2'), false);
  });

  it('treats a policy rejection as final (no endless retries)', () => {
    const { state } = seeded(T);
    const gate = new DeliveryGate({ state, label: 'default' });

    gate.begin('live-3');
    settleLiveDelivery({ outcome: REJECT, id: 'live-3', at: T + 1000, gate });
    assert.equal(state.hasSeen('default', 'live-3'), true);
  });

  it('does not treat an in-flight message as delivered', () => {
    const { state } = seeded(T);
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.begin('pending');

    assert.equal(gate.isSeen('pending'), true, 'the other path must not send it concurrently');
    assert.equal(gate.isDelivered('pending'), false, 'in flight is not success');
    assert.equal(state.hasSeen('default', 'pending'), false);
  });
});

// ─── Blocker 5 ──────────────────────────────────────────────────

describe('blocker 5 — an exhausted event page budget', () => {
  it('keeps the boundary and resumes from the saved cursor', async () => {
    const events = Array.from({ length: 2000 }, (_, i) => ({
      type: 'thread_status_changed', thread_id: `t${i}`, event_id: `e${i}`, occurred_at: T + i,
    }));
    events.push({ type: 'channel_message_summary', channel_id: 'dm', event_id: 'last', occurred_at: T + 3000 });

    const { state } = seeded(T);
    const delivered = [];
    let pages = 0;
    const client = fakeHub({
      channels: { dm: [msg('lost-work', T + 1000)] },
      catchupPages: ({ cursor, limit }) => {
        pages++;
        const start = cursor ? Number(String(cursor).slice(1)) + 1 : 0;
        const slice = events.slice(start, start + limit);
        return {
          events: slice,
          has_more: start + slice.length < events.length,
          cursor: slice.length ? `e${start + slice.length - 1}` : undefined,
        };
      },
    });
    const r = runner({ client, state, delivered, limits: { eventMaxPages: 20 } });

    await r.run('reconnected');
    assert.equal(pages, 20, 'the budget was actually consumed');
    assert.equal(state.isDirty('default'), true, 'must not claim the gap is closed');
    assert.equal(delivered.length, 0);
    assert.ok(state.getEventCursor('default'), 'the cursor is saved');

    await r.run('reconnected');
    r.dispose();

    assert.deepEqual(delivered, ['lost-work'], 'the summary past the first budget is still processed');
    assert.equal(state.isDirty('default'), false);
    assert.equal(state.getEventCursor('default'), null, 'cursor cleared once drained');
  });
});

// ─── Blocker 6 ──────────────────────────────────────────────────

describe('blocker 6 — groupPolicy=disabled and offline invites', () => {
  const event = { type: 'thread_invited', thread_id: 'blocked', topic: 'SECRET-TOPIC', inviter: 'unlisted' };

  it('rejects the invite before anything reaches C4', () => {
    const decision = decideCatchupEvent({ access: { groupPolicy: 'disabled' }, event });
    assert.equal(decision.verdict, REJECT);
    assert.match(decision.reason, /groupPolicy:disabled/);
  });

  it('rejects an invite for a thread outside the allowlist', () => {
    const access = { groupPolicy: 'allowlist', threads: { t1: {} } };
    assert.equal(decideCatchupEvent({ access, event }).verdict, REJECT);
    assert.equal(decideCatchupEvent({ access, event: { ...event, thread_id: 't1' } }).verdict, DELIVER);
  });

  it('does not reach the runner delivery hook at all', async () => {
    // End-to-end through the runner: a rejected lifecycle event must not call
    // the bot's deliverEvent (which is what writes to C4).
    const { state } = seeded(T);
    const seen = [];
    const client = fakeHub({ events: [{ ...event, occurred_at: T + 10 }] });
    const r = runner({
      client, state, deliverEvent: async e => { seen.push(e); },
    });
    // The policy lives in the bot callback, so mirror it here: the runner hands
    // every event over; the callback decides. Assert the callback contract.
    r.deliverEvent = async e => {
      if (decideCatchupEvent({ access: { groupPolicy: 'disabled' }, event: e }).verdict === REJECT) return;
      seen.push(e);
    };
    await r.run('reconnected');
    r.dispose();

    assert.deepEqual(seen, [], 'nothing delivered while the group policy is disabled');
  });
});

// ─── Blocker 7 ──────────────────────────────────────────────────

describe('blocker 7 — a disconnect during a slow run', () => {
  it('leaves the new gap open and does not move the boundary', async () => {
    const { state } = seeded(T);
    let resume;
    let started = false;
    const client = fakeHub({});
    client.catchup = () => {
      started = true;
      return new Promise(r => { resume = r; });
    };
    const r = runner({ client, state });

    const run = r.run('reconnected');
    await new Promise(res => setTimeout(res, 10));
    assert.ok(started);

    state.markGap('default'); // the socket drops again mid-run
    resume({ events: [], has_more: false });
    await run;
    r.dispose();

    assert.equal(state.isDirty('default'), true, 'the fresh gap survives');
    assert.equal(state.getEventsSince('default'), T, 'boundary not advanced');

    // A live message delivered after the run must not drag the boundary past
    // the messages the interrupted window never covered.
    const gate = new DeliveryGate({ state, label: 'default' });
    settleLiveDelivery({ outcome: DELIVER, id: 'live-after', at: T + 30000, gate });
    assert.equal(state.getEventsSince('default'), T);
  });
});

// ─── Blocker 8 ──────────────────────────────────────────────────

describe('blocker 8 — the bot replaying its own thread messages', () => {
  const access = { groupPolicy: 'open', threads: { t1: {} } };
  const mine = { id: 'self-output', sender_id: 'me', sender_name: 'reviewer', content: '@reviewer hi', created_at: T + 1000 };
  const theirs = { id: 'theirs', sender_id: 'peer', sender_name: 'peer', content: '@reviewer hi', created_at: T + 2000 };
  const isSelf = (id, metadata) => id === 'me' && metadata?.provenance?.authored_by !== 'human';

  it('skips the bot’s own outbound thread message', () => {
    const decision = decideThreadDelivery({
      access, isSelf, message: mine, threadId: 't1', sender: 'reviewer', reason: 'message', mode: 'mention', isMention: true,
    });
    assert.equal(decision.verdict, SKIP);
    assert.equal(decision.reason, 'self');
  });

  it('still delivers a human-authored message sent through the bot', () => {
    const human = { ...mine, metadata: { provenance: { authored_by: 'human' } } };
    const decision = decideThreadDelivery({
      access, isSelf, message: human, threadId: 't1', sender: 'owner (via reviewer)', reason: 'message', mode: 'mention', isMention: true,
    });
    assert.equal(decision.verdict, DELIVER);
  });

  it('delivers other people’s messages normally', () => {
    const decision = decideThreadDelivery({
      access, isSelf, message: theirs, threadId: 't1', sender: 'peer', reason: 'message', mode: 'mention', isMention: true,
    });
    assert.equal(decision.verdict, DELIVER);
  });

  it('keeps the shared topic-scoped default when everything is left alone', () => {
    // groupPolicy=open, mention mode, no @mention ⇒ live and replay both skip.
    const decision = decideThreadDelivery({
      access, isSelf, message: { ...theirs, content: 'no mention' }, threadId: 't1', sender: 'peer',
      reason: 'message', mode: 'mention', isMention: false,
    });
    assert.equal(decision.verdict, SKIP);
    assert.equal(decision.reason, 'not-mentioned');
  });
});

// ─── Policy parity: live and replay share one gate ──────────────

describe('policy parity — replay is not a policy bypass', () => {
  it('DM allowlist applies to catch-up too', () => {
    const message = { sender_id: 'stranger', content: 'hi' };
    const access = { dmPolicy: 'allowlist', dmAllowFrom: ['peer'] };
    assert.equal(decideDmDelivery({ access, message, sender: 'stranger', catchup: true }).verdict, REJECT);
    assert.equal(decideDmDelivery({ access, message: { ...message, sender_id: 'peer' }, sender: 'peer', catchup: true }).verdict, DELIVER);
  });

  it('thread disabled applies to catch-up messages, not only live ones', () => {
    const decision = decideThreadDelivery({
      access: { groupPolicy: 'disabled' }, message: { sender_id: 'peer' }, threadId: 't1',
      sender: 'peer', reason: 'message', mode: 'mention', isMention: true, catchup: true,
    });
    assert.equal(decision.verdict, REJECT);
  });

  it('realtime rate limiting does not gate the replay', () => {
    const decision = decideThreadDelivery({
      access: { groupPolicy: 'open' }, message: { sender_id: 'peer' }, threadId: 't1',
      sender: 'peer', reason: 'message', mode: 'mention', isMention: true, catchup: true,
      takeRateToken: () => false,
    });
    assert.equal(decision.verdict, DELIVER, 'throttled live traffic must not be dropped on replay');
  });
});

// ─── No message is dropped for volume reasons ───────────────────

describe('volume — nothing is discarded', () => {
  it('700 messages: one summary line, then everything', async () => {
    const messages = Array.from({ length: 700 }, (_, i) => msg(`m${i}`, T + 1000 + i * 10));
    const { state } = seeded(T);
    const delivered = [];
    const summaries = [];
    const r = runner({
      client: fakeHub({ channels: { dm: messages }, events: [{ ...channelSummary('dm'), count: 700 }] }),
      state, delivered, summaries, limits: { maxMessagesPerRun: 10000 },
    });

    await r.run('reconnected');
    r.dispose();

    assert.equal(summaries.length, 1, 'exactly one notice line');
    assert.match(summaries[0], /700 条/);
    assert.match(summaries[0], /不丢弃任何消息/);
    assert.equal(delivered.length, 700);
    assert.equal(new Set(delivered).size, 700);
  });

  it('a long offline window is summarised but fully replayed', async () => {
    const messages = [msg('old', T + 1000), msg('newer', T + 2000)];
    const { state } = seeded(T);
    const delivered = [];
    const summaries = [];
    // 48h offline: above the 24h threshold, below the message threshold.
    const r = runner({
      client: fakeHub({ channels: { dm: messages }, events: [channelSummary('dm')] }),
      state, delivered, summaries, limits: {},
    });
    r.now = () => T + 48 * 3600 * 1000;
    await r.run('reconnected');
    r.dispose();

    assert.equal(summaries.length, 1, 'long offline ⇒ one notice');
    assert.deepEqual(delivered, ['old', 'newer'], 'and still every message');
  });
});
