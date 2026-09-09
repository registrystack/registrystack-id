import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(repoRoot, process.env.OUTPUT_DIR ?? 'public');
const baseUrl = 'https://id.registrystack.org';
const docsBaseUrl = 'https://docs.registrystack.org';
const resolverAuthorityStatement =
  'This site publishes the current Registry Stack identifiers from a digest-bound source catalog. Product source and the actual service response remain authoritative for runtime behavior.';
const problemAuthorityStatement =
  'For problem responses, use the stable code extension and the response status/detail fields. Do not parse URL paths for program logic.';

const documentation = {
  docsHome: {
    title: 'Registry Stack documentation',
    href: `${docsBaseUrl}/`,
  },
  errorReference: {
    title: 'Error and status code reference',
    href: `${docsBaseUrl}/reference/errors/`,
  },
  contractsReference: {
    title: 'Contracts and machine identifiers',
    href: `${docsBaseUrl}/reference/contracts/`,
  },
  relayProduct: {
    title: 'Registry Relay product docs',
    href: `${docsBaseUrl}/products/registry-relay/`,
  },
  relayApi: {
    title: 'Registry Relay API overview',
    href: `${docsBaseUrl}/reference/apis/registry-relay/`,
  },
  manifestProduct: {
    title: 'Registry Manifest product docs',
    href: `${docsBaseUrl}/products/registry-manifest/`,
  },
};

const productDocumentation = new Map([
  ['registry-relay', [documentation.relayProduct, documentation.relayApi]],
  ['registry-manifest', [documentation.manifestProduct]],
]);

// Identifiers that publish bytes at their canonical URI. The noun names the
// artifact in prose, and the content type is what the resolver serves for that
// URI.
const artifactKinds = {
  schema: {
    noun: 'JSON Schema',
    contentType: 'application/schema+json; charset=utf-8',
  },
  context: {
    noun: 'JSON-LD context',
    contentType: 'application/ld+json; charset=utf-8',
  },
  profile: {
    noun: 'profile document',
    contentType: 'text/markdown; charset=utf-8',
  },
};

const kindLabels = {
  problem: 'Problem type',
  namespace: 'Namespace',
  schema: 'JSON Schema',
  context: 'JSON-LD context',
  profile: 'Response profile',
  vocabulary: 'Vocabulary',
  'vocabulary-term': 'Vocabulary term',
};

// The catalogs are this site's primary navigation, in masthead and footer.
const siteCatalogs = [
  { key: 'problems', href: '/problems/', label: 'Problems', title: 'Problem types' },
  { key: 'namespaces', href: '/namespaces/', label: 'Namespaces', title: 'Namespaces' },
  { key: 'schemas', href: '/schemas/', label: 'Schemas', title: 'Schemas' },
  { key: 'contexts', href: '/contexts/', label: 'Contexts', title: 'Contexts' },
  { key: 'profiles', href: '/profiles/', label: 'Profiles', title: 'Profiles' },
  { key: 'vocabularies', href: '/vocabularies/', label: 'Vocabularies', title: 'Vocabularies' },
];

