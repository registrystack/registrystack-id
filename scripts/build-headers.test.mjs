import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Runs the real build into a scratch output directory and returns the
// generated `_headers` file contents.
function buildHeaders() {
  const outputDir = mkdtempSync(join(tmpdir(), 'registrystack-id-build-'));
  try {
    execFileSync('node', ['scripts/build.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, OUTPUT_DIR: outputDir },
      stdio: 'pipe',
    });
    return readFileSync(join(outputDir, '_headers'), 'utf8');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

// Parses `_headers` blocks (Cloudflare Pages format) into { path, headers }
// entries, where headers is a Map from header name to value.
function parseRules(headersText) {
  return headersText
    .trim()
    .split('\n\n')
    .map((block) => {
      const [path, ...headerLines] = block.split('\n');
      const headers = new Map();
      for (const line of headerLines) {
        const [name, ...rest] = line.trim().split(': ');
        headers.set(name, rest.join(': '));
      }
      return { path, headers };
    });
}

// Cloudflare Pages `*` in a `_headers` path matches any run of characters,
// including further path segments.
function patternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

test('_headers rules do not set a duplicated header name for any concrete path', () => {
  const rules = parseRules(buildHeaders());
  const concretePaths = rules
    .map((rule) => rule.path)
    .filter((path) => !path.includes('*'));
  for (const path of concretePaths) {
    const matchingRules = rules.filter((rule) =>
      patternToRegExp(rule.path).test(path),
    );
    const valuesByHeaderName = new Map();
    for (const rule of matchingRules) {
      for (const [name, value] of rule.headers) {
        const values = valuesByHeaderName.get(name) ?? [];
        values.push(value);
        valuesByHeaderName.set(name, values);
      }
    }
    for (const [name, values] of valuesByHeaderName) {
      assert.equal(
        values.length,
        1,
        `expected exactly one matching rule to set ${name} for ${path}, got ${JSON.stringify(values)}`,
      );
    }
  }
});

// Returns the Content-Type that the `_headers` rules serve for one concrete
// path. The duplicated-header test above guarantees a single matching value.
function contentTypeFor(rules, path) {
  const values = rules
    .filter((rule) => patternToRegExp(rule.path).test(path))
    .map((rule) => rule.headers.get('Content-Type'))
    .filter((value) => value !== undefined);
  assert.equal(values.length, 1, `expected one Content-Type rule for ${path}, got ${JSON.stringify(values)}`);
  return values[0];
}

test('an immutable artifact copy serves the same content type as its canonical URI', () => {
  const rules = parseRules(buildHeaders());
  const catalogs = ['schemas', 'contexts', 'profiles'];
  let checked = 0;
  for (const catalog of catalogs) {
    const { entries } = JSON.parse(readFileSync(join(repoRoot, 'src', 'catalogs', `${catalog}.json`), 'utf8'));
    for (const entry of entries.filter((candidate) => candidate.immutable_uri)) {
      const canonical = contentTypeFor(rules, new URL(entry.uri).pathname);
      const immutable = contentTypeFor(rules, new URL(entry.immutable_uri).pathname);
      assert.equal(immutable, canonical, `${entry.immutable_uri} must serve the ${entry.kind} content type`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'expected at least one immutable artifact copy in the catalogs');
});
