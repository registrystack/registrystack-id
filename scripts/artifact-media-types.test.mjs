import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactContentType,
  artifactMediaTypeBindingsDocument,
  baseMediaType,
  bindArtifactMediaType,
  immutableArtifactHeaderRules,
  parseArtifactMediaTypeBindings,
} from './artifact-media-types.mjs';

function patternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

test('a parameterized catalog media type is preserved while smoke comparison uses its base type', () => {
  const declared = 'application/yaml; profile=registrystack';
  assert.equal(
    artifactContentType({
      kind: 'schema',
      artifact_media_type: declared,
    }),
    declared,
  );
  assert.equal(
    baseMediaType('Application/YAML; profile=registrystack; charset=utf-8'),
    baseMediaType(declared),
  );
});

test('immutable rules partition a known suffix when one artifact overrides its media type', () => {
  const jsonDefaultA = `${'0'.repeat(64)}.json`;
  const jsonOverride = `${'1'.repeat(64)}.json`;
  const jsonDefaultB = `${'2'.repeat(64)}.json`;
  const yamlDefault = `${'a'.repeat(64)}.yaml`;
  const rules = immutableArtifactHeaderRules(
    [jsonDefaultA, jsonOverride, jsonDefaultB, yamlDefault],
    new Map([
      [jsonOverride, 'application/example+json; profile=fixture'],
    ]),
  );

  const expected = new Map([
    [jsonDefaultA, 'application/schema+json; charset=utf-8'],
    [jsonOverride, 'application/example+json; profile=fixture'],
    [jsonDefaultB, 'application/schema+json; charset=utf-8'],
    [yamlDefault, 'application/yaml; charset=utf-8'],
  ]);
  for (const [name, contentType] of expected) {
    const path = `artifacts/sha256/${name}`;
    const matching = rules.filter((rule) =>
      patternToRegExp(rule.path).test(path));
    assert.equal(
      matching.length,
      1,
      `${path} must match one immutable header rule`,
    );
    assert.equal(matching[0].contentType, contentType);
  }
  assert.ok(
    !rules.some((rule) => rule.path === 'artifacts/sha256/*.json'),
    'a conflicting JSON override must replace the broad JSON wildcard',
  );
  assert.ok(rules.length < 20, 'fixture rules must remain compact');
});

test('artifact media type bindings serialize deterministically and round trip', () => {
  const bindings = new Map();
  bindArtifactMediaType(bindings, `${'b'.repeat(64)}.yaml`, 'application/yaml');
  bindArtifactMediaType(
    bindings,
    `${'a'.repeat(64)}.json`,
    'application/example+json; profile=fixture',
  );
  const document = artifactMediaTypeBindingsDocument(bindings);
  assert.deepEqual(Object.keys(document.artifacts), [
    `${'a'.repeat(64)}.json`,
    `${'b'.repeat(64)}.yaml`,
  ]);
  assert.deepEqual(parseArtifactMediaTypeBindings(document), new Map([
    [`${'a'.repeat(64)}.json`, 'application/example+json; profile=fixture'],
    [`${'b'.repeat(64)}.yaml`, 'application/yaml'],
  ]));
});
