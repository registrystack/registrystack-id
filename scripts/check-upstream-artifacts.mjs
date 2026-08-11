import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const upstreamArg =
  process.argv[2] ?? process.env.REGISTRY_STACK_DIR ?? '../registry-stack';
const upstreamRoot = resolve(repoRoot, upstreamArg);
const baseUrl = 'https://id.registrystack.org';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function upstreamFile(path) {
  const target = resolve(upstreamRoot, path);
  const prefix = `${upstreamRoot}/`;
  if (!target.startsWith(prefix)) {
    throw new Error(`unsafe upstream source path: ${path}`);
  }
  return readFileSync(target);
}

function problemUri(entry) {
  return `${baseUrl}/problems/${entry.product}/${entry.path}`;
}

function expectedEntryFields(kind, entry) {
  if (kind === 'problem') {
    return [
      'code',
      'compatibility_line',
      'description',
      'http_statuses',
      'kind',
      'owner',
      'path',
      'product',
      'source',
      'source_reference',
      'status',
      'title',
    ];
  }
  const fields = [
    'compatibility_line',
    'description',
    'kind',
    'owner',
    'source_reference',
    'status',
    'title',
    'uri',
  ];
  if (entry.source) {
    fields.push('artifact_sha256', 'immutable_uri', 'source');
  }
  return fields.sort();
}

function exactEntryFieldsMatch(kind, entry) {
  return (
    Object.keys(entry).sort().join('\n') ===
    expectedEntryFields(kind, entry).join('\n')
  );
}

if (!existsSync(upstreamRoot)) {
  console.error(`registry-stack not found at ${upstreamRoot}`);
  process.exit(1);
}

const source = readJson('src/upstream/source.json');
const upstreamHead = execFileSync(
  'git',
  ['-C', upstreamRoot, 'rev-parse', 'HEAD^{commit}'],
  { encoding: 'utf8' },
).trim();
if (upstreamHead !== source.commit) {
  fail(`upstream checkout is ${upstreamHead}, expected ${source.commit}`);
}

const upstreamCatalogBytes = upstreamFile(source.catalog_path);
const vendoredCatalogBytes = readFileSync(
  resolve(repoRoot, 'src/upstream/catalog.v1.json'),
);
if (sha256(upstreamCatalogBytes) !== source.catalog_sha256) {
  fail('upstream catalog digest does not match src/upstream/source.json');
}
if (!upstreamCatalogBytes.equals(vendoredCatalogBytes)) {
  fail('vendored catalog bytes do not match the pinned Registry Stack checkout');
}

const upstreamCatalog = JSON.parse(upstreamCatalogBytes.toString('utf8'));
const catalogs = [
  ['problem', readJson('src/catalogs/problems.json').entries],
  ['schema', readJson('src/catalogs/schemas.json').entries],
  ['context', readJson('src/catalogs/contexts.json').entries],
  ['namespace', readJson('src/catalogs/namespaces.json').entries],
  ['vocabulary', readJson('src/catalogs/vocabularies.json').entries],
  [
    'vocabulary-term',
    readJson('src/catalogs/vocabulary-terms.json').entries,
  ],
];
const published = new Map();
for (const [kind, entries] of catalogs) {
  for (const entry of entries) {
    const uri = kind === 'problem' ? problemUri(entry) : entry.uri;
    if (published.has(uri)) {
      fail(`publisher contains a duplicate identifier: ${uri}`);
      continue;
    }
    if (entry.kind !== kind) {
      fail(`publisher kind mismatch for ${uri}: ${entry.kind} != ${kind}`);
    }
    if (!exactEntryFieldsMatch(kind, entry)) {
      fail(`publisher metadata fields differ from the exact import for ${uri}`);
    }
    published.set(uri, entry);
  }
}

const upstreamUris = new Set();
const expectedArtifactNames = new Set();
for (const entry of upstreamCatalog.entries) {
  upstreamUris.add(entry.uri);
  if (entry.status !== 'active') {
    fail(`upstream catalog contains a non-active identifier: ${entry.uri}`);
  }
  const sourceBytes = upstreamFile(entry.source.path);
  if (sha256(sourceBytes) !== entry.source.sha256) {
    fail(`source digest mismatch for ${entry.uri}: ${entry.source.path}`);
  }
  const publisherEntry = published.get(entry.uri);
  if (!publisherEntry) {
    fail(`publisher is missing upstream identifier: ${entry.uri}`);
    continue;
  }
  if (publisherEntry.kind !== entry.kind) {
    fail(`published kind differs from upstream for ${entry.uri}`);
  }
  if (publisherEntry.status !== entry.status) {
    fail(`published status differs from upstream for ${entry.uri}`);
  }
  if (publisherEntry.compatibility_line !== entry.compatibilityLine) {
    fail(`published compatibility line differs from upstream for ${entry.uri}`);
  }
  const reference = publisherEntry.source_reference;
  if (
    reference?.repository !== 'registry-stack' ||
    reference?.commit !== source.commit ||
    reference?.path !== entry.source.path ||
    reference?.sha256 !== entry.source.sha256
  ) {
    fail(`published source binding differs from upstream for ${entry.uri}`);
  }

  if (entry.artifact) {
    const artifactBytes = upstreamFile(entry.artifact.path);
    if (sha256(artifactBytes) !== entry.artifact.sha256) {
      fail(`upstream artifact digest mismatch for ${entry.uri}`);
      continue;
    }
    const extension = extname(entry.artifact.path) || '.bin';
    const expectedSource =
      `src/artifacts/sha256/${entry.artifact.sha256}${extension}`;
    expectedArtifactNames.add(`${entry.artifact.sha256}${extension}`);
    if (
      publisherEntry.source !== expectedSource ||
      publisherEntry.artifact_sha256 !== entry.artifact.sha256 ||
      publisherEntry.immutable_uri !==
        `${baseUrl}/artifacts/sha256/${entry.artifact.sha256}${extension}`
    ) {
      fail(`published artifact binding differs from upstream for ${entry.uri}`);
      continue;
    }
    const publishedBytes = readFileSync(resolve(repoRoot, expectedSource));
    if (!publishedBytes.equals(artifactBytes)) {
      fail(`published immutable artifact differs from upstream for ${entry.uri}`);
    }
  }
}

for (const uri of published.keys()) {
  if (!upstreamUris.has(uri)) {
    fail(`publisher contains an identifier absent from upstream: ${uri}`);
  }
}
const actualArtifactNames = new Set(
  readdirSync(resolve(repoRoot, 'src/artifacts/sha256')),
);
for (const name of actualArtifactNames) {
  if (!expectedArtifactNames.has(name)) {
    fail(`publisher contains an unreferenced immutable artifact: ${name}`);
  }
}

if (process.exitCode) {
  console.error('upstream catalog check failed');
} else {
  console.log(
    `pinned upstream catalog and ${upstreamCatalog.entries.length} identifiers are in sync`,
  );
}
