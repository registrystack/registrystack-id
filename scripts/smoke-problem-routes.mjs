// Fetches every active problem identifier in the vendored Registry Stack
// catalog and fails if any of them does not return HTTP 200. Wired as a
// post-deploy step in .github/workflows/deploy-cloudflare-workers.yml, run
// against the live host after each deployment.
//
// Reads src/upstream/catalog.v1.json, the vendored, digest-bound copy of
// registry-stack's products/identifiers/generated/catalog.v1.json pinned by
// src/upstream/source.json. Refresh that vendored copy with:
//
//   npm run import:catalog -- <path-to-registry-stack> --source-revision <full-commit>
//
// Override the host under test with IDENTIFIER_BASE_URL, the same variable
// scripts/smoke-live.mjs uses, so this can also run against a local build
// (for example a `python3 -m http.server` serving public/) for verification
// before it is wired to run against production.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const canonicalBaseUrl = 'https://id.registrystack.org';
const baseUrl = (
  process.env.IDENTIFIER_BASE_URL ?? canonicalBaseUrl
).replace(/\/$/, '');

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function problemPath(entry) {
  if (!entry.uri.startsWith(canonicalBaseUrl)) {
    throw new Error(`invalid problem identifier in vendored catalog: ${entry.uri}`);
  }
  return entry.uri.slice(canonicalBaseUrl.length);
}

async function checkOne(entry) {
  const url = `${baseUrl}${problemPath(entry)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return `${url} returned HTTP ${response.status}`;
    }
    return null;
  } catch (error) {
    return `${url} failed: ${error.message}`;
  }
}

const catalog = readJson('src/upstream/catalog.v1.json');
const problems = catalog.entries.filter(
  (entry) => entry.kind === 'problem' && entry.status === 'active',
);
if (problems.length === 0) {
  throw new Error('vendored upstream catalog has no active problem identifiers to check');
}

const results = await Promise.all(problems.map(checkOne));
const failures = results.filter((result) => result !== null);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  throw new Error(
    `${failures.length} of ${problems.length} catalog problem URIs did not return HTTP 200 on ${baseUrl}`,
  );
}

console.log(`all ${problems.length} catalog problem URIs returned HTTP 200 on ${baseUrl}`);
