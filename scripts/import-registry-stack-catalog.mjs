import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = 'https://id.registrystack.org';
const catalogPath = 'products/identifiers/generated/catalog.v1.json';
const sourceRepository = 'https://github.com/registrystack/registry-stack';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function writeJson(path, value) {
  const target = resolve(repoRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function gitOutput(stackRoot, ...arguments_) {
  return execFileSync('git', ['-C', stackRoot, ...arguments_], {
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitText(stackRoot, ...arguments_) {
  return gitOutput(stackRoot, ...arguments_).toString('utf8').trim();
}

function gitFile(stackRoot, revision, path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.startsWith('/') ||
    path.split('/').includes('..')
  ) {
    throw new Error(`unsafe Registry Stack source path: ${path}`);
  }
  return gitOutput(stackRoot, 'show', `${revision}:${path}`);
}

const catalogFiles = {
  problem: 'src/catalogs/problems.json',
  schema: 'src/catalogs/schemas.json',
  context: 'src/catalogs/contexts.json',
  profile: 'src/catalogs/profiles.json',
  namespace: 'src/catalogs/namespaces.json',
  vocabulary: 'src/catalogs/vocabularies.json',
  'vocabulary-term': 'src/catalogs/vocabulary-terms.json',
};

/**
 * Refuse a source catalog kind this publisher does not carry, so a new kind in
 * Registry Stack is a deliberate publisher change rather than a silent drop.
 */
export function assertSupportedKind(kind) {
  if (!Object.hasOwn(catalogFiles, kind)) {
    throw new Error(`unsupported identifier kind: ${kind}`);
  }
  return kind;
}

/** The publisher catalog file that carries one identifier kind. */
export function catalogFileForKind(kind) {
  return catalogFiles[assertSupportedKind(kind)];
}

function uriForProblem(entry) {
  return `${baseUrl}/problems/${entry.product}/${entry.path}`;
}

function uriForEntry(entry, kind) {
  return kind === 'problem' ? uriForProblem(entry) : entry.uri;
}

export function mergeCatalog(previous, incoming, kind) {
  const oldByUri = new Map();
  for (const entry of previous) {
    const uri = uriForEntry(entry, kind);
    if (oldByUri.has(uri)) {
      throw new Error(`duplicate historical ${kind} identifier: ${uri}`);
    }
    if (entry.kind && entry.kind !== kind) {
      throw new Error(`historical identifier changed kind: ${uri}`);
    }
    oldByUri.set(uri, entry);
  }

  const currentByUri = new Map();
  for (const entry of incoming) {
    const uri = uriForEntry(entry, kind);
    if (currentByUri.has(uri)) {
      throw new Error(`duplicate imported ${kind} identifier: ${uri}`);
    }
    if (entry.kind !== kind) {
      throw new Error(`imported identifier changed kind: ${uri}`);
    }
    currentByUri.set(uri, entry);
  }

  const merged = [...currentByUri.values()].map((current) => ({
    ...current,
    kind,
  }));
  return merged.sort((left, right) =>
    uriForEntry(left, kind).localeCompare(uriForEntry(right, kind), 'en'),
  );
}

function sourceReference(entry, revision) {
  return {
    repository: 'registry-stack',
    commit: revision,
    path: entry.source.path,
    sha256: entry.source.sha256,
  };
}

function problemEntry(entry, revision) {
  const match = entry.uri.match(
    /^https:\/\/id\.registrystack\.org\/problems\/([^/]+)\/(.+)$/,
  );
  if (!match) {
    throw new Error(`invalid problem identifier: ${entry.uri}`);
  }
  return {
    product: match[1],
    code: entry.problem.code,
    path: match[2],
    title: entry.title,
    description: entry.description,
    kind: 'problem',
    status: entry.status,
    compatibility_line: entry.compatibilityLine,
    owner: entry.owner,
    http_statuses: entry.problem.httpStatuses,
    source: `registry-stack/${entry.source.path}`,
    source_reference: sourceReference(entry, revision),
  };
}

function identifierEntry(entry, revision, artifactSource) {
  return {
    uri: entry.uri,
    title: entry.title,
    description: entry.description,
    kind: entry.kind,
    status: entry.status,
    compatibility_line: entry.compatibilityLine,
    owner: entry.owner,
    source: artifactSource,
    source_reference: sourceReference(entry, revision),
    artifact_sha256: entry.artifact?.sha256,
    immutable_uri: artifactSource
      ? `${baseUrl}/${artifactSource.replace(/^src\//, '')}`
      : undefined,
  };
}

function writeImmutableArtifact(stackRoot, revision, entry) {
  const bytes = gitFile(stackRoot, revision, entry.artifact.path);
  if (sha256(bytes) !== entry.artifact.sha256) {
    throw new Error(`artifact digest does not match: ${entry.artifact.path}`);
  }
  const extension = extname(entry.artifact.path) || '.bin';
  const source = `src/artifacts/sha256/${entry.artifact.sha256}${extension}`;
  const target = resolve(repoRoot, source);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (sha256(readFileSync(target)) !== entry.artifact.sha256) {
      throw new Error(`immutable artifact path contains different bytes: ${source}`);
    }
  } else {
    writeFileSync(target, bytes);
  }
  return source;
}

function validateSourceBindings(stackRoot, revision, entries) {
  for (const entry of entries) {
    if (entry.status !== 'active') {
      throw new Error(`Registry Stack catalog contains a non-active identifier: ${entry.uri}`);
    }
    const sourceBytes = gitFile(stackRoot, revision, entry.source.path);
    if (sha256(sourceBytes) !== entry.source.sha256) {
      throw new Error(`source digest does not match: ${entry.source.path}`);
    }
  }
}

function pruneArtifacts(referencedSources) {
  const artifactRoot = resolve(repoRoot, 'src/artifacts/sha256');
  if (!existsSync(artifactRoot)) {
    return;
  }
  for (const name of readdirSync(artifactRoot)) {
    const source = `src/artifacts/sha256/${name}`;
    if (!referencedSources.has(source)) {
      rmSync(resolve(artifactRoot, name));
    }
  }
}

function assertKindsAreStable(catalogs, imported) {
  const historicalKinds = new Map();
  for (const [kind, entries] of Object.entries(catalogs)) {
    for (const entry of entries) {
      const uri = uriForEntry(entry, kind);
      const existing = historicalKinds.get(uri);
      if (existing && existing !== kind) {
        throw new Error(`historical identifier has multiple kinds: ${uri}`);
      }
      historicalKinds.set(uri, kind);
    }
  }
  for (const entry of imported) {
    const existing = historicalKinds.get(entry.uri);
    if (existing && existing !== entry.kind) {
      throw new Error(`published identifier cannot change kind: ${entry.uri}`);
    }
  }
}

export function importCatalog(stackRoot, revision) {
  const resolvedRevision = gitText(
    stackRoot,
    'rev-parse',
    `${revision ?? 'HEAD'}^{commit}`,
  );
  if (!/^[0-9a-f]{40}$/.test(resolvedRevision)) {
    throw new Error(`Registry Stack revision is not a full commit: ${resolvedRevision}`);
  }

  const catalogBytes = gitFile(stackRoot, resolvedRevision, catalogPath);
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  if (
    catalog.version !== 1 ||
    catalog.baseUrl !== baseUrl ||
    !Array.isArray(catalog.entries)
  ) {
    throw new Error('Registry Stack identifier catalog has an unsupported shape');
  }
  validateSourceBindings(stackRoot, resolvedRevision, catalog.entries);

  const previous = {};
  const imported = {};
  for (const [kind, file] of Object.entries(catalogFiles)) {
    previous[kind] = existsSync(resolve(repoRoot, file))
      ? readJson(file).entries
      : [];
    imported[kind] = [];
  }
  assertKindsAreStable(previous, catalog.entries);

  for (const entry of catalog.entries) {
    assertSupportedKind(entry.kind);
    if (entry.kind === 'problem') {
      imported.problem.push(problemEntry(entry, resolvedRevision));
      continue;
    }
    const artifactSource = entry.artifact
      ? writeImmutableArtifact(stackRoot, resolvedRevision, entry)
      : undefined;
    imported[entry.kind].push(
      identifierEntry(entry, resolvedRevision, artifactSource),
    );
  }
  pruneArtifacts(
    new Set(
      Object.values(imported)
        .flat()
        .map((entry) => entry.source)
        .filter((source) => source?.startsWith('src/artifacts/sha256/')),
    ),
  );

  for (const [kind, file] of Object.entries(catalogFiles)) {
    const entries = mergeCatalog(previous[kind], imported[kind], kind);
    writeJson(
      file,
      kind === 'problem'
        ? {
            generated_from: `${sourceRepository}/blob/${resolvedRevision}/${catalogPath}`,
            generated_at: new Date(0).toISOString(),
            entries,
          }
        : { entries },
    );
  }

  const vendoredCatalog = resolve(repoRoot, 'src/upstream/catalog.v1.json');
  mkdirSync(dirname(vendoredCatalog), { recursive: true });
  writeFileSync(vendoredCatalog, catalogBytes);
  writeJson('src/upstream/source.json', {
    version: 1,
    repository: sourceRepository,
    commit: resolvedRevision,
    catalog_path: catalogPath,
    catalog_sha256: sha256(catalogBytes),
  });
  return { revision: resolvedRevision, count: catalog.entries.length };
}

export function parseArguments(arguments_) {
  let stackRoot;
  let revision;
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === '--source-revision') {
      revision = arguments_[index + 1];
      if (!revision) {
        throw new Error('--source-revision requires a full commit');
      }
      index += 1;
    } else if (!stackRoot) {
      stackRoot = arguments_[index];
    } else {
      throw new Error(`unexpected argument: ${arguments_[index]}`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(revision ?? '')) {
    throw new Error('--source-revision must be a full commit');
  }
  return {
    stackRoot: resolve(
      repoRoot,
      stackRoot ?? process.env.REGISTRY_STACK_DIR ?? '../registry-stack',
    ),
    revision,
  };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { stackRoot, revision } = parseArguments(process.argv.slice(2));
  const imported = importCatalog(stackRoot, revision);
  console.log(
    `imported ${imported.count} identifiers from registry-stack ${imported.revision}`,
  );
}