// Presentational assets are publisher-owned machinery, not identifiers. The
// stylesheet is served under a content-hashed name so it can cache like the
// immutable artifacts while the HTML that references it stays exact-source.
const siteAssetsDir = 'src/assets';
const siteCss = readFileSync(resolve(repoRoot, siteAssetsDir, 'site.css'));
const siteCssPath = `assets/site.${createHash('sha256').update(siteCss).digest('hex').slice(0, 16)}.css`;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function mkdirFor(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function writeOutput(path, content) {
  const target = resolve(outputDir, path);
  mkdirFor(target);
  writeFileSync(target, content);
}

function copyOutput(source, target) {
  const sourcePath = resolve(repoRoot, source);
  const targetPath = resolve(outputDir, target);
  mkdirFor(targetPath);
  cpSync(sourcePath, targetPath);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function normalizeLink(link) {
  if (typeof link === 'string') {
    return { title: link, href: link };
  }
  return link;
}

function uniqueLinks(links) {
  const seen = new Set();
  const result = [];
  for (const link of links.map(normalizeLink)) {
    if (!link?.href || seen.has(link.href)) {
      continue;
    }
    seen.add(link.href);
    result.push(link);
  }
  return result;
}

function documentationForProduct(product) {
  return productDocumentation.get(product) ?? [];
}

function productForEntry(entry) {
  const text = [entry.product, entry.id, entry.uri].filter(Boolean).join(' ');
  for (const product of productDocumentation.keys()) {
    if (text.includes(product)) {
      return product;
    }
  }
  return entry.product;
}

function documentationForProblem(entry) {
  return uniqueLinks([
    documentation.errorReference,
    ...documentationForProduct(entry.product),
    ...(entry.documented_by ?? []),
  ]);
}

function documentationForIdentifier(entry) {
  const product = productForEntry(entry);
  return uniqueLinks([
    documentation.contractsReference,
    ...documentationForProduct(product),
    ...(entry.documented_by ?? []),
    documentation.docsHome,
  ]);
}

function sourceReference(source) {
  if (!source) {
    return null;
  }
  if (source.startsWith('registry-stack/')) {
    return {
      repository: 'registry-stack',
      path: source.slice('registry-stack/'.length),
      label: source,
    };
  }
  return {
    label: source,
  };
}

function sourceReferenceForEntry(entry) {
  return entry.source_reference ?? sourceReference(entry.source);
}

function publicDocSource(source) {
  // Only sources that live in the public documentation tree are exposed in
  // published records. Internal component, spec, and fixture labels stay in the
  // source catalog for maintainers but are omitted from public output.
  return source && source.startsWith('registry-stack/docs/') ? source : undefined;
}

function authorityRecord(extraStatement) {
  return {
    scope: 'identifier metadata',
    statement: extraStatement
      ? `${resolverAuthorityStatement} ${extraStatement}`
      : resolverAuthorityStatement,
  };
}

function problemGuidance(entry) {
  return {
    status: entry.guidance_status ?? 'not_published',
    retryable: entry.retryable ?? null,
    caller_action: entry.caller_action ?? null,
    operator_action: entry.operator_action ?? null,
    note:
      entry.guidance_note ??
      'No per-identifier remediation guidance is published in this resolver record.',
  };
}

function renderLinks(links) {
  if (!links.length) {
    return '<p class="muted">No public documentation link is published for this identifier yet.</p>';
  }
  return `<ul class="doc-list">
${links
  .map(
    (link) =>
      `      <li><a href="${escapeHtml(link.href)}">${escapeHtml(link.title)}</a></li>`,
  )
  .join('\n')}
    </ul>`;
}

function notPublished() {
  return '<span class="muted">not published</span>';
}

function renderFacts(items) {
  return `<table class="facts">
      <tbody>
${items
  .filter((item) => {
    const value = item.html ?? item.value;
    return value !== undefined && value !== null && value !== '';
  })
  .map(
    (item) =>
      `        <tr><th>${escapeHtml(item.label)}</th><td>${item.html ?? escapeHtml(item.value)}</td></tr>`,
  )
  .join('\n')}
      </tbody>
    </table>`;
}

function renderGuidance(guidance) {
  const rows = [
    { label: 'Guidance status', value: guidance.status },
    { label: 'Retryable', html: guidance.retryable === null ? notPublished() : String(guidance.retryable) },
    { label: 'Caller action', html: guidance.caller_action ? escapeHtml(guidance.caller_action) : notPublished() },
    { label: 'Operator action', html: guidance.operator_action ? escapeHtml(guidance.operator_action) : notPublished() },
    { label: 'Note', value: guidance.note },
  ];
  return renderFacts(rows);
}

function statusChip(status) {
  return `<span class="status">${escapeHtml(status)}</span>`;
}

function siteHeader(current) {
  const nav = siteCatalogs
    .map(
      (catalog) =>
        `    <a href="${catalog.href}"${current === catalog.key ? ' aria-current="page"' : ''}>${catalog.label}</a>`,
    )
    .join('\n');
  return `<header class="site-header">
  <a class="brand" href="https://registrystack.org/">
    <span class="brand-mark" aria-hidden="true">RS</span>
    <span>Registry Stack<span class="brand-site">Identifiers</span></span>
  </a>
  <nav class="top-nav" aria-label="Identifier catalogs">
${nav}
    <a class="nav-emphasis" href="${documentation.docsHome.href}">Documentation</a>
  </nav>
</header>`;
}

function siteFooter() {
  const catalogLinks = siteCatalogs
    .map(
      (catalog) =>
        `        <li><a href="${catalog.href}">${catalog.title}</a></li>`,
    )
    .join('\n');
  return `<footer class="site-footer">
  <div class="site-footer-inner">
    <div class="footer-brand">
      <a class="footer-brand-name" href="https://registrystack.org/">Registry Stack</a>
      <p>Stable machine identifiers for Registry Stack products, published from a digest-bound source catalog.</p>
    </div>
    <nav class="footer-nav" aria-label="Footer">
      <div class="footer-col">
        <p class="footer-col-title">Catalogs</p>
        <ul>
${catalogLinks}
        </ul>
      </div>
      <div class="footer-col">
        <p class="footer-col-title">Registry Stack</p>
        <ul>
          <li><a href="https://registrystack.org/">Main website</a></li>
          <li><a href="${documentation.docsHome.href}">Documentation</a></li>
          <li><a href="https://github.com/registrystack/registry-stack">GitHub</a></li>
        </ul>
      </div>
    </nav>
  </div>
  <div class="site-footer-base">
    <p>Machine index: <a href="/index.json">index.json</a> &middot; <a href="/llms.txt">llms.txt</a></p>
    <p><a href="https://registrystack.org/">registrystack.org</a></p>
  </div>
</footer>`;
}

function hero({ eyebrow, title, lede, uri }) {
  const uriChip = uri ? `\n    <p><code class="hero-uri">${escapeHtml(uri)}</code></p>` : '';
  return `<section class="hero">
  <div class="hero-inner">
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="hero-lead">${escapeHtml(lede)}</p>${uriChip}
  </div>
</section>`;
}

function page(title, { description, current, body }) {
  const siteName = 'Registry Stack identifiers';
  const fullTitle = title === siteName ? siteName : `${title} | ${siteName}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="noindex">
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/${siteCssPath}">
</head>
<body>
${siteHeader(current)}
${body}
${siteFooter()}
</body>
</html>
`;
}

function json(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function uriToPath(uri) {
  if (!uri.startsWith(baseUrl)) {
    throw new Error(`identifier outside base URL: ${uri}`);
  }
  return uri.slice(baseUrl.length).replace(/^\//, '').replace(/#$/, '');
}

function problemUri(entry) {
  return `${baseUrl}/problems/${entry.product}/${entry.path}`;
}

function problemRecord(entry) {
  const uri = problemUri(entry);
  const source = publicDocSource(entry.source);
  return {
    id: uri,
    type: uri,
    kind: 'problem',
    lifecycle_status: entry.status,
    compatibility_line: entry.compatibility_line,
    product: entry.product,
    code: entry.code,
    title: entry.title,
    summary: entry.description,
    description: entry.description,
    category: entry.category ?? null,
    http_statuses: entry.http_statuses ?? null,
    guidance: problemGuidance(entry),
    documented_by: documentationForProblem(entry),
    authority: authorityRecord(problemAuthorityStatement),
    identifier_policy: {
      stability: 'stable',
      programmatic_key: 'code',
      parsing: 'Do not parse semantics from the URL path.',
    },
    source,
    source_reference: sourceReferenceForEntry(entry),
  };
}

function writeProblem(entry) {
  const uri = problemUri(entry);
  const record = problemRecord(entry);
  const docs = documentationForProblem(entry);
  const body = `${hero({
      eyebrow: `Problem type · ${entry.product}`,
      title: entry.title,
      lede: entry.description,
      uri,
    })}
<div class="record">
    <section class="notice" aria-labelledby="authority">
      <p class="notice-title" id="authority">Authority boundary</p>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
      <p>${escapeHtml(problemAuthorityStatement)}</p>
    </section>
    <section aria-labelledby="facts">
      <h2 id="facts">Defined facts</h2>
${renderFacts([
  { label: 'Canonical URI', html: `<code>${escapeHtml(uri)}</code>` },
  { label: 'Kind', value: 'problem' },
  { label: 'Lifecycle status', html: statusChip(entry.status) },
  { label: 'Compatibility line', value: entry.compatibility_line },
  { label: 'Product', value: entry.product },
  { label: 'Code', html: `<code>${escapeHtml(entry.code)}</code>` },
  { label: 'Category', html: entry.category ? escapeHtml(entry.category) : notPublished() },
  { label: 'HTTP statuses', value: entry.http_statuses?.join(', ') ?? 'not published in this resolver record' },
  { label: 'Source', value: publicDocSource(entry.source) },
])}
    </section>
    <section aria-labelledby="documentation">
      <h2 id="documentation">Documentation</h2>
${renderLinks(docs)}
    </section>
    <section aria-labelledby="guidance">
      <h2 id="guidance">Guidance</h2>
${renderGuidance(record.guidance)}
    </section>
    <section aria-labelledby="record">
      <h2 id="record">Problem record</h2>
      <pre><code>${escapeHtml(JSON.stringify(record, null, 2))}</code></pre>
      <p class="machine-link"><a href="${escapeHtml(uri)}.json">Machine-readable JSON</a></p>
    </section>
</div>`;

  writeOutput(
    `problems/${entry.product}/${entry.path}/index.html`,
    page(entry.title, { description: entry.description, current: 'problems', body }),
  );
  writeOutput(`problems/${entry.product}/${entry.path}.json`, json(record));
}

function writeCatalogIndex(name, entries, makeUri) {
  const rows = entries
    .map((entry) => {
      const uri = makeUri(entry);
      return `<tr><td class="cell-uri"><a href="${escapeHtml(uri)}">${escapeHtml(uri)}</a></td><td>${escapeHtml(entry.title)}</td><td>${statusChip(entry.status)}</td></tr>`;
    })
    .join('\n');
  const body = `${hero({
      eyebrow: 'Catalog',
      title: name,
      lede: 'Stable Registry Stack identifiers.',
    })}
<div class="record">
    <section class="notice" aria-labelledby="authority">
      <p class="notice-title" id="authority">Authority boundary</p>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <section aria-labelledby="catalog">
      <h2 id="catalog">${entries.length} published identifiers</h2>
      <table class="catalog">
      <thead><tr><th>Identifier</th><th>Title</th><th>Status</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    </section>
</div>`;
  writeOutput(
    `${name.toLowerCase().replaceAll(' ', '-')}/index.html`,
    page(name, {
      description: `Stable Registry Stack ${name.toLowerCase()} identifiers.`,
      current: name.toLowerCase().replaceAll(' ', '-'),
      body,
    }),
  );
}

function identifierRecord(entry) {
  const record = {
    ...entry,
    id: entry.id ?? entry.uri,
    documented_by: documentationForIdentifier(entry),
    authority: authorityRecord(),
    source_reference: sourceReferenceForEntry(entry),
  };
  if (entry.uri === `${baseUrl}/vocab/core/`) {
    record.child_term_policy = {
      ownership: 'adopter-defined',
      registry_reviewed: false,
      statement:
        'Resolving a child URI under this vocabulary does not register or review that adopter-defined term.',
    };
  }
  return record;
}

function catalogKeyForUri(uri) {
  const segment = uriToPath(uri).split('/')[0];
  return siteCatalogs.some((catalog) => catalog.key === segment) ? segment : undefined;
}

function writeIdentifier(entry) {
  const path = uriToPath(entry.uri);
  const recordPath = path.endsWith('/') ? `${path}index.json` : `${path}.json`;
  const record = identifierRecord(entry);
  const body = `${hero({
      eyebrow: kindLabels[entry.kind] ?? entry.kind,
      title: entry.title,
      lede: entry.description,
      uri: entry.uri,
    })}
<div class="record">
    <section class="notice" aria-labelledby="authority">
      <p class="notice-title" id="authority">Authority boundary</p>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <section aria-labelledby="lifecycle">
      <h2 id="lifecycle">Lifecycle</h2>
${renderFacts([
  { label: 'Kind', value: kindLabels[entry.kind] ?? entry.kind },
  { label: 'Status', html: statusChip(entry.status) },
  { label: 'Compatibility line', value: entry.compatibility_line },
  { label: 'Owner', value: entry.owner },
  {
    label: 'Child terms',
    value:
      record.child_term_policy?.ownership === 'adopter-defined'
        ? 'Adopter-defined; successful resolution is not Registry Stack registration or review.'
        : undefined,
  },
])}
    </section>
    <section aria-labelledby="documentation">
      <h2 id="documentation">Documentation</h2>
${renderLinks(record.documented_by)}
    </section>
    <section aria-labelledby="record">
      <h2 id="record">Identifier record</h2>
      <pre><code>${escapeHtml(JSON.stringify(record, null, 2))}</code></pre>
      <p class="machine-link"><a href="${escapeHtml(`${baseUrl}/${recordPath}`)}">Machine-readable JSON</a></p>
    </section>
</div>`;
  writeOutput(
    `${path}/index.html`,
    page(entry.title, {
      description: entry.description,
      current: catalogKeyForUri(entry.uri),
      body,
    }),
  );
  writeOutput(recordPath, json(record));
}

// An identifier that carries a file extension publishes its artifact under that
// name and its page as an index inside a directory beside it. One without an
// extension keeps the bare path for the artifact and takes the .html path for
// the page, so the two never claim the same name.
function artifactPagePath(path) {
  const extension = extname(path);
  return extension
    ? `${path.slice(0, -extension.length)}/index.html`
    : `${path}.html`;
}

function writeArtifactIdentifier(entry) {
  const { noun } = artifactKinds[entry.kind];
  const path = uriToPath(entry.uri);
  copyOutput(entry.source, path);
  if (entry.immutable_uri) {
    copyOutput(entry.source, uriToPath(entry.immutable_uri));
  }
  const docs = documentationForIdentifier(entry);
  const body = `${hero({
      eyebrow: kindLabels[entry.kind] ?? entry.kind,
      title: entry.title,
      lede: entry.description,
      uri: entry.uri,
    })}
<div class="record">
    <section class="notice" aria-labelledby="authority">
      <p class="notice-title" id="authority">Authority boundary</p>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
      <p>The canonical machine artifact at this URI is the ${escapeHtml(noun)} itself.</p>
    </section>
    <section aria-labelledby="lifecycle">
      <h2 id="lifecycle">Lifecycle</h2>
${renderFacts([
  { label: 'Status', html: statusChip(entry.status) },
  { label: 'Compatibility line', value: entry.compatibility_line },
  { label: 'Owner', value: entry.owner },
  { label: 'Artifact SHA-256', html: entry.artifact_sha256 ? `<code>${escapeHtml(entry.artifact_sha256)}</code>` : undefined },
  { label: 'Immutable artifact', html: entry.immutable_uri ? `<a href="${escapeHtml(entry.immutable_uri)}">${escapeHtml(entry.immutable_uri)}</a>` : undefined },
])}
    </section>
    <section aria-labelledby="documentation">
      <h2 id="documentation">Documentation</h2>
${renderLinks(docs)}
      <p class="machine-link"><a href="${escapeHtml(entry.uri)}">${escapeHtml(noun)}</a></p>
    </section>
</div>`;
  writeOutput(
    artifactPagePath(path),
    page(entry.title, {
      description: entry.description,
      current: catalogKeyForUri(entry.uri),
      body,
    }),
  );
}

// Cloudflare Pages `*` in a `_headers` path matches any run of characters,
// including further path segments.
function headerPathPattern(path) {
  const escaped = path
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function writeStaticControls(artifactEntries) {
  const staticHeaders = [
    {
      path: 'index.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'problems/*.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'namespaces/index.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'contexts/index.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'profiles/index.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'vocabularies/*.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'vocab/*.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'llms.txt',
      contentType: 'text/plain; charset=utf-8',
      cache: 'public, max-age=300',
    },
    {
      path: 'ns/*.json',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=86400',
    },
    {
      path: 'schemas/*.json',
      contentType: 'application/schema+json; charset=utf-8',
      cache: 'public, max-age=86400',
    },
    {
      path: 'contexts/*.jsonld',
      contentType: 'application/ld+json; charset=utf-8',
      cache: 'public, max-age=86400',
    },
    {
      path: '.well-known/registrystack-identifiers',
      contentType: 'application/json; charset=utf-8',
      cache: 'public, max-age=300',
    },
  ];
  // Cloudflare Pages combines every rule that matches a path and joins
  // repeated header values, so a path already covered by a static rule with
  // the same headers must not also get an exact rule, or the response would
  // carry that header twice (e.g. `Access-Control-Allow-Origin: *, *`).
  function coveredByStaticRule(path, contentType, cache) {
    return staticHeaders.some(
      (rule) =>
        rule.contentType === contentType &&
        rule.cache === cache &&
        headerPathPattern(rule.path).test(path),
    );
  }

  const machineHeaders = [...staticHeaders];
  // Every published artifact names its own content type: the canonical URI
  // serves the kind's artifact, and the digest path serves the same bytes
  // forever, so neither can rely on a wildcard that assumes JSON.
  for (const entry of artifactEntries) {
    const path = uriToPath(entry.uri);
    const contentType = artifactKinds[entry.kind].contentType;
    const cache = 'public, max-age=86400';
    if (!coveredByStaticRule(path, contentType, cache)) {
      machineHeaders.push({ path, contentType, cache });
    }
    if (!entry.immutable_uri) {
      continue;
    }
    // The digest path serves the same bytes as the canonical URI, so it
    // carries the same content type; the file extension only names the copy.
    const immutablePath = uriToPath(entry.immutable_uri);
    const immutableCache = 'public, max-age=31536000, immutable';
    if (!coveredByStaticRule(immutablePath, contentType, immutableCache)) {
      machineHeaders.push({ path: immutablePath, contentType, cache: immutableCache });
    }
  }

  const exactHeaders = machineHeaders
    .map((entry) => `/${entry.path}
  Content-Type: ${entry.contentType}
  Access-Control-Allow-Origin: *
  Cache-Control: ${entry.cache}`)
    .join('\n\n');

  writeOutput('_headers', `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

/assets/*
  Cache-Control: public, max-age=86400

${exactHeaders}
`);
  writeOutput('_redirects', `/problem-types/* /problems/:splat 301
/vocab/core/* /vocabularies/core.json 200
/.well-known/registrystack-identifiers /index.json 200
`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const problems = readJson('src/catalogs/problems.json').entries;
const namespaces = readJson('src/catalogs/namespaces.json').entries;
const schemas = readJson('src/catalogs/schemas.json').entries;
const contexts = readJson('src/catalogs/contexts.json').entries;
const profiles = readJson('src/catalogs/profiles.json').entries;
const vocabularies = readJson('src/catalogs/vocabularies.json').entries;
const vocabularyTerms = readJson('src/catalogs/vocabulary-terms.json').entries;

const artifactIdentifiers = [...schemas, ...contexts, ...profiles];

for (const entry of problems) writeProblem(entry);
for (const entry of namespaces) writeIdentifier(entry);
for (const entry of artifactIdentifiers) writeArtifactIdentifier(entry);
for (const entry of vocabularies) writeIdentifier(entry);
for (const entry of vocabularyTerms) writeIdentifier(entry);

writeCatalogIndex('Problems', problems, problemUri);
writeCatalogIndex('Namespaces', namespaces, (entry) => entry.uri.replace(/#$/, ''));
writeCatalogIndex('Schemas', schemas, (entry) => entry.uri);
writeCatalogIndex('Contexts', contexts, (entry) => entry.uri);
writeCatalogIndex('Profiles', profiles, (entry) => entry.uri);
writeCatalogIndex(
  'Vocabularies',
  [...vocabularies, ...vocabularyTerms],
  (entry) => entry.uri,
);

writeOutput('problems/index.json', json({ entries: problems.map(problemRecord) }));
writeOutput('namespaces/index.json', json({ entries: namespaces.map(identifierRecord) }));
writeOutput('schemas/index.json', json({ entries: schemas.map(identifierRecord) }));
writeOutput('contexts/index.json', json({ entries: contexts.map(identifierRecord) }));
writeOutput('profiles/index.json', json({ entries: profiles.map(identifierRecord) }));
writeOutput('vocabularies/index.json', json({
  entries: [...vocabularies, ...vocabularyTerms].map(identifierRecord),
}));
const coreVocabulary = vocabularies.find(
  (entry) => entry.uri === `${baseUrl}/vocab/core/`,
);
if (!coreVocabulary) {
  throw new Error('Registry Relay core vocabulary is missing');
}
writeOutput('vocabularies/core.json', json(identifierRecord(coreVocabulary)));
writeOutput('index.json', json({
  base_url: baseUrl,
  authority: authorityRecord(),
  documentation: {
    home: documentation.docsHome.href,
    error_reference: documentation.errorReference.href,
    llms: `${docsBaseUrl}/llms.txt`,
    full_corpus: `${docsBaseUrl}/llms-full.txt`,
  },
  catalogs: {
    problems: `${baseUrl}/problems/index.json`,
    namespaces: `${baseUrl}/namespaces/index.json`,
    schemas: `${baseUrl}/schemas/index.json`,
    contexts: `${baseUrl}/contexts/index.json`,
    profiles: `${baseUrl}/profiles/index.json`,
    vocabularies: `${baseUrl}/vocabularies/index.json`,
  },
}));
function writeSiteAssets() {
  writeOutput(siteCssPath, siteCss);
  copyOutput(`${siteAssetsDir}/favicon.svg`, 'assets/favicon.svg');
  // The OFL license texts stay in the repository beside the fonts they cover;
  // only the font binaries are served.
  const fontsDir = resolve(repoRoot, siteAssetsDir, 'fonts');
  for (const name of readdirSync(fontsDir).sort()) {
    if (name.endsWith('.woff2')) {
      copyOutput(`${siteAssetsDir}/fonts/${name}`, `assets/fonts/${name}`);
    }
  }
}

const catalogBlurbs = {
  problems: 'RFC 9457 problem type URIs with a stable code for programmatic branching.',
  namespaces: 'JSON-LD namespace declarations.',
  schemas: 'JSON Schema documents, published at their canonical URI.',
  contexts: 'JSON-LD contexts, published at their canonical URI.',
  profiles: 'Response profile documents, published at their canonical URI.',
  vocabularies: 'Governed vocabularies and their vocabulary terms.',
};

const catalogCounts = {
  problems: problems.length,
  namespaces: namespaces.length,
  schemas: schemas.length,
  contexts: contexts.length,
  profiles: profiles.length,
  vocabularies: vocabularies.length + vocabularyTerms.length,
};

const homeBody = `${hero({
    eyebrow: 'id.registrystack.org',
    title: 'Registry Stack identifiers',
    lede: 'Stable machine identifiers for Registry Stack problem types, namespaces, vocabularies, schemas, contexts, and profiles.',
  })}
<div class="record">
    <section class="notice" aria-labelledby="authority">
      <p class="notice-title" id="authority">Authority boundary</p>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <section aria-labelledby="catalogs">
      <h2 id="catalogs">Catalogs</h2>
      <div class="catalog-grid">
${siteCatalogs
  .map(
    (catalog) => `        <article>
          <h3><a href="${catalog.href}">${catalog.title}</a></h3>
          <p class="catalog-count">${catalogCounts[catalog.key]} identifiers</p>
          <p>${escapeHtml(catalogBlurbs[catalog.key])}</p>
        </article>`,
  )
  .join('\n')}
      </div>
    </section>
</div>`;
writeOutput(
  'index.html',
  page('Registry Stack identifiers', {
    description:
      'Stable machine identifiers for Registry Stack problem types, namespaces, vocabularies, schemas, contexts, and profiles.',
    body: homeBody,
  }),
);
writeOutput('404.html', page('Identifier not found', {
  description: 'This path is not a registered Registry Stack identifier.',
  body: `${hero({
      eyebrow: 'Not found',
      title: 'Identifier not found',
      lede: 'This path is not a registered Registry Stack identifier.',
    })}
<div class="record">
    <section class="notice" aria-labelledby="authority">
      <p class="notice-title" id="authority">Authority boundary</p>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <section aria-labelledby="catalogs">
      <h2 id="catalogs">Browse the published identifiers</h2>
      <ul class="doc-list">
${siteCatalogs
  .map(
    (catalog) =>
      `        <li><a href="${catalog.href}">${catalog.title}</a></li>`,
  )
  .join('\n')}
      </ul>
    </section>
</div>`,
}));
writeOutput('llms.txt', `# Registry Stack identifier resolver

Canonical host: ${baseUrl}/

This host resolves stable Registry Stack identifiers for problem types, JSON-LD namespaces and vocabularies, JSON Schemas, JSON-LD contexts, and response profiles.

Authority boundary: ${resolverAuthorityStatement}

For RFC 9457 problem responses, use the stable code extension and the response status/detail fields. Do not parse URL paths for program logic.

Machine catalogs:

- ${baseUrl}/index.json
- ${baseUrl}/problems/index.json
- ${baseUrl}/schemas/index.json
- ${baseUrl}/namespaces/index.json
- ${baseUrl}/contexts/index.json
- ${baseUrl}/profiles/index.json
- ${baseUrl}/vocabularies/index.json

Public documentation:

- ${documentation.docsHome.href}
- ${documentation.errorReference.href}
- ${docsBaseUrl}/llms.txt
- ${docsBaseUrl}/llms-full.txt
`);
writeSiteAssets();
writeStaticControls(artifactIdentifiers);

console.log(`built ${relative(process.cwd(), outputDir)}`);
