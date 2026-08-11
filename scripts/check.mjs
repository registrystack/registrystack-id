import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = resolve(repoRoot, 'public');
const tempDir = mkdtempSync(join(tmpdir(), 'registrystack-id-'));
const baseUrl = 'https://id.registrystack.org';

function listFiles(root, dir = root) {
  const result = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      result.push(...listFiles(root, path));
    } else {
      result.push(relative(root, path));
    }
  }
  return result;
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
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

function checkExactEntryFields(kind, entry, uri) {
  const actual = Object.keys(entry).sort();
  const expected = expectedEntryFields(kind, entry);
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error(`publisher metadata fields differ from the exact import for ${uri}`);
  }
}

function checkCatalogBindings() {
  const source = readJson('src/upstream/source.json');
  if (!/^[0-9a-f]{40}$/.test(source.commit)) {
    throw new Error('src/upstream/source.json does not pin a full commit');
  }
  const vendoredPath = resolve(repoRoot, 'src/upstream/catalog.v1.json');
  if (digest(vendoredPath) !== source.catalog_sha256) {
    throw new Error('vendored upstream catalog digest does not match its source record');
  }
  const upstream = readJson('src/upstream/catalog.v1.json');
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
      const uri =
        kind === 'problem'
          ? `${baseUrl}/problems/${entry.product}/${entry.path}`
          : entry.uri;
      if (published.has(uri)) {
        throw new Error(`duplicate published identifier: ${uri}`);
      }
      if (entry.kind !== kind) {
        throw new Error(`published kind mismatch for ${uri}`);
      }
      checkExactEntryFields(kind, entry, uri);
      published.set(uri, entry);
    }
  }

  const upstreamUris = new Set();
  const expectedArtifactNames = new Set();
  for (const entry of upstream.entries) {
    upstreamUris.add(entry.uri);
    if (entry.status !== 'active') {
      throw new Error(`upstream catalog contains a non-active identifier: ${entry.uri}`);
    }
    const current = published.get(entry.uri);
    if (!current || current.kind !== entry.kind || current.status !== entry.status) {
      throw new Error(`published catalog differs from upstream for ${entry.uri}`);
    }
    if (current.compatibility_line !== entry.compatibilityLine) {
      throw new Error(`published compatibility line differs for ${entry.uri}`);
    }
    if (
      current.source_reference?.commit !== source.commit ||
      current.source_reference?.path !== entry.source.path ||
      current.source_reference?.sha256 !== entry.source.sha256
    ) {
      throw new Error(`published source binding differs for ${entry.uri}`);
    }
    if (entry.artifact) {
      expectedArtifactNames.add(
        `${entry.artifact.sha256}${extname(entry.artifact.path) || '.bin'}`,
      );
      if (
        !current.source ||
        digest(resolve(repoRoot, current.source)) !== entry.artifact.sha256
      ) {
        throw new Error(`published artifact digest differs for ${entry.uri}`);
      }
    }
  }
  for (const uri of published.keys()) {
    if (!upstreamUris.has(uri)) {
      throw new Error(`publisher contains an identifier absent from upstream: ${uri}`);
    }
  }
  const artifactNames = readdirSync(resolve(repoRoot, 'src/artifacts/sha256'));
  for (const name of artifactNames) {
    if (!expectedArtifactNames.has(name)) {
      throw new Error(`publisher contains an unreferenced immutable artifact: ${name}`);
    }
  }
  console.log(`source catalogs exactly publish ${published.size} active identifiers`);
}

try {
  checkCatalogBindings();
  const build = spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, OUTPUT_DIR: tempDir },
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const expected = listFiles(tempDir);
  const actual = listFiles(publicDir);
  const expectedList = expected.join('\n');
  const actualList = actual.join('\n');
  if (expectedList !== actualList) {
    console.error('public/ file list is not generated from current catalogs');
    console.error('expected:\n' + expectedList);
    console.error('actual:\n' + actualList);
    process.exit(1);
  }

  for (const file of expected) {
    const expectedDigest = digest(join(tempDir, file));
    const actualDigest = digest(join(publicDir, file));
    if (expectedDigest !== actualDigest) {
      console.error(`public/${file} is not generated from current catalogs`);
      process.exit(1);
    }
  }

  console.log('public/ matches generated output');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
