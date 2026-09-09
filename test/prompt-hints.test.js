import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SMART_MODE_SKIP_HINT, buildDmPromptContent } from '../src/lib/prompt-hints.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the shared smart-mode hint carries the exact [SKIP] sentinel instruction', () => {
  assert.equal(
    SMART_MODE_SKIP_HINT,
    '<smart-mode>\nDecide whether to respond. Reply with exactly [SKIP] when a response is unnecessary.\n</smart-mode>\n\n',
  );
});

test('DM prompt content leads with the smart-mode hint and keeps the DM format intact', () => {
  const content = buildDmPromptContent({
    displayPrefix: 'hxa',
    sender: 'ss',
    content: 'hello there',
    attachments: ' [photo.png]',
  });
  assert.match(
    content,
    /^<smart-mode>\nDecide whether to respond\. Reply with exactly \[SKIP\] when a response is unnecessary\.\n<\/smart-mode>\n\n/,
    'DM prompts must open with the [SKIP] sentinel instruction (issue #20 cause 1)',
  );
  assert.ok(
    content.endsWith('[hxa DM] ss said: hello there [photo.png]'),
    'the legacy DM header/content shape must be preserved after the hint',
  );
});

test('short visible DM content is passed through unmodified after the hint', () => {
  for (const content of ['.', '—', 'ok']) {
    const prompt = buildDmPromptContent({ displayPrefix: 'hxa', sender: 'ss', content });
    assert.ok(prompt.endsWith(`[hxa DM] ss said: ${content}`));
  }
});

test('the DM builder rejects non-string fragments instead of coercing them', () => {
  assert.throws(
    () => buildDmPromptContent({ displayPrefix: 'hxa', sender: 'ss', content: null }),
    TypeError,
  );
});

test('bot.js injects the hint on the DM path and shares it with the thread path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  assert.match(
    source,
    /buildDmPromptContent\(\{/,
    'processDm must compose DM prompts through the shared hint builder',
  );
  assert.match(
    source,
    /parts\.push\(SMART_MODE_SKIP_HINT\)/,
    'the thread smart-mode branch must reuse the shared hint constant',
  );
  assert.doesNotMatch(
    source,
    /<smart-mode>/,
    'the hint text must live in the shared module, not inline in bot.js',
  );
});
