import { extname } from 'node:path';

export const defaultArtifactMediaTypes = Object.freeze({
  schema: 'application/schema+json',
  context: 'application/ld+json',
  profile: 'text/markdown',
});

// Registry Stack owns the artifact media type. The publisher accepts that
// open value while refusing characters that could escape a `_headers` line.
export function validateArtifactMediaType(mediaType) {
  if (
    typeof mediaType !== 'string' ||
    mediaType.trim() !== mediaType ||
    !mediaType.includes('/') ||
    /[\u0000-\u001f\u007f]/.test(mediaType)
  ) {
    throw new Error(`invalid artifact media type: ${mediaType}`);
  }
  return mediaType;
}

export function artifactMediaType(entry) {
  return validateArtifactMediaType(
    entry.artifact_media_type ?? defaultArtifactMediaTypes[entry.kind],
  );
}

export function artifactContentType(entry) {
  return contentTypeForMediaType(artifactMediaType(entry));
}

export function contentTypeForMediaType(mediaType) {
  validateArtifactMediaType(mediaType);
  return mediaType.includes(';') ? mediaType : `${mediaType}; charset=utf-8`;
}

export function baseMediaType(contentType) {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

export function artifactMediaTypeOverride(kind, mediaType) {
  const validated = validateArtifactMediaType(mediaType);
  return validated === defaultArtifactMediaTypes[kind] ? undefined : validated;
}

function validateArtifactName(name) {
  if (
    typeof name !== 'string' ||
    !/^[0-9a-f]{64}(?:\.[a-z0-9]+)?$/.test(name)
  ) {
    throw new Error(`immutable artifact has an invalid digest name: ${name}`);
  }
  return name;
}

export function parseArtifactMediaTypeBindings(document) {
  if (
    document?.version !== 1 ||
    !document.artifacts ||
    typeof document.artifacts !== 'object' ||
    Array.isArray(document.artifacts)
  ) {
    throw new Error('artifact media type bindings have an unsupported shape');
  }
  const bindings = new Map();
  for (const [name, mediaType] of Object.entries(document.artifacts)) {
    bindArtifactMediaType(bindings, name, mediaType);
  }
  return bindings;
}

export function artifactMediaTypeBindingsDocument(bindings) {
  return {
    version: 1,
    artifacts: Object.fromEntries(
      [...bindings.entries()].sort(([left], [right]) =>
        left.localeCompare(right, 'en')),
    ),
  };
}

export function bindArtifactMediaType(bindings, name, mediaType) {
  validateArtifactName(name);
  const validated = validateArtifactMediaType(mediaType);
  const existing = bindings.get(name);
  if (existing && existing !== validated) {
    throw new Error(`immutable artifact has conflicting media types: ${name}`);
  }
  bindings.set(name, validated);
  return validated;
}

// Retained digests can outlive the catalog entry that named them, so their
// smoke checks need a stable fallback for the publisher's historical formats.
export function artifactMediaTypeForPath(path) {
  switch (extname(path)) {
    case '.jsonld':
      return 'application/ld+json';
    case '.md':
      return 'text/markdown';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    default:
      return 'application/schema+json';
  }
}

// Cloudflare combines every matching rule. Partition a suffix by digest prefix
// until each wildcard has one content type, so no concrete artifact receives
// both its extension fallback and a conflicting exact override.
function immutableRulesForGroup(entries, extension, prefix = '') {
  const contentTypes = new Set(entries.map((entry) => entry.contentType));
  if (contentTypes.size === 1) {
    return [{
      path: `artifacts/sha256/${prefix}*${extension}`,
      contentType: entries[0].contentType,
      cache: 'public, max-age=31536000, immutable',
    }];
  }
  const groups = new Map();
  for (const entry of entries) {
    const next = entry.digest[prefix.length];
    if (!next) {
      throw new Error(`immutable artifact has conflicting media types: ${entry.name}`);
    }
    const group = groups.get(next) ?? [];
    group.push(entry);
    groups.set(next, group);
  }
  return [...groups.entries()].flatMap(([next, group]) =>
    immutableRulesForGroup(group, extension, `${prefix}${next}`));
}

export function immutableArtifactHeaderRules(
  artifactNames,
  contentTypeOverrides = new Map(),
) {
  const knownExtensions = ['.json', '.jsonld', '.md', '.yaml', '.yml'];
  const names = new Set(artifactNames);
  for (const name of contentTypeOverrides.keys()) {
    if (!names.has(name)) {
      throw new Error(`catalog names a missing immutable artifact: ${name}`);
    }
  }

  const byExtension = new Map(
    knownExtensions.map((extension) => [extension, []]),
  );
  for (const name of [...names].sort()) {
    const extension = extname(name) || '.bin';
    const digest = extension === '.bin' ? name : name.slice(0, -extension.length);
    validateArtifactName(name);
    const entries = byExtension.get(extension) ?? [];
    const mediaType = artifactMediaTypeForPath(name);
    entries.push({
      name,
      digest,
      contentType: contentTypeForMediaType(
        contentTypeOverrides.get(name) ?? mediaType,
      ),
    });
    byExtension.set(extension, entries);
  }

  return [...byExtension.entries()].flatMap(([extension, entries]) => {
    if (entries.length > 0) {
      return immutableRulesForGroup(entries, extension);
    }
    const mediaType = artifactMediaTypeForPath(`artifact${extension}`);
    return [{
      path: `artifacts/sha256/*${extension}`,
      contentType: contentTypeForMediaType(mediaType),
      cache: 'public, max-age=31536000, immutable',
    }];
  });
}
