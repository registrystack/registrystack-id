import assert from 'node:assert/strict';
import test from 'node:test';

import {
  problemProductAndPath,
  sameHttpStatuses,
} from './check-problem-routes.mjs';

test('problem product and path split at the first path segment', () => {
  assert.deepEqual(
    problemProductAndPath({
      uri: 'https://id.registrystack.org/problems/registry-evidence/auth/invalid_credential',
    }),
    { product: 'registry-evidence', path: 'auth/invalid_credential' },
  );
});

test('problem product and path rejects a non-problem identifier', () => {
  assert.throws(
    () =>
      problemProductAndPath({
        uri: 'https://id.registrystack.org/schemas/example.json',
      }),
    /invalid problem identifier/,
  );
});

test('HTTP statuses compare as sets, ignoring order', () => {
  assert.equal(sameHttpStatuses([401, 403], [403, 401]), true);
  assert.equal(sameHttpStatuses([401], [401, 403]), false);
  assert.equal(sameHttpStatuses(undefined, undefined), true);
  assert.equal(sameHttpStatuses([401], undefined), false);
});
