import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// This descriptor is the repository-link contract consumed by resident agents.
test('repository link selects only this fork through the shared verified channel', () => {
  const entry = JSON.parse(fs.readFileSync(new URL('../UPGRADE.json', import.meta.url), 'utf8'));
  assert.equal(entry.schema, 'zylos.repository-upgrade-entry/v1');
  assert.equal(entry.component, 'hxa');
  assert.equal(entry.scope, 'hxa');
  assert.equal(entry.repository, 'HeXiaobo/zylos-hxa-connect');
  assert.equal(entry.catalogRepository, 'HeXiaobo/zylos-core');
  assert.equal(entry.catalogAsset, 'zylos-release.json');
  assert.equal(entry.defaultChannel, 'stable');
  assert.equal(entry.previewChannel, 'preview');
  assert.equal(entry.operatorEntrypoint, 'tools/upgrade/prepare.mjs');
  assert.equal(entry.allComponentsRequireExplicitRequest, true);
});
