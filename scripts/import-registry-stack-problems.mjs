import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryStackDir = resolve(
  process.argv[2] ?? process.env.REGISTRY_STACK_DIR ?? '../registry-stack',
);
const errorsPath = resolve(
  registryStackDir,
  'docs/site/src/content/docs/reference/errors.mdx',
);
const overridesPath = resolve(repoRoot, 'src/catalogs/problem-overrides.json');
const outputPath = resolve(repoRoot, 'src/catalogs/problems.json');

const productSlug = new Map([
  ['Registry Notary', 'registry-notary'],
  ['Registry Relay', 'registry-relay'],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function codeToPath(code) {
  return code.replaceAll('.', '/');
}

function parseProblemRows(markdown) {
  let product = '';
  let section = '';
  const entries = [];

  for (const line of markdown.split(/\n/)) {
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      product = h2[1];
      section = '';
      continue;
    }

    const h3 = line.match(/^### (.+)$/);
    if (h3) {
      section = h3[1];
      continue;
    }

    const row = line.match(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/);
    if (!row || !productSlug.has(product)) {
      continue;
    }

    const code = row[1];
    entries.push({
      product: productSlug.get(product),
      code,
      path: codeToPath(code),
      title: row[2].trim(),
      description: row[3].trim(),
      category: section || undefined,
      source: 'registry-stack/docs/site/src/content/docs/reference/errors.mdx',
    });
  }

  return entries;
}

function mergeEntries(base, overrides) {
  const entries = [...base, ...overrides];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.product}/${entry.path}`;
    if (seen.has(key)) {
      throw new Error(`duplicate problem path ${key}`);
    }
    seen.add(key);
  }
  return entries.sort((a, b) => {
    const left = `${a.product}/${a.path}`;
    const right = `${b.product}/${b.path}`;
    return left.localeCompare(right);
  });
}

const markdown = readFileSync(errorsPath, 'utf8');
const overrides = readJson(overridesPath).entries;
const entries = mergeEntries(parseProblemRows(markdown), overrides);
const generated = {
  generated_from: 'registry-stack/docs/site/src/content/docs/reference/errors.mdx',
  generated_at: new Date(0).toISOString(),
  entries,
};

writeFileSync(outputPath, `${JSON.stringify(generated, null, 2)}\n`);
console.log(`wrote ${entries.length} problem identifiers to ${outputPath}`);
