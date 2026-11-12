/**
 * Tests for catch-up on reconnect.
 *
 * The runner is exercised against a fake HXA client / state store so the
 * behaviour is verified without a live hub:
 *   - messages missed while offline are replayed through the shared pipeline
 *   - ids already delivered in realtime are not replayed
 *   - oversized runs deliver everything (batched), nothing is dropped
 *   - a failing catchup() never touches realtime traffic
 *   - the watermark survives a restart
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CatchupRunner, DEFAULT_LIMITS, DeliveryGate, formatCatchupSummary } from '../src/lib/catchup.js';
import { CatchupStateStore } from '../src/lib/catchup-state.js';

// ─── Helpers ────────────────────────────────────────────────────

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-catchup-'));
  return path.join(dir, 'catchup-state.json');
}

function msg(id, at, content = `message ${id}`, extra = {}) {
  return {
    id,
    channel_id: 'dm-1',
    sender_id: 'bot-a',
    sender_name: 'bot-a',
    content,
    content_type: 'text',
    parts: [],
    created_at: at,
    ...extra,
  };
}

/**
 * Minimal hub stand-in: one direct channel plus one thread, served by
 * `catchup()`, `getMessages()`, `getThreadMessages()`.
 */
function fakeClient({ channels = {}, threads = {}, events, catchupError } = {}) {
  const calls = { catchup: 0, getMessages: 0, getThreadMessages: 0 };
  // Deliberately returns a capped page in an order that does NOT start at the
  // newest message: catch-up must not depend on server-side ordering.
  const page = (all, opts) => {
    const lo = opts.since ?? 0;
    const hi = opts.before ?? Infinity;
    const windowed = all
      .filter(m => m.created_at >= lo && m.created_at < hi)
      .sort((a, b) => a.created_at - b.created_at);
    const limit = opts.limit ?? windowed.length;
    if (windowed.length <= limit) return windowed;
    // Cap: return the OLDEST half — a naive "page forward" implementation
    // would then never reach the newer messages.
    return windowed.slice(0, limit);
  };
  return {
    calls,
    async catchup(opts) {
      calls.catchup++;
      if (catchupError) throw catchupError;
      const all = events(opts);
      const limit = opts.limit ?? all.length;
      return { events: all.slice(0, limit), has_more: all.length > limit };
    },
    async getMessages(channelId, opts) {
      calls.getMessages++;
      return page(channels[channelId] || [], opts);
    },
    async getThreadMessages(threadId, opts) {
      calls.getThreadMessages++;
      return page(threads[threadId] || [], opts);
    },
    async listPeers() {
      return [{ id: 'bot-a', name: 'bot-a' }];
    },
  };
}

function makeRunner({ client, state, delivered, summaries = [], limits = {}, log = [] }) {
  return new CatchupRunner({
    client,
    label: 'default',
    state,
    limits: { batchDelayMs: 0, ...limits },
    log: m => log.push(m),
    deliverMessage: async item => { delivered.push(item); },
    deliverSummary: async text => { summaries.push(text); },
  });
}

const NOW = Date.UTC(2026, 10, 12, 4, 0, 0);
const T0 = NOW - 60 * 60 * 1000; // one hour before "now"

