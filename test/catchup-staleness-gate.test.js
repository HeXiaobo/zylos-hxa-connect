/**
 * Tests for the two catch-up staleness gates:
 *   Gate 1: Catch-up only delivers messages at or after (processStartedAt - maxAgeMs);
 *           older messages are persisted as handled/non-deliverable without reaching C4.
 *   Gate 2: Missing cursor or cursor older than (processStartedAt - maxAgeMs) advances
 *           directly to now without replaying history.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CatchupRunner,
  DEFAULT_CATCHUP_MAX_AGE_MIN,
  resolveCatchupMaxAgeMs,
} from '../src/lib/catchup.js';
import { CatchupStateStore } from '../src/lib/catchup-state.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const PROCESS_START = 1_800_000_000_000;

function tmpStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-catchup-gate-')), 'catchup-state.json');
}

function msg(id, at, extra = {}) {
  return {
    id,
    channel_id: 'dm',
    sender_id: 'peer',
    sender_name: 'peer',
    content: id,
    content_type: 'text',
    parts: [],
    created_at: at,
    ...extra,
  };
}

function fakeHub({ channels = {}, threads = {}, events = [] } = {}) {
  const calls = { catchup: 0, messages: 0, threadMessages: 0 };
  const page = (all, { since, before, limit }) => {
    const n = limit ?? all.length;
    if (typeof before === 'string') {
      const sorted = [...all].sort((a, b) =>
        (b.created_at - a.created_at) || String(b.id).localeCompare(String(a.id)));
      const anchor = all.find(m => m.id === before);
      const rows = anchor
        ? sorted.filter(m => (m.created_at < anchor.created_at)
          || (m.created_at === anchor.created_at && String(m.id) < String(anchor.id)))
        : sorted;
      return { messages: rows.slice(0, n), has_more: rows.length > n };
    }
    return all
      .filter(m => m.created_at > (since ?? -Infinity) && m.created_at < (before ?? Infinity))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, n);
  };
  return {
    calls,
    async catchup({ limit } = {}) {
      calls.catchup++;
      return { events: events.slice(0, limit ?? events.length), has_more: false };
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
}

describe('catchup staleness gates', () => {
  it('missing cursor sets baseline to now and does not replay history', async () => {
    const filePath = tmpStatePath();
    const state = new CatchupStateStore({ filePath }).load();
    const delivered = [];
    const logs = [];
    const client = fakeHub({
      channels: { dm: [msg('hist-1', PROCESS_START - 10 * MIN)] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: PROCESS_START - 10 * MIN }],
    });

    const runner = new CatchupRunner({
      client,
      label: 'default',
      state,
      processStartedAt: PROCESS_START,
      now: () => PROCESS_START,
      log: m => logs.push(m),
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('connected');
    runner.dispose();

    assert.equal(delivered.length, 0);
    assert.equal(client.calls.catchup, 0);
    assert.equal(state.getEventsSince('default'), PROCESS_START);
    assert.equal(runner.lastRun?.skipped, 'baseline');
    assert.ok(logs.some(l => l.includes('baseline set') && l.includes('nothing to replay')));
  });

  it('cursor 3 hours old advances to now without replaying history or calling C4', async () => {
    const filePath = tmpStatePath();
    const state = new CatchupStateStore({ filePath }).load();
    const threeHoursAgo = PROCESS_START - 3 * HOUR;
    state.setEventsSince('default', threeHoursAgo);
    state.setEventCursor('default', 'stale-cursor');
    state.extendTarget('default', 'channel', 'dm', threeHoursAgo + MIN);
    state.markGap('default');
    state.save();

    const delivered = [];
    const summaries = [];
    const logs = [];
    const client = fakeHub({
      channels: { dm: [msg('old-1', threeHoursAgo + 1000)] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: threeHoursAgo + 1000 }],
    });

    const runner = new CatchupRunner({
      client,
      label: 'default',
      state,
      processStartedAt: PROCESS_START,
      now: () => PROCESS_START,
      log: m => logs.push(m),
      deliverSummary: async text => summaries.push(text),
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('connected');
    runner.dispose();

    assert.equal(delivered.length, 0, 'no historical message may reach C4');
    assert.equal(summaries.length, 0, 'no catchup summary may be sent');
    assert.equal(client.calls.catchup, 0, 'hub catchup feed must not be queried');
    assert.equal(state.getEventsSince('default'), PROCESS_START);
    assert.equal(state.getEventCursor('default'), null);
    assert.equal(state.openTargets('default').length, 0, 'stale open targets are cleared');
    assert.equal(state.isDirty('default'), false);
    assert.equal(runner.lastRun?.skipped, 'stale_cursor');
    assert.ok(logs.some(l => l.includes('cursor too old') && l.includes('without replaying history')));

    const reloaded = new CatchupStateStore({ filePath }).load();
    assert.equal(reloaded.getEventsSince('default'), PROCESS_START);
  });

  it('cursor 5 minutes old (normal reconnect) recovers and delivers messages normally', async () => {
    const filePath = tmpStatePath();
    const state = new CatchupStateStore({ filePath }).load();
    const fiveMinAgo = PROCESS_START - 5 * MIN;
    state.setEventsSince('default', fiveMinAgo);
    state.markGap('default');
    state.save();

    const delivered = [];
    const m1 = msg('recent-1', fiveMinAgo + 10_000);
    const m2 = msg('recent-2', fiveMinAgo + 60_000);
    const client = fakeHub({
      channels: { dm: [m1, m2] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: m2.created_at }],
    });

    const runner = new CatchupRunner({
      client,
      label: 'default',
      state,
      processStartedAt: PROCESS_START,
      now: () => PROCESS_START,
      limits: { batchDelayMs: 0 },
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['recent-1', 'recent-2']);
    assert.equal(runner.lastRun?.delivered, 2);
    assert.equal(runner.lastRun?.staleDropped, 0);
    assert.equal(state.isDirty('default'), false);
  });

  it('long-running process reconnects after 2 hours and still catches up recent 5m disconnect', async () => {
    const filePath = tmpStatePath();
    const state = new CatchupStateStore({ filePath }).load();
    const twoHoursLater = PROCESS_START + 2 * HOUR;
    const fiveMinBeforeReconnect = twoHoursLater - 5 * MIN;
    state.setEventsSince('default', fiveMinBeforeReconnect);
    state.markGap('default');
    state.save();

    const delivered = [];
    const m1 = msg('mid-run-1', fiveMinBeforeReconnect + 5000);
    const client = fakeHub({
      channels: { dm: [m1] },
      events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: m1.created_at }],
    });

    const runner = new CatchupRunner({
      client,
      label: 'default',
      state,
      processStartedAt: PROCESS_START,
      now: () => twoHoursLater,
      limits: { batchDelayMs: 0 },
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['mid-run-1']);
  });

  it('Gate 1 persists out-of-window old messages as non-deliverable without calling C4 and logs summary', async () => {
    const filePath = tmpStatePath();
    const state = new CatchupStateStore({ filePath }).load();
    // Cursor itself is within 30m (10m before start), but an older pre-existing
    // scan window or returned messages contain rows older than 30m.
    const tenMinAgo = PROCESS_START - 10 * MIN;
    const twoHoursAgo = PROCESS_START - 2 * HOUR;
    const fortyMinAgo = PROCESS_START - 40 * MIN;
    const fiveMinAgo = PROCESS_START - 5 * MIN;

    state.setEventsSince('default', tenMinAgo);
    state.extendTarget('default', 'channel', 'dm', tenMinAgo);
    state.markGap('default');
    state.save();

    const old1 = msg('old-2h', twoHoursAgo);
    const old2 = msg('old-40m', fortyMinAgo);
    const fresh = msg('fresh-5m', fiveMinAgo);

    const delivered = [];
    const summaries = [];
    const deliveredEvents = [];
    const logs = [];
    const client = fakeHub({
      channels: { dm: [old1, old2, fresh] },
      events: [
        { type: 'channel_message_summary', channel_id: 'dm', occurred_at: fresh.created_at, count: 100 },
        { type: 'thread_invited', thread_id: 't-old', occurred_at: twoHoursAgo, topic: 'stale invite' },
      ],
    });

    const runner = new CatchupRunner({
      client,
      label: 'default',
      state,
      processStartedAt: PROCESS_START,
      now: () => PROCESS_START,
      limits: { batchDelayMs: 0, notifyThreshold: 50 },
      log: m => logs.push(m),
      deliverSummary: async text => summaries.push(text),
      deliverEvent: async ev => deliveredEvents.push(ev),
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['fresh-5m'], 'only in-window message is delivered to C4');
    assert.equal(deliveredEvents.length, 0, 'stale lifecycle event is not delivered to C4');
    assert.equal(runner.lastRun?.staleDropped, 3);

    // Persisted in catchup-state.json so future runs never replay them
    const reloaded = new CatchupStateStore({ filePath }).load();
    assert.equal(reloaded.hasSeen('default', 'old-2h'), true);
    assert.equal(reloaded.hasSeen('default', 'old-40m'), true);
    assert.equal(reloaded.hasSeen('default', 'fresh-5m'), true);

    const staleLog = logs.find(l => l.includes('non-deliverable stale messages'));
    assert.ok(staleLog, 'logs one summary line for dropped stale messages');
    assert.ok(staleLog.includes('count=3'));
    assert.ok(staleLog.includes(new Date(twoHoursAgo).toISOString()));
    assert.ok(staleLog.includes(new Date(fortyMinAgo).toISOString()));
  });

  it('Gate 1 also blocks stale messages when scanning via id-cursor (byId)', async () => {
    const filePath = tmpStatePath();
    const state = new CatchupStateStore({ filePath }).load();
    const tenMinAgo = PROCESS_START - 10 * MIN;
    const threeHoursAgo = PROCESS_START - 3 * HOUR;
    const twoMinAgo = PROCESS_START - 2 * MIN;

    state.setEventsSince('default', tenMinAgo);
    state.extendTarget('default', 'channel', 'dm', PROCESS_START);
    state.useIdScan('default', 'channel', 'dm', null, threeHoursAgo);
    state.markGap('default');
    state.save();

    const oldMsg = msg('id-old', threeHoursAgo);
    const newMsg = msg('id-new', twoMinAgo);
    const delivered = [];

    const client = fakeHub({
      channels: { dm: [oldMsg, newMsg] },
      events: [],
    });

    const runner = new CatchupRunner({
      client,
      label: 'default',
      state,
      processStartedAt: PROCESS_START,
      now: () => PROCESS_START,
      limits: { batchDelayMs: 0 },
      deliverMessage: async ({ message }) => delivered.push(message.id),
    });

    await runner.run('reconnected');
    runner.dispose();

    assert.deepEqual(delivered, ['id-new']);
    assert.equal(state.hasSeen('default', 'id-old'), true);
    assert.equal(runner.lastRun?.staleDropped, 1);
  });

  it('respects configurable HXA_CATCHUP_MAX_AGE_MIN env var and falls back on invalid values', async () => {
    assert.equal(resolveCatchupMaxAgeMs({}), DEFAULT_CATCHUP_MAX_AGE_MIN * MIN);
    assert.equal(resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: '15' }), 15 * MIN);
    assert.equal(resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: '0' }), 0);

    const warnLogs = [];
    assert.equal(
      resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: '-5' }, m => warnLogs.push(m)),
      DEFAULT_CATCHUP_MAX_AGE_MIN * MIN,
    );
    assert.equal(
      resolveCatchupMaxAgeMs({ HXA_CATCHUP_MAX_AGE_MIN: 'not-a-number' }, m => warnLogs.push(m)),
      DEFAULT_CATCHUP_MAX_AGE_MIN * MIN,
    );
    assert.equal(warnLogs.length, 2);

    // End-to-end with env var set to 120 minutes: a 60-minute-old cursor is allowed
    const prev = process.env.HXA_CATCHUP_MAX_AGE_MIN;
    process.env.HXA_CATCHUP_MAX_AGE_MIN = '120';
    try {
      const filePath = tmpStatePath();
      const state = new CatchupStateStore({ filePath }).load();
      const sixtyMinAgo = PROCESS_START - 60 * MIN;
      state.setEventsSince('default', sixtyMinAgo);
      state.markGap('default');

      const delivered = [];
      const m1 = msg('within-120m', sixtyMinAgo + 10_000);
      const client = fakeHub({
        channels: { dm: [m1] },
        events: [{ type: 'channel_message_summary', channel_id: 'dm', occurred_at: m1.created_at }],
      });

      const runner = new CatchupRunner({
        client,
        label: 'default',
        state,
        processStartedAt: PROCESS_START,
        now: () => PROCESS_START,
        limits: { batchDelayMs: 0 },
        deliverMessage: async ({ message }) => delivered.push(message.id),
      });

      await runner.run('reconnected');
      runner.dispose();

      assert.deepEqual(delivered, ['within-120m']);
    } finally {
      if (prev === undefined) delete process.env.HXA_CATCHUP_MAX_AGE_MIN;
      else process.env.HXA_CATCHUP_MAX_AGE_MIN = prev;
    }
  });
});
