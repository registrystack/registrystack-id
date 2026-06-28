import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(repoRoot, process.env.OUTPUT_DIR ?? 'public');
const baseUrl = 'https://id.registrystack.org';
const docsBaseUrl = 'https://docs.registrystack.org';
const resolverAuthorityStatement =
  'This site identifies stable Registry Stack identifiers and links to public documentation. Product documentation, published schemas, and the actual service response remain authoritative for runtime behavior.';
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
  notaryProduct: {
    title: 'Registry Notary product docs',
    href: `${docsBaseUrl}/products/registry-notary/`,
  },
  notaryApi: {
    title: 'Registry Notary API overview',
    href: `${docsBaseUrl}/reference/apis/registry-notary/`,
  },
  manifestProduct: {
    title: 'Registry Manifest product docs',
    href: `${docsBaseUrl}/products/registry-manifest/`,
  },
};

const productDocumentation = new Map([
  ['registry-relay', [documentation.relayProduct, documentation.relayApi]],
  ['registry-notary', [documentation.notaryProduct, documentation.notaryApi]],
  ['registry-manifest', [documentation.manifestProduct]],
]);

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
    return '<p>No public documentation link is published for this identifier yet.</p>';
  }
  return `<ul>
${links
  .map(
    (link) =>
      `      <li><a href="${escapeHtml(link.href)}">${escapeHtml(link.title)}</a></li>`,
  )
  .join('\n')}
    </ul>`;
}

function renderFacts(items) {
  return `<table>
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
    { label: 'Retryable', value: guidance.retryable === null ? 'not published' : String(guidance.retryable) },
    { label: 'Caller action', value: guidance.caller_action ?? 'not published' },
    { label: 'Operator action', value: guidance.operator_action ?? 'not published' },
    { label: 'Note', value: guidance.note },
  ];
  return renderFacts(rows);
}

function page(title, body) {
  const siteName = 'Registry Stack identifiers';
  const fullTitle = title === siteName ? siteName : `${title} | ${siteName}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 2rem; line-height: 1.55; max-width: 62rem; }
    main { display: grid; gap: 1rem; }
    h1 { margin: 0; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.05; }
    h2 { margin-top: 2rem; }
    p { margin-block: 0.5rem; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
    pre { overflow: auto; padding: 1rem; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
    a { color: LinkText; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent); padding: 0.5rem; text-align: left; vertical-align: top; }
    th { width: 12rem; }
    .lede { font-size: 1.125rem; }
    .notice { border-inline-start: 0.25rem solid color-mix(in srgb, currentColor 35%, transparent); padding: 0.75rem 1rem; background: color-mix(in srgb, currentColor 6%, transparent); }
  </style>
</head>
<body>
  <main>
${body}
  </main>
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
    source_reference: source ? sourceReference(source) : undefined,
  };
}

function writeProblem(entry) {
  const uri = problemUri(entry);
  const record = problemRecord(entry);
  const docs = documentationForProblem(entry);
  const body = `    <h1>${escapeHtml(entry.title)}</h1>
    <p class="lede">${escapeHtml(entry.description)}</p>
    <p><code>${escapeHtml(uri)}</code></p>
    <section class="notice" aria-labelledby="authority">
      <h2 id="authority">Authority Boundary</h2>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
      <p>${escapeHtml(problemAuthorityStatement)}</p>
    </section>
    <section aria-labelledby="facts">
      <h2 id="facts">Defined Facts</h2>
${renderFacts([
  { label: 'Canonical URI', html: `<code>${escapeHtml(uri)}</code>` },
  { label: 'Kind', value: 'problem' },
  { label: 'Product', value: entry.product },
  { label: 'Code', html: `<code>${escapeHtml(entry.code)}</code>` },
  { label: 'Category', value: entry.category ?? 'not published' },
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
    <h2>Problem record</h2>
    <pre><code>${escapeHtml(JSON.stringify(record, null, 2))}</code></pre>
    <p><a href="${escapeHtml(uri)}.json">Machine-readable JSON</a></p>`;

  writeOutput(`problems/${entry.product}/${entry.path}/index.html`, page(entry.title, body));
  writeOutput(`problems/${entry.product}/${entry.path}.json`, json(record));
}

function writeCatalogIndex(name, entries, makeUri) {
  const rows = entries
    .map((entry) => {
      const uri = makeUri(entry);
      return `<tr><td><a href="${escapeHtml(uri)}">${escapeHtml(uri)}</a></td><td>${escapeHtml(entry.title)}</td></tr>`;
    })
    .join('\n');
  const body = `    <h1>${escapeHtml(name)}</h1>
    <p>Stable Registry Stack identifiers.</p>
    <section class="notice" aria-labelledby="authority">
      <h2 id="authority">Authority Boundary</h2>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <table>
      <thead><tr><th>Identifier</th><th>Title</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`;
  writeOutput(`${name.toLowerCase().replaceAll(' ', '-')}/index.html`, page(name, body));
}

function writeNamespace(entry) {
  const path = uriToPath(entry.uri);
  const record = {
    ...entry,
    kind: 'namespace',
    documented_by: documentationForIdentifier(entry),
    authority: authorityRecord(),
  };
  const body = `    <h1>${escapeHtml(entry.title)}</h1>
    <p><code>${escapeHtml(entry.uri)}</code></p>
    <p>${escapeHtml(entry.description)}</p>
    <section class="notice" aria-labelledby="authority">
      <h2 id="authority">Authority Boundary</h2>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <h2>Documentation</h2>
${renderLinks(record.documented_by)}
    <h2>Namespace record</h2>
    <pre><code>${escapeHtml(JSON.stringify(record, null, 2))}</code></pre>
    <p><a href="${escapeHtml(`${baseUrl}/${path}.json`)}">Machine-readable JSON</a></p>`;
  writeOutput(`${path}/index.html`, page(entry.title, body));
  writeOutput(`${path}.json`, json(record));
}

