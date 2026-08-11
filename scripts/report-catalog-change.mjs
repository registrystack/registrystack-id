import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = 'https://id.registrystack.org';
const catalogs = [
  ['problem', 'src/catalogs/problems.json'],
  ['schema', 'src/catalogs/schemas.json'],
  ['context', 'src/catalogs/contexts.json'],
  ['namespace', 'src/catalogs/namespaces.json'],
  ['vocabulary', 'src/catalogs/vocabularies.json'],
  ['vocabulary-term', 'src/catalogs/vocabulary-terms.json'],
];

function problemUri(entry) {
  return `${baseUrl}/problems/${entry.product}/${entry.path}`;
}

function entryUri(kind, entry) {
  return kind === 'problem' ? problemUri(entry) : entry.uri;
}

function comparable(entry) {
  return {
    title: entry.title,
    description: entry.description,
    status: entry.status,
    owner: entry.owner,
    compatibility_line: entry.compatibility_line,
    code: entry.code,
    http_statuses: entry.http_statuses,
    source_path: entry.source_reference?.path,
    source_sha256: entry.source_reference?.sha256,
  };
}

function artifactDigest(entry) {
  return entry.artifact_sha256 ?? null;
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

export function summarizeCatalogs(beforeEntries, afterEntries) {
  const before = new Map(beforeEntries.map((entry) => [entry.uri, entry]));
  const after = new Map(afterEntries.map((entry) => [entry.uri, entry]));
  const summary = {
    before: before.size,
    after: after.size,
    added: [],
    removed: [],
    metadata_updated: [],
    artifact_updated: [],
  };
  for (const [uri, entry] of after) {
    const previous = before.get(uri);
    if (!previous) {
      summary.added.push(uri);
      continue;
    }
    if (previous.kind !== entry.kind) {
      throw new Error(`identifier changed kind: ${uri}`);
    }
    if (stableJson(comparable(previous)) !== stableJson(comparable(entry))) {
      summary.metadata_updated.push(uri);
    }
    if (artifactDigest(previous) !== artifactDigest(entry)) {
      summary.artifact_updated.push(uri);
    }
  }
  for (const uri of before.keys()) {
    if (!after.has(uri)) {
      summary.removed.push(uri);
    }
  }
  for (const key of ['added', 'removed', 'metadata_updated', 'artifact_updated']) {
    summary[key].sort();
  }
  return summary;
}

function loadWorkingCatalogs() {
  return catalogs.flatMap(([kind, path]) => {
    const document = JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
    return document.entries.map((entry) => ({
      ...entry,
      kind,
      uri: entryUri(kind, entry),
    }));
  });
}

function loadRefCatalogs(reference) {
  execFileSync('git', ['rev-parse', '--verify', `${reference}^{commit}`], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  return catalogs.flatMap(([kind, path]) => {
    let text;
    try {
      text = execFileSync('git', ['show', `${reference}:${path}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return [];
    }
    const document = JSON.parse(text);
    return document.entries.map((entry) => ({
      ...entry,
      kind,
      uri: entryUri(kind, entry),
    }));
  });
}

function renderList(title, values) {
  const lines = [`### ${title} (${values.length})`, ''];
  if (!values.length) {
    lines.push('None.');
  } else {
    lines.push(...values.map((value) => `- \`${value}\``));
  }
  return lines.join('\n');
}

export function renderMarkdown(summary) {
  return [
    '## Identifier catalog change',
    '',
    `Published identifiers: ${summary.before} -> ${summary.after}`,
    '',
    renderList('Added', summary.added),
    '',
    renderList('Removed', summary.removed),
    '',
    renderList('Metadata updated', summary.metadata_updated),
    '',
    renderList('Artifact digest updated', summary.artifact_updated),
    '',
  ].join('\n');
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const reference = process.argv[2] ?? 'origin/main';
  const summary = summarizeCatalogs(
    loadRefCatalogs(reference),
    loadWorkingCatalogs(),
  );
  process.stdout.write(renderMarkdown(summary));
}
