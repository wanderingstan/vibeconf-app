import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PREFERENCES, describe } = require('../electron-app/preferences-schema.js');

test('remote session-log shipping requires an explicit opt-in', () => {
  assert.equal(PREFERENCES.remoteLogging.default, false);

  const [remoteLogging] = describe(() => undefined)
    .filter((preference) => preference.key === 'remoteLogging');

  assert.equal(remoteLogging.value, false);
  assert.equal(remoteLogging.isDefault, true);
  assert.match(remoteLogging.description, /OFF by default/);
});
