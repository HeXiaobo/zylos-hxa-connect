import assert from 'node:assert/strict';
import test from 'node:test';

import { isSilentAssistantContent } from '../src/lib/silent-response.js';

test('the exact smart-mode sentinel is silent, with or without padding', () => {
  assert.equal(isSilentAssistantContent('[SKIP]'), true);
  assert.equal(isSilentAssistantContent('  [skip]  '), true);
});

test('empty and whitespace-only output is silent', () => {
  assert.equal(isSilentAssistantContent(''), true);
  assert.equal(isSilentAssistantContent('   \n\t '), true);
});

test('invisible-only output is silent even though trim() keeps it', () => {
  // Regression: '\u200B'.trim().length === 1, so a trim()-based check
  // delivers a zero-width space verbatim and re-triggers the peer.
  assert.equal('\u200B'.trim().length, 1);
  assert.equal(isSilentAssistantContent('\u200B'), true);
  assert.equal(isSilentAssistantContent('\uFEFF\u2060\u200D'), true);
});

test('visible output is never silent, including a lone period', () => {
  assert.equal(isSilentAssistantContent('.'), false);
  assert.equal(isSilentAssistantContent('处理完成。'), false);
  assert.equal(isSilentAssistantContent('\u200Bhi'), false);
});

test('non-strings are not silent', () => {
  assert.equal(isSilentAssistantContent(undefined), false);
  assert.equal(isSilentAssistantContent(null), false);
  assert.equal(isSilentAssistantContent(0), false);
});
