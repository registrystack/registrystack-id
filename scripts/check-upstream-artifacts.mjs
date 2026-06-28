// Verifies the resolver's vendored JSON Schema and JSON-LD context artifacts
// stay structurally in sync with their source-of-truth copies in registry-stack.
//
// Two kinds of difference are intentional and ignored here:
//   * identifier re-homing -- each schema `$id` and the context `dg` namespace
//     prefix point at id.registrystack.org instead of the upstream host;
//   * sanitized prose -- internal authoring references are stripped from
//     `description` text.
// Everything else (properties, required, types, formats, @type/@container, the
// meta-schema `$schema`) must match exactly after normalization. Any other
// difference means the upstream artifact changed and the vendored copy must be
// re-synced.
//
// Usage: node scripts/check-upstream-artifacts.mjs [path-to-registry-stack]
//   Defaults to ../registry-stack (or $REGISTRY_STACK_DIR), matching
//   import-registry-stack-problems.mjs.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const upstreamArg = process.argv[2] ?? process.env.REGISTRY_STACK_DIR ?? '../registry-stack';
const upstreamRoot = resolve(repoRoot, upstreamArg);

// Resolver artifact (relative to the resolver root) -> upstream copy (relative
// to the registry-stack root). Keep this list in step with src/catalogs/*.json;
// the catalog cross-check below fails if an artifact is published without a pair.
const PAIRS = [
  {
    resolver: 'src/schemas/registry-relay/entity-record/v1.json',
    upstream: 'crates/registry-relay/resources/schemas/entity-record/v1.json',
  },
  {
    resolver: 'src/schemas/registry-relay/aggregate-result/v1.json',
    upstream: 'crates/registry-relay/resources/schemas/aggregate-result/v1.json',
  },
  {
    resolver: 'src/contexts/registry-relay/provenance/v1.jsonld',
    upstream: 'crates/registry-relay/resources/jsonld/provenance/v1/context.jsonld',
  },
];

let failed = false;
function fail(message) {
  console.error(message);
  failed = true;
}

// Recursively drop the intentionally-divergent fields so the comparison sees
// only the structural content that must stay in sync.
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description') continue; // prose is sanitized per artifact
      if (key === '$id' && typeof value === 'string') {
        out[key] = '<normalized-id>'; // schema identifier is re-homed
        continue;
      }
      if (key === 'dg' && typeof value === 'string' && /^https?:\/\//.test(value)) {
        out[key] = '<normalized-ns>'; // context namespace prefix is re-homed
        continue;
      }
      out[key] = normalize(value);
    }
    return out;
  }
  return node;
}

// Deterministic stringify with sorted keys so formatting and key order never
// trip the comparison.
function canonical(node) {
  if (Array.isArray(node)) return '[' + node.map(canonical).join(',') + ']';
  if (node && typeof node === 'object') {
    return (
      '{' +
      Object.keys(node)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(node[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(node);
}

// Collect human-readable paths where two normalized trees differ.
function diffPaths(a, b, path = '$', out = []) {
  const bothObjects = a && typeof a === 'object' && b && typeof b === 'object';
  if (!bothObjects || Array.isArray(a) !== Array.isArray(b)) {
    if (canonical(a) !== canonical(b)) {
      out.push(`${path}: resolver=${canonical(a)} upstream=${canonical(b)}`);
    }
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of [...keys].sort()) {
    const childPath = Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`;
    if (!(key in a)) {
      out.push(`${childPath}: missing in resolver (upstream=${canonical(b[key])})`);
    } else if (!(key in b)) {
      out.push(`${childPath}: missing in upstream (resolver=${canonical(a[key])})`);
    } else {
      diffPaths(a[key], b[key], childPath, out);
    }
  }
  return out;
}

function loadJson(absolutePath) {
  return JSON.parse(readFileSync(absolutePath, 'utf8'));
}

// 1. The upstream repo must be present; this check is meaningless without it.
if (!existsSync(upstreamRoot)) {
  console.error(`registry-stack not found at ${upstreamRoot}`);
  console.error('Pass its path as the first argument or set REGISTRY_STACK_DIR.');
  process.exit(1);
}

// 2. Every published schema/context must have a sync pair -- no silent gaps.
const catalogSources = [];
for (const catalog of ['src/catalogs/schemas.json', 'src/catalogs/contexts.json']) {
  const { entries } = loadJson(resolve(repoRoot, catalog));
  for (const entry of entries) catalogSources.push(entry.source);
}
const pairedSources = new Set(PAIRS.map((pair) => pair.resolver));
for (const source of catalogSources) {
  if (!pairedSources.has(source)) {
    fail(`no upstream sync pair for published artifact ${source} (add it to PAIRS)`);
  }
}

// 3. Compare each pair structurally.
let inSync = 0;
for (const pair of PAIRS) {
  const resolverPath = resolve(repoRoot, pair.resolver);
  const upstreamPath = resolve(upstreamRoot, pair.upstream);
  if (!existsSync(resolverPath)) {
    fail(`resolver artifact missing: ${pair.resolver}`);
    continue;
  }
  if (!existsSync(upstreamPath)) {
    fail(`upstream artifact missing: ${pair.upstream}`);
    continue;
  }
  const resolverNorm = normalize(loadJson(resolverPath));
  const upstreamNorm = normalize(loadJson(upstreamPath));
  if (canonical(resolverNorm) === canonical(upstreamNorm)) {
    inSync += 1;
    continue;
  }
  fail(`drift: ${pair.resolver} differs from ${pair.upstream}`);
  for (const line of diffPaths(resolverNorm, upstreamNorm)) {
    fail(`  ${line}`);
  }
}

if (failed) {
  console.error('upstream artifact check failed');
  process.exit(1);
}
console.log(`upstream artifacts in sync (${inSync}/${PAIRS.length} structurally identical)`);