function seededState(point) {
  const filePath = tmpStatePath();
  const state = new CatchupStateStore({ filePath }).load();
  state.setWatermark('default', point);
  state.setDirty('default', true);
  state.save();
  return { filePath, state };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('catch-up on reconnect', () => {
  it('replays 3 DMs missed while offline, exactly once', async () => {
    const { state } = seededState(T0);
    const messages = [msg('m1', T0 + 1000), msg('m2', T0 + 2000), msg('m3', T0 + 3000)];
    const client = fakeClient({
      channels: { 'dm-1': messages },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 3, last_at: T0 + 3000 }],
    });
    const delivered = [];
    const summaries = [];
    const runner = makeRunner({ client, state, delivered, summaries });

    await runner.run('connected');
    assert.deepEqual(delivered.map(d => d.message.id), ['m1', 'm2', 'm3']);
    assert.equal(summaries.length, 0, 'no summary line for a small replay');
    assert.ok(delivered.every(d => d.catchup === true && d.kind === 'channel'));
    assert.ok(state.getWatermark('default') >= T0 + 3000, 'watermark advanced past the newest replayed message');
    assert.equal(state.isDirty('default'), false, 'gap closed after a complete replay');

    // Second run with nothing new must not replay anything.
    await runner.run('reconnected');
    assert.equal(delivered.length, 3, 'no duplicate delivery on a second run');
    assert.equal(client.calls.catchup, 2);
  });

  it('does not replay a message that was already delivered in realtime', async () => {
    const { state } = seededState(T0);
    // Simulate the realtime path having handled m2 while the hub still reports it.
    state.remember('default', 'm2');
    const client = fakeClient({
      channels: { 'dm-1': [msg('m1', T0 + 1000), msg('m2', T0 + 2000), msg('m3', T0 + 3000)] },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 3, last_at: T0 + 3000 }],
    });
    const delivered = [];
    const runner = makeRunner({ client, state, delivered });

    await runner.run('reconnected');
    assert.deepEqual(delivered.map(d => d.message.id), ['m1', 'm3']);
  });

  it('delivers every message when a run exceeds the notify threshold (batching, nothing dropped)', async () => {
    const { state } = seededState(T0);
    const many = [];
    for (let i = 0; i < 120; i++) many.push(msg(`m${i}`, T0 + 1000 + i * 1000));
    const client = fakeClient({
      channels: { 'dm-1': many },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: many.length, last_at: T0 + 200000 }],
    });
    const delivered = [];
    const summaries = [];
    const runner = makeRunner({ client, state, delivered, summaries, limits: { batchSize: 25 } });

    await runner.run('reconnected');

    assert.equal(summaries.length, 1, 'one notice line for an oversized run');
    assert.match(summaries[0], /补收/);
    assert.match(summaries[0], /120 条/);
    assert.equal(delivered.length, 120, 'all original messages must be retrievable');
    const ids = new Set(delivered.map(d => d.message.id));
    assert.equal(ids.size, 120, 'no duplicates');
    assert.ok(state.getWatermark('default') >= many[many.length - 1].created_at);
  });

  it('resumes an oversized run that hit the per-run cap instead of losing the rest', async () => {
    const { state } = seededState(T0);
    const many = [];
    for (let i = 0; i < 30; i++) many.push(msg(`m${i}`, T0 + 1000 + i * 1000));
    const client = fakeClient({
      channels: { 'dm-1': many },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: many.length, last_at: T0 + 40000 }],
    });
    const delivered = [];
    const runner = makeRunner({
      client, state, delivered,
      limits: { maxMessagesPerRun: 10, batchSize: 1000, batchDelayMs: 0 },
    });

    await runner.run('reconnected');
    assert.equal(delivered.length, 10);
    assert.equal(state.getWatermark('default'), T0, 'watermark untouched by the unfinished run');
    assert.equal(state.isDirty('default'), true, 'org still marked dirty');

    await runner.run('reconnected');
    await runner.run('reconnected');

    assert.deepEqual(delivered.map(d => d.message.id), many.map(m => m.id));
    assert.equal(state.isDirty('default'), false, 'dirty cleared once everything is delivered');
  });

  it('keeps working when catchup() fails, and retries on the next reconnect', async () => {
    const { state } = seededState(T0);
    let fail = true;
    const client = {
      calls: { catchup: 0 },
      async catchup(opts) {
        this.calls.catchup++;
        if (fail) throw new Error('hub 503');
        return { events: [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 1, last_at: T0 + 1000 }], has_more: false };
      },
      async getMessages() { return [msg('m1', T0 + 1000)]; },
      async getThreadMessages() { return []; },
      async listPeers() { return []; },
    };
    const delivered = [];
    const log = [];
    const runner = makeRunner({ client, state, delivered, log });

    await runner.run('reconnected');
    assert.equal(delivered.length, 0);
    assert.match(log.join('\n'), /catchup failed while fetching events/);
    assert.equal(runner.lastRun.error, 'hub 503');
    // The watermark must not move on failure.
    assert.equal(state.getWatermark('default'), T0);
    assert.equal(state.isDirty('default'), true);

    fail = false;
    await runner.run('reconnected');
    assert.deepEqual(delivered.map(d => d.message.id), ['m1']);
  });

  it('persists the watermark across a restart', async () => {
    const { filePath, state } = seededState(T0);
    const client = fakeClient({
      channels: { 'dm-1': [msg('m1', T0 + 1000)] },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 1, last_at: T0 + 1000 }],
    });
    await makeRunner({ client, state, delivered: [] }).run('reconnected');

    // "Restart": brand-new store instance reading the same file.
    const reloaded = new CatchupStateStore({ filePath }).load();
    assert.ok(reloaded.getWatermark('default') >= T0 + 1000);
    assert.ok(reloaded.hasSeen('default', 'm1'), 'recent ids survive restart');

    const delivered = [];
    await makeRunner({ client, state: reloaded, delivered }).run('reconnected');
    assert.equal(delivered.length, 0, 'restart does not replay delivered messages');
  });

  it('baselines on first run instead of replaying pre-feature history', async () => {
    const filePath = tmpStatePath();
    const state = new CatchupStateStore({ filePath }).load();
    const client = fakeClient({
      channels: { 'dm-1': [msg('old', T0)] },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 1, last_at: T0 }],
    });
    const delivered = [];
    const runner = new CatchupRunner({
      client, label: 'default', state,
      now: () => NOW,
      limits: { batchDelayMs: 0 },
      deliverMessage: async i => delivered.push(i),
    });

    await runner.run('connected');
    assert.equal(delivered.length, 0);
    assert.equal(client.calls.catchup, 0, 'no catchup call before a baseline exists');
    assert.equal(state.getWatermark('default'), NOW);
    assert.equal(state.isDirty('default'), false);
  });

  it('replays thread messages through the same pipeline', async () => {
    const { state } = seededState(T0);
    const client = fakeClient({
      threads: { 't1': [msg('tm1', T0 + 1000), msg('tm2', T0 + 2000)] },
      events: () => [{ type: 'thread_message_summary', thread_id: 't1', topic: 'review', count: 2, last_at: T0 + 2000 }],
    });
    const delivered = [];
    await makeRunner({ client, state, delivered }).run('reconnected');

    assert.deepEqual(delivered.map(d => [d.kind, d.threadId, d.message.id]), [
      ['thread', 't1', 'tm1'],
      ['thread', 't1', 'tm2'],
    ]);
  });

  it('stops at the first failed delivery and retries it later (no message skipped)', async () => {
    const { state } = seededState(T0);
    const client = fakeClient({
      channels: { 'dm-1': [msg('m1', T0 + 1000), msg('m2', T0 + 2000), msg('m3', T0 + 3000)] },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 3, last_at: T0 + 3000 }],
    });
    let failOnce = true;
    const delivered = [];
    const runner = new CatchupRunner({
      client, label: 'default', state,
      limits: { batchDelayMs: 0 },
      log: () => {},
      deliverMessage: async item => {
        if (item.message.id === 'm2' && failOnce) { failOnce = false; throw new Error('C4 rejected'); }
        delivered.push(item);
      },
    });

    await runner.run('reconnected');
    assert.deepEqual(delivered.map(d => d.message.id), ['m1']);
    assert.equal(state.getWatermark('default'), T0);

    // A realtime delivery for m3 (arriving before the replay is done) is
    // de-duplicated by id, but must not move the watermark while the org is
    // still dirty — otherwise the older, undelivered m2 would be skipped.
    const gate = new DeliveryGate({ state, label: 'default' });
    gate.mark('m3', T0 + 3000);
    assert.equal(state.getWatermark('default'), T0, 'realtime must not move a dirty watermark');

    await runner.run('reconnected');
    assert.deepEqual(delivered.map(d => d.message.id), ['m1', 'm2'],
      'm2 is retried, m3 is not re-delivered');
    assert.equal(state.isDirty('default'), false);
  });

  it('serialises concurrent runs for one connection', async () => {
    const { state } = seededState(T0);
    let active = 0;
    let maxActive = 0;
    const client = fakeClient({
      channels: { 'dm-1': [msg('m1', T0 + 1000)] },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 1, last_at: T0 + 1000 }],
    });
    const runner = new CatchupRunner({
      client, label: 'default', state,
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
    assert.equal(maxActive, 1, 'only one catch-up run at a time');
  });

  it('counts only deliverable messages in the summary line', async () => {
    const { state } = seededState(T0);
    const many = [];
    for (let i = 0; i < 80; i++) many.push(msg(`m${i}`, T0 + 1000 + i * 1000));
    // 20 of them were already delivered live; 60 are still owed.
    state.remember('default', many.slice(0, 20).map(m => m.id));
    const client = fakeClient({
      channels: { 'dm-1': many },
      events: () => [{ type: 'channel_message_summary', channel_id: 'dm-1', count: 80, last_at: T0 + 81000 }],
    });
    const delivered = [];
    const summaries = [];
    await makeRunner({ client, state, delivered, summaries }).run('reconnected');

    assert.equal(delivered.length, 60);
    assert.equal(summaries.length, 1);
    assert.match(summaries[0], /60 条/, 'the notice counts what is actually replayed');
  });

  it('summarises large or long-offline runs without dropping messages', () => {
    const text = formatCatchupSummary({
      label: 'default', count: 73, offlineMs: 26 * 3600 * 1000,
      since: T0, until: NOW, limits: DEFAULT_LIMITS, multiOrg: true,
    });
    assert.match(text, /73 条/);
    assert.match(text, /26\.0 小时/);
    assert.match(text, /不丢弃任何消息/);
  });
});
