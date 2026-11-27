import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCatchupSummary } from '../src/lib/catchup.js';

const base = {
  label: 'org-2',
  offlineMs: 78_000,
  since: 1795769696967,
  until: 1795769775219,
  multiOrg: true,
};

test('summary reports actual delivered and skipped counts', () => {
  const text = formatCatchupSummary({ ...base, delivered: 1, skipped: 1 });

  assert.match(text, /实际补投 1 条/);
  assert.match(text, /跳过 1 条/);
  assert.doesNotMatch(text, /238/);
});

test('summary never claims all messages were replayed', () => {
  const text = formatCatchupSummary({ ...base, delivered: 0, skipped: 0 });

  assert.doesNotMatch(text, /全部补投/);
  assert.doesNotMatch(text, /不丢弃任何消息/);
  assert.match(text, /实际补投 0 条/);
});
