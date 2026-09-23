import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
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

test('the build retains every digest-addressed artifact in source history', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'registrystack-id-build-'));
  try {
    execFileSync('node', ['scripts/build.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, OUTPUT_DIR: outputDir },
      stdio: 'pipe',
    });
    const sourceArtifacts = readdirSync(
      join(repoRoot, 'src', 'artifacts', 'sha256'),
    ).sort();
    const catalogFiles = ['schemas.json', 'contexts.json', 'profiles.json'];
    const historicalArtifacts = new Set();
    for (const catalogFile of catalogFiles) {
      const path = `src/catalogs/${catalogFile}`;
      const commits = execFileSync(
        'git',
        ['log', '--format=%H', '--', path],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim().split('\n').filter(Boolean);
      for (const commit of commits) {
        const document = JSON.parse(execFileSync(
          'git',
          ['show', `${commit}:${path}`],
          { cwd: repoRoot, encoding: 'utf8' },
        ));
        for (const entry of document.entries ?? []) {
          if (entry.artifact_sha256 && entry.source) {
            historicalArtifacts.add(
              `${entry.artifact_sha256}${extname(entry.source) || '.bin'}`,
            );
          }
        }
      }
    }
    for (const artifact of historicalArtifacts) {
      assert.ok(
        sourceArtifacts.includes(artifact),
        `historically published artifact is missing from source: ${artifact}`,
      );
    }
    const builtArtifacts = readdirSync(
      join(outputDir, 'artifacts', 'sha256'),
    ).sort();
    assert.deepEqual(builtArtifacts, sourceArtifacts);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

// Lists every built HTML page (except the 404 page, which the platform serves
// at arbitrary paths) with the request path it is served at: `dir/index.html`
// at `/dir/` and `page.html` at `/page.html`.
function htmlRoutes(outputDir, dir = '') {
  return readdirSync(join(outputDir, dir), { withFileTypes: true }).flatMap(
    (item) => {
      const path = dir ? `${dir}/${item.name}` : item.name;
      if (item.isDirectory()) return htmlRoutes(outputDir, path);
      if (!item.name.endsWith('.html') || path === '404.html') return [];
      return item.name === 'index.html'
        ? [`/${dir ? `${dir}/` : ''}`]
        : [`/${path}`];
    },
  );
}

// The catalog smoke compares published pages byte for byte, and the
// Cloudflare proxy rewrites HTML (for example to inject the Web Analytics
// beacon) unless the response forbids transformation.
test('every HTML page forbids proxy transformation', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'registrystack-id-build-'));
  try {
    execFileSync('node', ['scripts/build.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, OUTPUT_DIR: outputDir },
      stdio: 'pipe',
    });
    const rules = parseRules(readFileSync(join(outputDir, '_headers'), 'utf8'));
    const routes = htmlRoutes(outputDir);
    assert.ok(routes.length > 0, 'expected built HTML pages');
    for (const route of routes) {
      const values = rules
        .filter((rule) => patternToRegExp(rule.path).test(route))
        .map((rule) => rule.headers.get('Cache-Control'))
        .filter((value) => value !== undefined);
      assert.equal(values.length, 1, `expected one Cache-Control rule for ${route}, got ${JSON.stringify(values)}`);
      assert.match(values[0], /(^|, )no-transform(,|$)/, `${route} must forbid transformation`);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

// Cloudflare `_redirects` sources: a splat matches any run of characters,
// including none, and a placeholder matches one or more characters within a
// path segment.
function redirectSourceToRegExp(source) {
  const escaped = source
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/:[A-Za-z]\w*/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

// Redirects run before static assets, so a rule whose source matches a page
// route would hide that page.
test('no redirect rule shadows a built HTML page', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'registrystack-id-build-'));
  try {
    execFileSync('node', ['scripts/build.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, OUTPUT_DIR: outputDir },
      stdio: 'pipe',
    });
    const sources = readFileSync(join(outputDir, '_redirects'), 'utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((source) => source && !source.startsWith('#'));
    for (const route of htmlRoutes(outputDir)) {
      for (const source of sources) {
        assert.ok(
          !redirectSourceToRegExp(source).test(route),
          `${source} shadows the page at ${route}`,
        );
      }
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

const analyticsScript = '<script defer src="https://stats.registrystack.org/script.js" data-website-id="2a290fef-1670-4361-9d1e-d8961e9df5aa"></script>';

test('every HTML page loads the site analytics script once in its head', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'registrystack-id-build-'));
  try {
    execFileSync('node', ['scripts/build.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, OUTPUT_DIR: outputDir },
      stdio: 'pipe',
    });
    const pages = htmlRoutes(outputDir).map((route) =>
      route.endsWith('/') ? `${route}index.html` : route,
    );
    pages.push('/404.html');
    for (const page of pages) {
      const html = readFileSync(join(outputDir, page), 'utf8');
      const head = html.slice(0, html.indexOf('</head>'));
      assert.equal(html.split(analyticsScript).length - 1, 1, `${page} must load analytics once`);
      assert.ok(head.includes(analyticsScript), `${page} must load analytics in its head`);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
