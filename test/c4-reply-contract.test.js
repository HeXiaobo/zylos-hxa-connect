import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

test('C4 reply examples use stdin instead of a message argument', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'cli.js'), 'utf8');

  assert.match(readme, /cat <<'EOF' \| node .*c4-send\.js "hxa-connect"/);
  assert.doesNotMatch(readme, /c4-send\.js "hxa-connect" "[^"]+" "message"/);
  assert.match(cli, /pipe the message body via stdin/i);
});
