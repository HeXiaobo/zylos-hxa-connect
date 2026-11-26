/**
 * Tests for the 2026-11-26 catch-up fixes on the 1.7.14-3ai line (Issue #50):
 *   1. Online live delivery advances `eventsSince` when clean (and holds back during gaps / in-flight).
 *   2. Dedup-bucket expiry never causes replay; new targets scan from cursor (never [1, hi]).
 *   3. Restart dual gates (`HXA_CATCHUP_MAX_AGE_MIN`, default 30m):
 *      - Gate 1 (message): only deliver messages >= max(eventsSince, processStartedAt - N min);
 *        older messages are persisted as `not_delivered` (distinguishable from `delivered`) and never enter C4/Agent.
 *      - Gate 2 (cursor): missing or stale cursor advances directly to `now` without replaying history.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CatchupRunner,
  DeliveryGate,
  DEFAULT_CATCHUP_MAX_AGE_MIN,
  resolveCatchupMaxAgeMs,
} from '../src/lib/catchup.js';
import { CatchupStateStore } from '../src/lib/catchup-state.js';
import { settleLiveDelivery, DELIVERED, REJECT, SKIP } from '../src/lib/delivery.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BASE_NOW = 1_800_000_000_000;

function tmpFile(prefix, name = 'catchup-state.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), name);
}

const mkMsg = (id, at, channelId = 'dm-1') => ({
  id,
  channel_id: channelId,
  sender_id: 'peer',
  sender_name: 'peer',
  content: `body-${id}`,
  content_type: 'text',
  parts: [],
  created_at: at,
});

function fakeHub({ channels = {}, threads = {}, events = [] } = {}) {
  const calls = { catchup: [], messages: [], threadMessages: [] };
  const page = (all, opts) => {
    const limit = opts.limit ?? all.length;
    if (typeof opts.before === 'string') {
      const sorted = all.slice().sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(String(a.id)));
      const anchor = all.find(m => m.id === opts.before);
      const rows = anchor
        ? sorted.filter(m => m.created_at < anchor.created_at
          || (m.created_at === anchor.created_at && String(m.id) < String(anchor.id)))
        : sorted;
      return { messages: rows.slice(0, limit), has_more: rows.length > limit };
    }
    const lo = opts.since ?? -Infinity;
    const hi = opts.before ?? Infinity;
    return all
      .filter(m => m.created_at > lo && m.created_at < hi)
      .sort((a, b) => b.created_at - a.created_at || String(b.id).localeCompare(String(a.id)))
      .slice(0, limit);
  };
  return {
    calls,
    async catchup(opts) {
      calls.catchup.push(opts);
      const list = typeof events === 'function' ? events(opts) : events;
      return { events: list, has_more: false };
    },
    async getMessages(id, opts) {
      calls.messages.push({ id, opts });
      return page(channels[id] || [], opts);
    },
    async getThreadMessages(id, opts) {
      calls.threadMessages.push({ id, opts });
      return page(threads[id] || [], opts);
    },
  };
}

// ─── 1 · Online delivery advances eventsSince ───────────────────

describe('1. online delivery advances eventsSince cursor', () => {
  it('advances eventsSince on clean live DeliveryGate.mark() and persists across reload', () => {
    const filePath = tmpFile('hxa-cursor-live-');
    const state = new CatchupStateStore({ filePath }).load();
    state.setEventsSince('org-2', BASE_NOW - 4 * DAY);
    assert.equal(state.isDirty('org-2'), false);

    const gate = new DeliveryGate({ state, label: 'org-2' });
    const msgAt = BASE_NOW - 2 * MIN;
    gate.begin('live-1');
    const res = settleLiveDelivery({
      outcome: DELIVERED,
      id: 'live-1',
      at: msgAt,
      gate,
      save: () => state.save(),
    });

    assert.equal(res, DELIVERED);
    assert.equal(state.getEventsSince('org-2'), msgAt, 'eventsSince must advance to live message timestamp');
    assert.equal(state.getLastDeliveredAt('org-2'), msgAt);

    // Monotonicity: an older message must never move eventsSince backwards.
    gate.mark('live-older', msgAt - 30_000);
    assert.equal(state.getEventsSince('org-2'), msgAt);

    // Persisted to disk.
    state.save();
    const reloaded = new CatchupStateStore({ filePath }).load();
    assert.equal(reloaded.getEventsSince('org-2'), msgAt);
    assert.equal(reloaded.getMessageStatus('org-2', 'live-1'), 'delivered');
  });

  it('does NOT advance eventsSince while a gap is open, during catch-up, or while an earlier live delivery is in flight', () => {
    const filePath = tmpFile('hxa-cursor-hold-');
    const state = new CatchupStateStore({ filePath }).load();
    const T0 = BASE_NOW - 10 * MIN;
    state.setEventsSince('org-2', T0);
    const gate = new DeliveryGate({ state, label: 'org-2' });

    // Case A: concurrent live deliveries A (T0+1s) and B (T0+5s); B finishes before A.
    gate.begin('live-A');
    gate.begin('live-B');
    gate.mark('live-B', T0 + 5_000);
    assert.equal(state.getEventsSince('org-2'), T0, 'must hold cursor while live-A is still in flight');

    // If A succeeds next, cursor advances to the max settled timestamp (T0+5s).
    gate.mark('live-A', T0 + 1_000);
    assert.equal(state.getEventsSince('org-2'), T0 + 5_000);

    // Case B: concurrent live deliveries C (T0+10s) and D (T0+20s); D succeeds, then C fails.
    gate.begin('live-C');
    gate.begin('live-D');
    gate.mark('live-D', T0 + 20_000);
    assert.equal(state.getEventsSince('org-2'), T0 + 5_000);
    settleLiveDelivery({
      error: new Error('C4 transient error'),
      id: 'live-C',
      at: T0 + 10_000,
      gate,
      markGap: () => state.markGap('org-2'),
    });
    assert.equal(state.isDirty('org-2'), true);
    assert.equal(state.getEventsSince('org-2'), T0 + 5_000, 'failed C must prevent jumping to D');

    // Case C: another live message while dirty must still not move eventsSince over the open gap.
    gate.mark('live-E', T0 + 30_000);
    assert.equal(state.getEventsSince('org-2'), T0 + 5_000);

    // Case D: explicit advanceCursor=false or catch-up target mark never advances eventsSince even when clean.
    state.settleGap('org-2', state.getGapEpoch('org-2'));
    settleLiveDelivery({
      outcome: REJECT,
      id: 'catchup-reject',
      at: T0 + 40_000,
      gate,
      advanceCursor: false,
    });
    assert.equal(state.getEventsSince('org-2'), T0 + 5_000);
    gate.mark('catchup-1', T0 + 50_000, { kind: 'channel', targetId: 'dm-1' });
    assert.equal(state.getEventsSince('org-2'), T0 + 5_000);

    // Case E: SKIP clears in-flight without advancing.
    gate.begin('skip-1');
    settleLiveDelivery({ outcome: SKIP, id: 'skip-1', at: T0 + 60_000, gate });
    assert.equal(state.getEventsSince('org-2'), T0 + 5_000);
  });
});

// ─── 2 · Dedup bucket expiry cannot cause replay; new targets never full-scan ──

describe('2. no full-history scan on new targets and no replay after dedup expiry', () => {
  it('new target after pruneTargets scans from cursor, never [1, hi], even when 48h dedup buckets are empty', async () => {
    const filePath = tmpFile('hxa-new-target-');
    const state = new CatchupStateStore({ filePath }).load();
    const cursorAt = BASE_NOW - 5 * MIN;
    state.setEventsSince('customer', cursorAt);
    state.markGap('customer');
    state.pruneTargets('customer');
    assert.deepEqual(state.getOrg('customer').targets, {});
    assert.deepEqual(state.getOrg('customer').delivered, {});
    assert.deepEqual(state.getOrg('customer').recentIds, []);

    // Direct extendTarget check: must NOT start at 1.
    const probeState = new CatchupStateStore({ filePath: tmpFile('hxa-extend-probe-') }).load();
    probeState.setEventsSince('customer', cursorAt);
    const target = probeState.extendTarget('customer', 'channel', 'dm-peer-a', BASE_NOW);
    assert.equal(target.windows.length, 1);
    assert.equal(target.windows[0][0], cursorAt, 'new target window must start at eventsSince, not 1');
    assert.equal(target.windows[0][1], BASE_NOW);

    // End-to-end CatchupRunner check: 4-day-old history + 1 new message from 2 min ago.
    const historical = Array.from({ length: 50 }, (_, i) =>
      mkMsg(`hist-${i}`, BASE_NOW - 4 * DAY + i * MIN, 'dm-peer-a'));
    const fresh = mkMsg('fresh-1', BASE_NOW - 2 * MIN, 'dm-peer-a');

    const client = fakeHub({
      channels: { 'dm-peer-a': [...historical, fresh] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm-peer-a', occurred_at: fresh.created_at }],
    });

    const delivered = [];
    const runner = new CatchupRunner({
      client,
      state,
      label: 'customer',
      now: () => BASE_NOW,
      processStartedAt: BASE_NOW,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['fresh-1'], 'only the post-cursor message is delivered');
    assert.ok(client.calls.messages.length >= 1, 'must query the channel');
    for (const call of client.calls.messages) {
      assert.ok(
        call.opts.since >= cursorAt - 1,
        `new target must never query from timestamp 0/1; got since=${call.opts.since} (cursor=${cursorAt})`,
      );
    }
  });

  it('does not replay pre-cursor or stale messages even when dedup buckets are empty and an old window returns them', async () => {
    const filePath = tmpFile('hxa-expired-bucket-');
    const state = new CatchupStateStore({ filePath }).load();
    const cursorAt = BASE_NOW - 5 * MIN; // within 30m window
    state.setEventsSince('customer', cursorAt);
    state.markGap('customer');
    state.extendTarget('customer', 'channel', 'dm-1', BASE_NOW, BASE_NOW - 2 * HOUR);

    const staleOld = mkMsg('stale-90m', BASE_NOW - 90 * MIN, 'dm-1');      // < cutoffAt (30m)
    const preCursor = mkMsg('pre-cursor-15m', BASE_NOW - 15 * MIN, 'dm-1'); // >= cutoffAt, but < eventsSince (5m)
    const validNew = mkMsg('valid-2m', BASE_NOW - 2 * MIN, 'dm-1');         // >= eventsSince AND >= cutoffAt

    const client = fakeHub({
      channels: { 'dm-1': [staleOld, preCursor, validNew] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm-1', occurred_at: validNew.created_at }],
    });

    const delivered = [];
    const summaries = [];
    const logs = [];
    const runner = new CatchupRunner({
      client,
      state,
      label: 'customer',
      now: () => BASE_NOW,
      processStartedAt: BASE_NOW,
      limits: { batchDelayMs: 0 },
      log: m => logs.push(m),
      deliverMessage: async ({ message }) => delivered.push(message.id),
      deliverSummary: async text => summaries.push(text),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['valid-2m'], 'neither stale nor pre-cursor message may be replayed');
    assert.equal(summaries.length, 0);
    assert.equal(runner.lastRun.suppressed, 2);

    // Reload from disk: persisted statuses are strictly distinguishable.
    const reloaded = new CatchupStateStore({ filePath }).load();
    assert.equal(reloaded.getMessageStatus('customer', 'valid-2m'), 'delivered');
    assert.equal(reloaded.getMessageStatus('customer', 'stale-90m'), 'not_delivered');
    assert.equal(reloaded.getMessageStatus('customer', 'pre-cursor-15m'), 'not_delivered');
    assert.equal(reloaded.isSuppressed('customer', 'stale-90m'), true);
    assert.equal(reloaded.isSuppressed('customer', 'pre-cursor-15m'), true);
    assert.equal(reloaded.isSuppressed('customer', 'valid-2m'), false);
    assert.equal(reloaded.getSuppressedRecord('customer', 'stale-90m').reason, 'stale_cutoff');
    assert.equal(reloaded.getSuppressedRecord('customer', 'pre-cursor-15m').reason, 'before_cursor');
    assert.equal(reloaded.getOrg('customer').recentIds.includes('stale-90m'), false, 'suppressed id must not be in recentIds');
    assert.equal(reloaded.getOrg('customer').recentIds.includes('pre-cursor-15m'), false);
    assert.match(logs.join('\n'), /non-deliverable messages suppressed: count=2/);
  });

  it('enforces cursor and time gates on the byId id-cursor scan branch too', async () => {
    const filePath = tmpFile('hxa-byid-gate-');
    const state = new CatchupStateStore({ filePath }).load();
    const cursorAt = BASE_NOW - 5 * MIN;
    state.setEventsSince('customer', cursorAt);
    state.markGap('customer');
    state.extendTarget('customer', 'channel', 'dm-1', BASE_NOW, BASE_NOW - 2 * HOUR);
    state.useIdScan('customer', 'channel', 'dm-1', null, 0);

    const staleOld = mkMsg('byid-stale', BASE_NOW - 60 * MIN, 'dm-1');
    const preCursor = mkMsg('byid-pre', BASE_NOW - 10 * MIN, 'dm-1');
    const fresh = mkMsg('byid-fresh', BASE_NOW - 1 * MIN, 'dm-1');

    const client = fakeHub({
      channels: { 'dm-1': [staleOld, preCursor, fresh] },
      events: [],
    });

    const delivered = [];
    const runner = new CatchupRunner({
      client,
      state,
      label: 'customer',
      now: () => BASE_NOW,
      processStartedAt: BASE_NOW,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['byid-fresh']);
    assert.equal(state.getMessageStatus('customer', 'byid-stale'), 'not_delivered');
    assert.equal(state.getMessageStatus('customer', 'byid-pre'), 'not_delivered');
    assert.equal(state.getMessageStatus('customer', 'byid-fresh'), 'delivered');
  });
});

// ─── 3 · Restart dual gates (Adai 4-day replay reproduction & short reconnects) ─

describe('3. restart dual gates (Gate 1 message cutoff + Gate 2 cursor cutoff)', () => {
  it('reproduces the Adai 11-26 incident (4-day-old cursor + 210 historical DMs) → 0 deliveries', async () => {
    const filePath = tmpFile('hxa-adai-repro-');
    const state = new CatchupStateStore({ filePath }).load();
    // 101.8 hours (~4.24 days) stale cursor + leftover open target + empty 48h dedup buckets.
    const fourDaysAgo = BASE_NOW - Math.floor(101.8 * HOUR);
    state.setEventsSince('customer-org', fourDaysAgo);
    state.setEventCursor('customer-org', 'stale-cursor-token');
    state.extendTarget('customer-org', 'channel', 'dm-peer-a', BASE_NOW - 3 * DAY, BASE_NOW - 21 * DAY);
    state.markGap('customer-org');
    state.save();

    const make210 = (prefix, count, ch) => Array.from({ length: count }, (_, i) =>
      mkMsg(`${prefix}-${i}`, BASE_NOW - 20 * DAY + i * 2 * HOUR, ch));

    const client = fakeHub({
      channels: {
        'dm-peer-a': make210('pa', 70, 'dm-peer-a'),
        'dm-peer-b': make210('pb', 70, 'dm-peer-b'),
        'dm-peer-c': make210('pc', 70, 'dm-peer-c'),
      },
      events: [
        { type: 'channel_message_summary', channel_id: 'dm-peer-a', count: 70, occurred_at: BASE_NOW - 2 * DAY },
        { type: 'channel_message_summary', channel_id: 'dm-peer-b', count: 70, occurred_at: BASE_NOW - 2 * DAY },
        { type: 'channel_message_summary', channel_id: 'dm-peer-c', count: 70, occurred_at: BASE_NOW - 2 * DAY },
      ],
    });

    const delivered = [];
    const summaries = [];
    const logs = [];
    const runner = new CatchupRunner({
      client,
      state,
      label: 'customer-org',
      now: () => BASE_NOW,
      processStartedAt: BASE_NOW,
      limits: { batchDelayMs: 0 },
      log: m => logs.push(m),
      deliverMessage: async ({ message }) => delivered.push(message.id),
      deliverSummary: async text => summaries.push(text),
    });

    await runner.run('connected');
    runner.dispose();

    assert.equal(delivered.length, 0, 'zero historical messages may be delivered to Agent');
    assert.equal(summaries.length, 0, 'no summary spam on stale cursor reset');
    assert.equal(client.calls.catchup.length, 0, 'Gate 2 must skip Hub catchup() altogether');
    assert.equal(client.calls.messages.length, 0, 'Gate 2 must skip Hub getMessages() altogether');
    assert.equal(runner.lastRun.skipped, 'stale_cursor');
    assert.equal(state.getEventsSince('customer-org'), BASE_NOW, 'cursor must advance directly to now');
    assert.equal(state.getEventCursor('customer-org'), null);
    assert.deepEqual(state.getOrg('customer-org').targets, {}, 'leftover targets must be cleared');
    assert.equal(state.isDirty('customer-org'), false);
    assert.match(logs.join('\n'), /catchup cursor too old/);
  });

  it('Gate 2: missing cursor baselines to now and clears any stray targets without replaying', async () => {
    const filePath = tmpFile('hxa-missing-cursor-');
    const state = new CatchupStateStore({ filePath }).load();
    state.extendTarget('org-2', 'channel', 'dm-1', BASE_NOW - 10 * MIN, BASE_NOW - 2 * HOUR);

    const client = fakeHub({
      channels: { 'dm-1': [mkMsg('old-1', BASE_NOW - 1 * HOUR)] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm-1', occurred_at: BASE_NOW - 1 * HOUR }],
    });

    const delivered = [];
    const runner = new CatchupRunner({
      client,
      state,
      label: 'org-2',
      now: () => BASE_NOW,
      processStartedAt: BASE_NOW,
      limits: { batchDelayMs: 0 },
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('connected');
    runner.dispose();

    assert.equal(delivered.length, 0);
    assert.equal(client.calls.catchup.length, 0);
    assert.equal(state.getEventsSince('org-2'), BASE_NOW);
    assert.deepEqual(state.getOrg('org-2').targets, {});
    assert.equal(runner.lastRun.skipped, 'baseline');
  });

  it('normal short disconnect (5 minutes) still catches up and delivers every missed message', async () => {
    const filePath = tmpFile('hxa-short-disconnect-');
    const state = new CatchupStateStore({ filePath }).load();
    const fiveMinAgo = BASE_NOW - 5 * MIN;
    state.setEventsSince('org-2', fiveMinAgo);
    state.markGap('org-2');

    const missed = [
      mkMsg('m1', fiveMinAgo + 1 * MIN, 'dm-internal'),
      mkMsg('m2', fiveMinAgo + 2 * MIN, 'dm-internal'),
      mkMsg('m3', fiveMinAgo + 4 * MIN, 'dm-internal'),
    ];
    const client = fakeHub({
      channels: { 'dm-internal': missed },
      events: [{ type: 'channel_message_summary', channel_id: 'dm-internal', count: 3, occurred_at: missed[2].created_at }],
    });

    const delivered = [];
    const runner = new CatchupRunner({
      client,
      state,
      label: 'org-2',
      now: () => BASE_NOW,
      processStartedAt: BASE_NOW,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['m1', 'm2', 'm3']);
    assert.equal(state.isDirty('org-2'), false);
    assert.equal(state.getEventsSince('org-2'), missed[2].created_at);
  });

  it('long-running process (2h uptime) with online cursor advancement catches up normally after a 5m disconnect', async () => {
    const filePath = tmpFile('hxa-long-lived-');
    const state = new CatchupStateStore({ filePath }).load();
    const startedAt = BASE_NOW - 2 * HOUR;
    state.setEventsSince('org-2', startedAt);

    // Live traffic over 2 hours advances eventsSince via DeliveryGate.mark().
    const gate = new DeliveryGate({ state, label: 'org-2' });
    const lastLiveAt = BASE_NOW - 5 * MIN;
    gate.mark('live-latest', lastLiveAt);
    assert.equal(state.getEventsSince('org-2'), lastLiveAt);

    // Brief disconnect for 5 minutes.
    state.markGap('org-2');
    const missed = mkMsg('missed-after-2h', BASE_NOW - 2 * MIN, 'dm-internal');
    const client = fakeHub({
      channels: { 'dm-internal': [missed] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm-internal', occurred_at: missed.created_at }],
    });

    const delivered = [];
    const runner = new CatchupRunner({
      client,
      state,
      gate,
      label: 'org-2',
      now: () => BASE_NOW,
      processStartedAt: startedAt,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['missed-after-2h']);
    assert.equal(state.isDirty('org-2'), false);
  });

  it('suppresses stale lifecycle events older than cutoff without delivering to C4', async () => {
    const filePath = tmpFile('hxa-lifecycle-gate-');
    const state = new CatchupStateStore({ filePath }).load();
    const cursorAt = BASE_NOW - 10 * MIN;
    state.setEventsSince('org-2', cursorAt);
    state.markGap('org-2');

    const client = fakeHub({
      events: [
        { type: 'thread_invited', event_id: 'ev-old', thread_id: 't-old', occurred_at: BASE_NOW - 2 * HOUR },
        { type: 'thread_invited', event_id: 'ev-pre', thread_id: 't-pre', occurred_at: BASE_NOW - 15 * MIN },
        { type: 'thread_invited', event_id: 'ev-new', thread_id: 't-new', occurred_at: BASE_NOW - 2 * MIN },
      ],
    });

    const deliveredEvents = [];
    const runner = new CatchupRunner({
      client,
      state,
      label: 'org-2',
      now: () => BASE_NOW,
      processStartedAt: BASE_NOW,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async () => {},
      deliverEvent: async ev => deliveredEvents.push(ev.thread_id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(deliveredEvents, ['t-new']);
    assert.equal(state.isSuppressed('org-2', 'event:ev-old'), true);
    assert.equal(state.isSuppressed('org-2', 'event:ev-pre'), true);
  });

  it('resolveCatchupMaxAgeMs supports configurable minutes and falls back to 30m on invalid input', () => {
    const logs = [];
    assert.equal(resolveCatchupMaxAgeMs({}, m => logs.push(m)), DEFAULT_CATCHUP_MAX_AGE_MIN * MIN);
    assert.equal(resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: '10' }, m => logs.push(m)), 10 * MIN);
    assert.equal(resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: '0' }, m => logs.push(m)), 0);
    assert.equal(resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: '-5' }, m => logs.push(m)), 30 * MIN);
    assert.equal(resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: 'not-a-num' }, m => logs.push(m)), 30 * MIN);
    assert.equal(logs.length, 2, 'invalid values must emit warning logs');
  });
});
