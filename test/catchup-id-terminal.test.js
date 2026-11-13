import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CatchupRunner, DeliveryGate } from '../src/lib/catchup.js';
import { CatchupStateStore } from '../src/lib/catchup-state.js';
import { settleLiveDelivery } from '../src/lib/delivery.js';

function fixture({ count = 250, cap = 10000, pending, resumeIdScan = false }) {
  const T = Date.now() - 60000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hxa-id-terminal-'));
  const state = new CatchupStateStore({ filePath: path.join(dir, 'state.json') }).load();
  state.setEventsSince('default', T);
  state.markGap('default');
  if (resumeIdScan) {
    state.extendTarget('default', 'channel', 'dm', T + 10000);
    state.useIdScan('default', 'channel', 'dm', 'previous-page-anchor', 0);
  }
  const gate = new DeliveryGate({ state, label: 'default' });
  if (pending) gate.begin(pending);
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${String(i).padStart(4, '0')}`, created_at: T + 10000,
    sender_id: 'peer', channel_id: 'dm', content: 'synthetic',
  }));
  const events = [
    { type: 'channel_message_summary', channel_id: 'dm', occurred_at: T + 10000 },
    { type: 'bot_status_changed', occurred_at: T + 20000 },
  ];
  let idRequests = 0;
  const client = {
    async catchup({ since }) {
      return { events: events.filter(e => e.occurred_at > since), has_more: false };
    },
    async getMessages(_, options) {
      if (typeof options.before === 'string') {
        idRequests++;
        const anchor = messages.find(m => m.id === options.before);
        const rows = messages.filter(m => !anchor || m.created_at < anchor.created_at
          || (m.created_at === anchor.created_at && m.id < anchor.id))
          .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
        return { messages: rows.slice(0, options.limit), has_more: rows.length > options.limit };
      }
      // A legal timestamp tie order: high ids first. More than 200 rows forces
      // the real scanner into ID mode rather than the enlarged timestamp page.
      return messages.filter(m => m.created_at > options.since && m.created_at < options.before)
        .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
        .slice(0, options.limit);
    },
    async getThreadMessages() { return []; },
  };
  const delivered = [];
  const runner = new CatchupRunner({
    client, state, gate, label: 'default', now: () => T + 30000,
    limits: { batchDelayMs: 0, maxMessagesPerRun: cap }, log: () => {},
    deliverMessage: async ({ message }) => delivered.push(message.id),
    deliverEvent: async () => {},
  });
  return { T, state, gate, delivered, runner, messages,
    idRequests: () => idRequests,
    failPending() {
      settleLiveDelivery({ error: new Error('late C4 failure'), id: pending,
        at: T + 10000, gate, markGap: () => state.markGap('default'), save: () => state.save() });
    },
    dispose() { runner.dispose(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('ID terminal page interrupted before every row has a final answer', () => {
  it('retains a short final page when the per-run delivery cap is reached', async () => {
    const f = fixture({ cap: 25 });
    try {
      for (let i = 0; i < 30; i++) {
        await f.runner.run();
        if (new Set(f.delivered).size < 250) {
          assert.equal(f.state.isDirty('default'), true, 'incomplete delivery must keep the gap open');
          assert.equal(f.state.getEventsSince('default'), f.T, 'incomplete delivery must not move the boundary');
        }
      }
      assert.ok(f.idRequests() > 0, 'must exercise ID scanning');
      assert.equal(f.delivered.length, 250);
      assert.equal(new Set(f.delivered).size, 250);
      assert.equal(f.state.isDirty('default'), false);
    } finally { f.dispose(); }
  });

  for (const resumeIdScan of [true, false]) {
    it(`retains a pending row until late failure is replayed (${resumeIdScan ? 'saved ID cursor' : '250-row natural scan'})`, async () => {
      const f = fixture({ count: resumeIdScan ? 1 : 250, pending: resumeIdScan ? 'm0000' : 'm0025', resumeIdScan });
      try {
        await f.runner.run();
        assert.ok(f.idRequests() > 0, 'must exercise ID scanning');
        assert.equal(f.state.isDirty('default'), true);
        assert.equal(f.state.getEventsSince('default'), f.T);
        const target = f.state.getTarget('default', 'channel', 'dm');
        assert.ok(target.windows.length > 0, 'pending row must retain its scan window');
        assert.equal(target.ids.some(([id]) => id === (resumeIdScan ? 'm0000' : 'm0025')), false);
        f.failPending();
        for (let i = 0; i < 3; i++) await f.runner.run();
        assert.equal(f.delivered.length, f.messages.length);
        assert.equal(new Set(f.delivered).size, f.messages.length);
        assert.equal(f.state.isDirty('default'), false);
        assert.ok(f.state.getEventsSince('default') >= f.T + 20000, 'completed scan may advance through its current run time');
      } finally { f.dispose(); }
    });
  }
});
