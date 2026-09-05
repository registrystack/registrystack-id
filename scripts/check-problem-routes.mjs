// Confirms every problem identifier in the vendored Registry Stack catalog, and
// every artifact-backed identifier beside it, resolves to a route on the built
// site (public/), with no live network dependency. This reads
// src/upstream/catalog.v1.json, the vendored,
// digest-bound copy of registry-stack's
// products/identifiers/generated/catalog.v1.json pinned by
// src/upstream/source.json. Refresh that vendored copy with:
//
//   npm run import:catalog -- <path-to-registry-stack> --source-revision <full-commit>
//
// scripts/check.mjs separately proves src/catalogs/problems.json is the
// exact, unmodified set of problem entries from that same vendored catalog,
// and that public/ is byte-for-byte what scripts/build.mjs produces from the
// catalogs. This script closes the loop explicitly and by itself: it derives
// the expected route straight from the vendored upstream catalog, so it does
// not depend on that cross-check having already run.
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baseUrl = 'https://id.registrystack.org';

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

export function problemProductAndPath(entry) {
  const match = entry.uri.match(
    /^https:\/\/id\.registrystack\.org\/problems\/([^/]+)\/(.+)$/,
  );
  if (!match) {
    throw new Error(`invalid problem identifier in vendored catalog: ${entry.uri}`);
  }
  return { product: match[1], path: match[2] };
}

/**
 * The routes an identifier that publishes bytes owns on the built site: the
 * artifact at its canonical URI, the human page beside it, and the immutable
 * copy under the digest path. An identifier whose URI carries a file extension
 * keeps that extension for the artifact and takes an index page in a directory
 * named after it, so the two never claim the same path.
 */
export function identifierRoutes(entry) {
  if (!entry.uri.startsWith(`${baseUrl}/`)) {
    throw new Error(`identifier outside the resolver host: ${entry.uri}`);
  }
  const artifact = entry.uri.slice(`${baseUrl}/`.length);
  const extension = extname(artifact);
  const page = extension
    ? `${artifact.slice(0, -extension.length)}/index.html`
    : `${artifact}.html`;
  const artifactExtension = extname(entry.artifact.path) || '.bin';
  return {
    artifact,
    page,
    immutable: `artifacts/sha256/${entry.artifact.sha256}${artifactExtension}`,
  };
}

export function sameHttpStatuses(published, upstream) {
  const left = [...(published ?? [])].sort();
  const right = [...(upstream ?? [])].sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function checkProblemRoutes(publicDir) {
  const catalog = readJson('src/upstream/catalog.v1.json');
  const problems = catalog.entries.filter((entry) => entry.kind === 'problem');
  if (problems.length === 0) {
    throw new Error('vendored upstream catalog has no problem identifiers to check');
  }

  const routesByProduct = new Map();
  for (const entry of problems) {
    if (entry.status !== 'active') {
      throw new Error(`vendored upstream catalog contains a non-active problem: ${entry.uri}`);
    }
    const { product, path } = problemProductAndPath(entry);
    const htmlRoute = `problems/${product}/${path}/index.html`;
    const jsonRoute = `problems/${product}/${path}.json`;
    for (const route of [htmlRoute, jsonRoute]) {
      if (!existsSync(resolve(publicDir, route))) {
        throw new Error(
          `catalog problem URI has no built route: ${entry.uri} (missing ${route})`,
        );
      }
    }
    const record = JSON.parse(readFileSync(resolve(publicDir, jsonRoute), 'utf8'));
    if (record.id !== entry.uri) {
      throw new Error(`built route for ${entry.uri} publishes a different identifier: ${record.id}`);
    }
    if (record.code !== entry.problem.code) {
      throw new Error(`built route for ${entry.uri} publishes a different code: ${record.code}`);
    }
    if (!sameHttpStatuses(record.http_statuses, entry.problem.httpStatuses)) {
      throw new Error(`built route for ${entry.uri} publishes different HTTP statuses`);
    }
    if (!routesByProduct.has(product)) {
      routesByProduct.set(product, []);
    }
    routesByProduct.get(product).push(`${baseUrl}/problems/${product}/${path}`);
  }
  return { total: problems.length, routesByProduct };
}

export function checkIdentifierRoutes(publicDir) {
  const catalog = readJson('src/upstream/catalog.v1.json');
  const identifiers = catalog.entries.filter(
    (entry) => entry.kind !== 'problem' && entry.artifact,
  );
  const routesByKind = new Map();
  for (const entry of identifiers) {
    if (entry.status !== 'active') {
      throw new Error(
        `vendored upstream catalog contains a non-active identifier: ${entry.uri}`,
      );
    }
    const routes = identifierRoutes(entry);
    for (const route of [routes.artifact, routes.page, routes.immutable]) {
      if (!existsSync(resolve(publicDir, route))) {
        throw new Error(
          `catalog identifier has no built route: ${entry.uri} (missing ${route})`,
        );
      }
    }
    if (!routesByKind.has(entry.kind)) {
      routesByKind.set(entry.kind, []);
    }
    routesByKind.get(entry.kind).push(entry.uri);
  }
  return { total: identifiers.length, routesByKind };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const publicDir = resolve(repoRoot, process.env.OUTPUT_DIR ?? 'public');
  const { total, routesByProduct } = checkProblemRoutes(publicDir);
  for (const [product, routes] of [...routesByProduct.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    routes.sort((left, right) => left.localeCompare(right));
    console.log(`${product}: ${routes.length} problem route(s) resolved`);
    for (const route of routes) {
      console.log(`  ${route}`);
    }
  }
  console.log(
    `${total} catalog problem identifiers all resolve to routes on the built site`,
  );

  const identifiers = checkIdentifierRoutes(publicDir);
  for (const [kind, uris] of [...identifiers.routesByKind.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    uris.sort((left, right) => left.localeCompare(right));
    console.log(`${kind}: ${uris.length} artifact identifier(s) resolved`);
    for (const uri of uris) {
      console.log(`  ${uri}`);
    }
  }
  console.log(
    `${identifiers.total} catalog artifact identifiers all resolve to an artifact, a page, and an immutable copy`,
  );
}