function writeSchema(entry) {
  const path = uriToPath(entry.uri);
  copyOutput(entry.source, path);
  const docs = documentationForIdentifier({ ...entry, product: entry.product ?? 'registry-relay' });
  const body = `    <h1>${escapeHtml(entry.title)}</h1>
    <p><code>${escapeHtml(entry.uri)}</code></p>
    <p>${escapeHtml(entry.description)}</p>
    <section class="notice" aria-labelledby="authority">
      <h2 id="authority">Authority Boundary</h2>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
      <p>The canonical machine artifact at this URI is the JSON Schema itself.</p>
    </section>
    <h2>Documentation</h2>
${renderLinks(docs)}
    <p><a href="${escapeHtml(entry.uri)}">JSON Schema</a></p>`;
  writeOutput(`${path.replace(/\.json$/, '')}/index.html`, page(entry.title, body));
}

function writeContext(entry) {
  const path = uriToPath(entry.uri);
  copyOutput(entry.source, path);
  const docs = documentationForIdentifier({ ...entry, product: entry.product ?? 'registry-relay' });
  const body = `    <h1>${escapeHtml(entry.title)}</h1>
    <p><code>${escapeHtml(entry.uri)}</code></p>
    <p>${escapeHtml(entry.description)}</p>
    <section class="notice" aria-labelledby="authority">
      <h2 id="authority">Authority Boundary</h2>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
      <p>The canonical machine artifact at this URI is the JSON-LD context itself.</p>
    </section>
    <h2>Documentation</h2>
${renderLinks(docs)}
    <p><a href="${escapeHtml(entry.uri)}">JSON-LD context</a></p>`;
  writeOutput(`${path.replace(/\.jsonld$/, '')}/index.html`, page(entry.title, body));
}

function writeStaticControls() {
  const machineHeaders = [
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

  const exactHeaders = machineHeaders
    .map((entry) => `/${entry.path}
  Content-Type: ${entry.contentType}
  Access-Control-Allow-Origin: *
  Cache-Control: ${entry.cache}`)
    .join('\n\n');

  writeOutput('_headers', `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer

${exactHeaders}
`);
  writeOutput('_redirects', `/problem-types/* /problems/:splat 301
/.well-known/registrystack-identifiers /index.json 200
`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const problems = readJson('src/catalogs/problems.json').entries;
const namespaces = readJson('src/catalogs/namespaces.json').entries;
const schemas = readJson('src/catalogs/schemas.json').entries;
const contexts = readJson('src/catalogs/contexts.json').entries;

for (const entry of problems) writeProblem(entry);
for (const entry of namespaces) writeNamespace(entry);
for (const entry of schemas) writeSchema(entry);
for (const entry of contexts) writeContext(entry);

writeCatalogIndex('Problems', problems, problemUri);
writeCatalogIndex('Namespaces', namespaces, (entry) => entry.uri.replace(/#$/, ''));
writeCatalogIndex('Schemas', schemas, (entry) => entry.uri);
writeCatalogIndex('Contexts', contexts, (entry) => entry.uri);

writeOutput('problems/index.json', json({ entries: problems.map(problemRecord) }));
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
    namespaces: `${baseUrl}/namespaces/`,
    schemas: `${baseUrl}/schemas/`,
    contexts: `${baseUrl}/contexts/`,
  },
}));
writeOutput('index.html', page('Registry Stack identifiers', `    <h1>Registry Stack identifiers</h1>
    <p>Stable machine identifiers for Registry Stack problem types, namespaces, schemas, and contexts.</p>
    <section class="notice" aria-labelledby="authority">
      <h2 id="authority">Authority Boundary</h2>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <ul>
      <li><a href="/problems/">Problem types</a></li>
      <li><a href="/namespaces/">Namespaces</a></li>
      <li><a href="/schemas/">Schemas</a></li>
      <li><a href="/contexts/">Contexts</a></li>    </ul>`));
writeOutput('404.html', page('Identifier not found', `    <h1>Identifier not found</h1>
    <p class="lede">This path is not a registered Registry Stack identifier.</p>
    <section class="notice" aria-labelledby="authority">
      <h2 id="authority">Authority Boundary</h2>
      <p>${escapeHtml(resolverAuthorityStatement)}</p>
    </section>
    <p>Browse the published identifiers:</p>
    <ul>
      <li><a href="/problems/">Problem types</a></li>
      <li><a href="/namespaces/">Namespaces</a></li>
      <li><a href="/schemas/">Schemas</a></li>
      <li><a href="/contexts/">Contexts</a></li>    </ul>`));
writeOutput('llms.txt', `# Registry Stack identifier resolver

Canonical host: ${baseUrl}/

This host resolves stable Registry Stack identifiers for problem types, JSON-LD namespaces, JSON Schemas, and JSON-LD contexts.

Authority boundary: ${resolverAuthorityStatement}

For RFC 9457 problem responses, use the stable code extension and the response status/detail fields. Do not parse URL paths for program logic.

Machine catalogs:

- ${baseUrl}/index.json
- ${baseUrl}/problems/index.json

Public documentation:

- ${documentation.docsHome.href}
- ${documentation.errorReference.href}
- ${docsBaseUrl}/llms.txt
- ${docsBaseUrl}/llms-full.txt
`);
writeStaticControls();

console.log(`built ${relative(process.cwd(), outputDir)}`);
