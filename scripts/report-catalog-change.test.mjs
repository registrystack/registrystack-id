import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderMarkdown,
  summarizeCatalogs,
} from './report-catalog-change.mjs';

function entry(uri, values = {}) {
  return {
    uri,
    kind: 'schema',
    title: uri,
    status: 'active',
    compatibility_line: 'v1',
    ...values,
  };
}

test('catalog change summary classifies additions, removals, and updates', () => {
  const summary = summarizeCatalogs(
    [
      entry('https://id.registrystack.org/removed'),
      entry('https://id.registrystack.org/metadata', { title: 'Before' }),
      entry('https://id.registrystack.org/artifact', {
        artifact_sha256: 'a'.repeat(64),
      }),
    ],
    [
      entry('https://id.registrystack.org/added'),
      entry('https://id.registrystack.org/metadata', { title: 'After' }),
      entry('https://id.registrystack.org/artifact', {
        artifact_sha256: 'b'.repeat(64),
      }),
    ],
  );
  assert.equal(summary.before, 3);
  assert.equal(summary.after, 3);
  assert.deepEqual(summary.added, ['https://id.registrystack.org/added']);
  assert.deepEqual(summary.removed, ['https://id.registrystack.org/removed']);
  assert.deepEqual(summary.metadata_updated, [
    'https://id.registrystack.org/metadata',
  ]);
  assert.deepEqual(summary.artifact_updated, [
    'https://id.registrystack.org/artifact',
  ]);
  assert.match(renderMarkdown(summary), /Published identifiers: 3 -> 3/);
});

test('catalog change summary rejects kind changes', () => {
  assert.throws(
    () =>
      summarizeCatalogs(
        [entry('https://id.registrystack.org/stable')],
        [
          entry('https://id.registrystack.org/stable', {
            kind: 'vocabulary',
          }),
        ],
      ),
    /changed kind/,
  );
});
