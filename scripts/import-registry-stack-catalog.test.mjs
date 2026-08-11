import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeCatalog,
  parseArguments,
} from './import-registry-stack-catalog.mjs';

test('catalog import requires an explicit full source commit', () => {
  assert.throws(() => parseArguments([]), /full commit/);
  assert.throws(
    () => parseArguments(['../registry-stack', '--source-revision', 'deadbeef']),
    /full commit/,
  );
  const parsed = parseArguments([
    '../registry-stack',
    '--source-revision',
    'a'.repeat(40),
  ]);
  assert.equal(parsed.revision, 'a'.repeat(40));
});

test('catalog merge drops identifiers absent from the current source catalog', () => {
  const result = mergeCatalog(
    [
      {
        product: 'registry-relay',
        path: 'legacy/problem',
        code: 'legacy.problem',
        title: 'Legacy problem',
      },
    ],
    [],
    'problem',
  );
  assert.deepEqual(result, []);
});

test('catalog merge replaces historical fields with exact current metadata', () => {
  const result = mergeCatalog(
    [
      {
        uri: 'https://id.registrystack.org/ns/example/v1#',
        title: 'Old title',
        documented_by: ['https://docs.example.test/'],
      },
    ],
    [
      {
        uri: 'https://id.registrystack.org/ns/example/v1#',
        title: 'Current title',
        kind: 'namespace',
        status: 'active',
      },
    ],
    'namespace',
  );
  assert.equal(result[0].title, 'Current title');
  assert.equal(result[0].documented_by, undefined);
  assert.equal(result[0].status, 'active');
});

test('catalog merge rejects a historical kind mismatch', () => {
  assert.throws(
    () =>
      mergeCatalog(
        [
          {
            uri: 'https://id.registrystack.org/ns/example/v1#',
            kind: 'schema',
          },
        ],
        [],
        'namespace',
      ),
    /changed kind/,
  );
});

test('catalog merge rejects duplicate imported identifiers', () => {
  const entry = {
    uri: 'https://id.registrystack.org/schemas/example.json',
    kind: 'schema',
  };
  assert.throws(
    () => mergeCatalog([], [entry, entry], 'schema'),
    /duplicate imported/,
  );
});
