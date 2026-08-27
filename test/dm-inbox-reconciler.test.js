import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DmInboxReconciler, DmInboxState } from '../src/lib/dm-inbox-reconciler.js';

const tempDirs = [];

async function statePath() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hxa-dm-state-'));
  tempDirs.push(dir);
  return path.join(dir, 'state.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});
function message(id, createdAt = 900) {
  return {
    id,
    channel_id: 'dm-channel',
    sender_id: 'sender-id',
    sender_name: 'ss',
    content: id,
    parts: [{ type: 'text', content: id }],
    created_at: createdAt,
  };
}

describe('DmInboxReconciler', () => {
  it('recovers a DM that never arrived on the WebSocket', async () => {
    const filePath = await statePath();
    const state = new DmInboxState({
      filePath,
      clock: () => 1_000,
      initialLookbackMs: 500,
      overlapMs: 100,
    });
    const delivered = [];
    const sinceCalls = [];
    const client = {
      async inbox(since) {
        sinceCalls.push(since);
        return [message('missed-ws')];
      },
    };
    const reconciler = new DmInboxReconciler({
      label: 'hxa',
      client,
      state,
      clock: () => 1_000,
      processMessage: async (item, source) => {
        delivered.push({ item, source });
        return { action: 'accepted' };
      },
      logger: { log() {}, warn() {}, error() {} },
    });
    await state.load();

    const result = await reconciler.pollOnce();
    assert.equal(result.recovered, 1);
    assert.deepEqual(sinceCalls, [400]);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].source, 'inbox');
  });

  it('deduplicates a live event against later inbox overlap polls and restart', async () => {
    const filePath = await statePath();
    let now = 1_000;
    const delivered = [];
    const create = async () => {
      const state = new DmInboxState({ filePath, clock: () => now, overlapMs: 100 });
      await state.load();
      return new DmInboxReconciler({
        label: 'hxa',
        client: { inbox: async () => [message('same-message', 950)] },
        state,
        clock: () => now,
        processMessage: async (item, source) => {
          delivered.push(source);
          return { action: 'accepted' };
        },
        logger: { log() {}, warn() {}, error() {} },
      });
    };

    const first = await create();
    await first.observeLive(message('same-message', 950));
    await first.pollOnce();
    now = 2_000;
    const afterRestart = await create();
    await afterRestart.pollOnce();

    assert.deepEqual(delivered, ['websocket']);
  });

  it('keeps an unresolved message inside the next overlap window', async () => {
    const filePath = await statePath();
    let now = 10_000;
    const state = new DmInboxState({
      filePath,
      clock: () => now,
      initialLookbackMs: 5_000,
      overlapMs: 1_000,
    });
    await state.load();
    const sinceCalls = [];
    let attempts = 0;
    const reconciler = new DmInboxReconciler({
      label: 'hxa',
      client: {
        async inbox(since) {
          sinceCalls.push(since);
          return [message('rate-limited', 9_500)];
        },
      },
      state,
      clock: () => now,
      processMessage: async () => {
        attempts += 1;
        return attempts === 1 ? { action: 'retry' } : { action: 'accepted' };
      },
      logger: { log() {}, warn() {}, error() {} },
    });

    await reconciler.pollOnce();
    now = 20_000;
    await reconciler.pollOnce();

    assert.equal(attempts, 2);
    assert.ok(sinceCalls[1] <= 9_500, `expected unresolved message to remain in range, since=${sinceCalls[1]}`);
  });
});
