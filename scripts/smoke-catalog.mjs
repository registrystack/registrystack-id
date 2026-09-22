import { readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const canonicalBaseUrl = 'https://id.registrystack.org';
const baseUrl = (
  process.env.IDENTIFIER_BASE_URL ?? canonicalBaseUrl
).replace(/\/$/, '');
const catalogFiles = [
  'problems.json',
  'namespaces.json',
  'schemas.json',
  'contexts.json',
  'profiles.json',
  'vocabularies.json',
  'vocabulary-terms.json',
];

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function expectedBytes(path) {
  return readFileSync(resolve(repoRoot, 'public', path));
}

function uriPath(uri) {
  return new URL(uri).pathname.replace(/^\//, '');
}

function problemUri(entry) {
  return `${canonicalBaseUrl}/problems/${entry.product}/${entry.path}`;
}

function entryUri(entry) {
  return entry.kind === 'problem' ? problemUri(entry) : entry.uri;
}

function localUrl(uri) {
  const parsed = new URL(uri);
  return `${baseUrl}${parsed.pathname}${parsed.search}`;
}

function mediaType(contentType) {
  return contentType?.split(';', 1)[0].trim().toLowerCase() ?? '';
}

function expectedArtifactMediaType(path) {
  switch (extname(path)) {
    case '.jsonld':
      return 'application/ld+json';
    case '.md':
      return 'text/markdown';
    default:
      return 'application/schema+json';
  }
}

async function fetchExact(url, expectedPath, expectedMediaType) {
  const response = await fetch(url, {
    headers: expectedMediaType ? { accept: expectedMediaType } : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const actual = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const expected = expectedBytes(expectedPath);
  if (!actual.equals(expected)) {
    throw new Error(
      `${url} returned bytes that differ from public/${expectedPath}`,
    );
  }
  if (
    baseUrl === canonicalBaseUrl &&
    expectedMediaType &&
    mediaType(response.headers.get('content-type')) !== expectedMediaType
  ) {
    throw new Error(
      `${url} returned ${response.headers.get('content-type')}, expected ${expectedMediaType}`,
    );
  }
}

// `_redirects` rewrites (status 200) run before static assets, so an
// identifier page under a rewrite source serves the rewrite destination.
const rewrites = readFileSync(resolve(repoRoot, 'public/_redirects'), 'utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .filter(([source, , status]) => source && !source.startsWith('#') && status === '200')
  .map(([source, destination]) => ({
    pattern: new RegExp(
      `^${source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    ),
    destination: destination.replace(/^\//, ''),
  }));

function rewriteFor(path) {
  return rewrites.find((rewrite) => rewrite.pattern.test(`/${path}`));
}

async function checkEntry(entry) {
  const uri = entryUri(entry);
  const path = uriPath(uri);
  if (entry.artifact_sha256) {
    const expectedMediaType = expectedArtifactMediaType(entry.source);
    await fetchExact(localUrl(uri), path, expectedMediaType);
    if (!entry.immutable_uri) {
      throw new Error(`${uri} does not name an immutable artifact URI`);
    }
    await fetchExact(
      localUrl(entry.immutable_uri),
      uriPath(entry.immutable_uri),
      expectedMediaType,
    );
    return;
  }

  const rewrite = rewriteFor(path);
  if (rewrite) {
    await fetchExact(localUrl(uri), rewrite.destination, 'application/json');
  } else {
    const pagePath = `${path.replace(/\/$/, '')}/index.html`;
    await fetchExact(localUrl(uri), pagePath, 'text/html');
  }
  const recordPath = entry.kind === 'problem'
    ? `${path}.json`
    : path.endsWith('/')
      ? `${path}index.json`
      : `${path}.json`;
  await fetchExact(`${baseUrl}/${recordPath}`, recordPath, 'application/json');
}

const entries = catalogFiles.flatMap(
  (path) => readJson(`src/catalogs/${path}`).entries,
);
const digestArtifacts = readdirSync(resolve(repoRoot, 'src/artifacts/sha256'))
  .sort()
  .map((name) => ({
    name,
    run: () => fetchExact(
      `${baseUrl}/artifacts/sha256/${name}`,
      `artifacts/sha256/${name}`,
      expectedArtifactMediaType(name),
    ),
  }));
const checks = [
  ...entries.map((entry) => ({
    name: entryUri(entry),
    run: () => checkEntry(entry),
  })),
  ...digestArtifacts.map((artifact) => ({
    name: `${canonicalBaseUrl}/artifacts/sha256/${artifact.name}`,
    run: artifact.run,
  })),
];

let nextIndex = 0;
const results = new Array(checks.length);
async function worker() {
  while (nextIndex < checks.length) {
    const index = nextIndex;
    nextIndex += 1;
    try {
      await checks[index].run();
      results[index] = { status: 'fulfilled' };
    } catch (reason) {
      results[index] = { status: 'rejected', reason };
    }
  }
}
await Promise.all(Array.from({ length: Math.min(8, checks.length) }, worker));
const failures = results
  .map((result, index) => ({ result, check: checks[index] }))
  .filter(({ result }) => result.status === 'rejected');
for (const { result, check } of failures) {
  console.error(`${check.name}: ${result.reason.message}`);
}
if (failures.length > 0) {
  throw new Error(
    `${failures.length} of ${checks.length} catalog and immutable artifact checks failed on ${baseUrl}`,
  );
}
console.log(
  `all ${entries.length} active and deprecated identifiers plus ${digestArtifacts.length} retained immutable artifacts passed exact-byte checks on ${baseUrl}`,
);
