import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplyReceipt } from '../src/lib/c4-receipt.js';

function harness(token = 'tok-hxa') {
  const lines = [];
  const receipts = createReplyReceipt({ token, print: (line) => lines.push(line) });
  return { receipts, lines };
}

test('DM send prints C4_RECEIPT with the hub message id', () => {
  const { receipts, lines } = harness();
  receipts.note({ channel_id: 'ch_1', message: { id: 'msg_dm_1' } });
  receipts.emit();

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice('C4_RECEIPT '.length)), {
    receiptToken: 'tok-hxa',
    platformMessageId: 'msg_dm_1',
  });
});

test('thread send prints C4_RECEIPT', () => {
  const { receipts, lines } = harness('tok-thread');
  receipts.note({ id: 'msg_thread_1', thread_id: 'th_1' });
  receipts.emit();

  assert.equal(JSON.parse(lines[0].slice('C4_RECEIPT '.length)).platformMessageId, 'msg_thread_1');
});

test('blocked send prints no C4_RECEIPT', () => {
  const { receipts, lines } = harness();
  const emitted = receipts.emit();

  assert.equal(emitted, null);
  assert.deepEqual(lines, []);
});
