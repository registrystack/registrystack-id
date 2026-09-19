const baseUrl = (
  process.env.IDENTIFIER_BASE_URL ?? 'https://id.registrystack.org'
).replace(/\/$/, '');
const canonicalBaseUrl = 'https://id.registrystack.org';

async function readJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

const index = await readJson('/index.json');
if (index.base_url !== canonicalBaseUrl || !index.catalogs?.vocabularies) {
  throw new Error('root catalog does not describe the current resolver');
}

const problem = await readJson(
  '/problems/registry-relay/auth/missing_credential.json',
);
if (
  problem.code !== 'auth.missing_credential' ||
  problem.lifecycle_status !== 'active' ||
  !problem.http_statuses?.includes(401)
) {
  throw new Error('representative Relay V2 problem record is stale');
}

const namespace = await readJson('/ns/registry-manifest/v1.json');
if (
  namespace.id !== 'https://id.registrystack.org/ns/registry-manifest/v1#' ||
  namespace.kind !== 'namespace' ||
  namespace.status !== 'active'
) {
  throw new Error('Registry Manifest namespace record is stale');
}

const schema = await readJson(
  '/schemas/identifiers/catalog.v1.schema.json',
);
if (
  schema.$id !==
  'https://id.registrystack.org/schemas/identifiers/catalog.v1.schema.json'
) {
  throw new Error('representative schema artifact is stale');
}

const generatedSchema = await readJson(
  '/schemas/registry-relay/audit-event/v2alpha1',
);
if (
  generatedSchema.$id !==
  'https://id.registrystack.org/schemas/registry-relay/audit-event/v2alpha1'
) {
  throw new Error('generated Relay V2 schema artifact is stale');
}

const vocabulary = await readJson('/vocab/sourceRequired.json');
if (
  vocabulary.kind !== 'vocabulary-term' ||
  vocabulary.status !== 'active'
) {
  throw new Error('representative Relay V2 vocabulary term is stale');
}

const coreVocabulary = await readJson('/vocabularies/core.json');
if (
  coreVocabulary.kind !== 'vocabulary' ||
  coreVocabulary.status !== 'active' ||
  coreVocabulary.child_term_policy?.ownership !== 'adopter-defined' ||
  coreVocabulary.child_term_policy?.registry_reviewed !== false
) {
  throw new Error(
    'Relay V2 vocabulary prefix does not describe adopter ownership',
  );
}

if (baseUrl === canonicalBaseUrl) {
  const dynamicVocabulary = await readJson('/vocab/core/exampleField');
  if (
    dynamicVocabulary.kind !== 'vocabulary' ||
    dynamicVocabulary.status !== 'active' ||
    dynamicVocabulary.child_term_policy?.ownership !== 'adopter-defined' ||
    dynamicVocabulary.child_term_policy?.registry_reviewed !== false
  ) {
    throw new Error(
      'Relay V2 generated vocabulary prefix does not describe adopter ownership',
    );
  }
}

const historicalNamespace = await readJson('/ns/registry-relay/v1.json');
if (
  historicalNamespace.id !== 'https://id.registrystack.org/ns/registry-relay/v1#' ||
  historicalNamespace.kind !== 'namespace' ||
  historicalNamespace.status !== 'deprecated'
) {
  throw new Error('historical Registry Relay namespace was not preserved');
}

console.log(`identifier availability smoke passed for ${baseUrl}`);
