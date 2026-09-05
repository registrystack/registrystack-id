import assert from 'node:assert/strict';
import test from 'node:test';

import {
  identifierRoutes,
  problemProductAndPath,
  sameHttpStatuses,
} from './check-problem-routes.mjs';

const digest = 'a'.repeat(64);

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

test('an extension-less identifier publishes its page beside its artifact', () => {
  assert.deepEqual(
    identifierRoutes({
      uri: 'https://id.registrystack.org/contexts/registry-record/v1',
      artifact: {
        path: 'products/registry-record/context/registry-record-v1.jsonld',
        sha256: digest,
      },
    }),
    {
      artifact: 'contexts/registry-record/v1',
      page: 'contexts/registry-record/v1.html',
      immutable: `artifacts/sha256/${digest}.jsonld`,
    },
  );
  assert.deepEqual(
    identifierRoutes({
      uri: 'https://id.registrystack.org/profiles/registry-record/v1',
      artifact: {
        path: 'products/registry-record/profile/registry-record-v1.md',
        sha256: digest,
      },
    }),
    {
      artifact: 'profiles/registry-record/v1',
      page: 'profiles/registry-record/v1.html',
      immutable: `artifacts/sha256/${digest}.md`,
    },
  );
});

test('an identifier whose URI carries an extension publishes an index page', () => {
  assert.deepEqual(
    identifierRoutes({
      uri: 'https://id.registrystack.org/schemas/identifiers/catalog.v1.schema.json',
      artifact: {
        path: 'products/identifiers/contracts/catalog.v1.schema.json',
        sha256: digest,
      },
    }),
    {
      artifact: 'schemas/identifiers/catalog.v1.schema.json',
      page: 'schemas/identifiers/catalog.v1.schema/index.html',
      immutable: `artifacts/sha256/${digest}.json`,
    },
  );
});

test('identifier routes reject an identifier outside the resolver host', () => {
  assert.throws(
    () =>
      identifierRoutes({
        uri: 'https://example.test/contexts/registry-record/v1',
        artifact: { path: 'context.jsonld', sha256: digest },
      }),
    /outside the resolver host/,
  );
});
