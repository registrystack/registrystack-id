import { readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const canonicalBaseUrl = 'https://id.registrystack.org';
const baseUrl = (
  process.env.IDENTIFIER_BASE_URL ?? canonicalBaseUrl
).replace(/\/$/, '');
const catalogFiles = [
  'problems.json',
  'namespaces.json',
  'schemas.json',
  'contexts.json',
  'profiles.json',
  'vocabularies.json',
  'vocabulary-terms.json',
];

// Cloudflare's edge can take a short while to finish propagating a deploy.
// A check retries with backoff (capped at the schedule's last step) for a
// bounded window before it is treated as a failure, so a routine publish
// does not fail on bytes that are still in flight; a genuine mismatch still
// fails once the window elapses.
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];
export const DEFAULT_RETRY_WINDOW_MS = 180_000;

export function parseRetryWindowMs(value) {
  const retryWindowMs = Number(value ?? DEFAULT_RETRY_WINDOW_MS);
  if (!Number.isFinite(retryWindowMs) || retryWindowMs < 0) {
    throw new Error(
      'IDENTIFIER_SMOKE_RETRY_WINDOW_MS must be a finite, nonnegative number',
    );
  }
  return retryWindowMs;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function expectedBytes(path) {
  return readFileSync(resolve(repoRoot, 'public', path));
}

function uriPath(uri) {
  return new URL(uri).pathname.replace(/^\//, '');
}

function problemUri(entry) {
  return `${canonicalBaseUrl}/problems/${entry.product}/${entry.path}`;
}

function entryUri(entry) {
  return entry.kind === 'problem' ? problemUri(entry) : entry.uri;
}

function localUrl(uri) {
  const parsed = new URL(uri);
  return `${baseUrl}${parsed.pathname}${parsed.search}`;
}

function mediaType(contentType) {
  return contentType?.split(';', 1)[0].trim().toLowerCase() ?? '';
}

function expectedArtifactMediaType(path) {
  switch (extname(path)) {
    case '.jsonld':
      return 'application/ld+json';
    case '.md':
      return 'text/markdown';
    default:
      return 'application/schema+json';
  }
}

async function fetchExact(url, expectedPath, expectedMediaType, retrySignal) {
  const requestSignal = retrySignal
    ? AbortSignal.any([retrySignal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const response = await fetch(url, {
    headers: expectedMediaType ? { accept: expectedMediaType } : undefined,
    signal: requestSignal,
  });
  const actual = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const expected = expectedBytes(expectedPath);
  if (!actual.equals(expected)) {
    throw new Error(
      `${url} returned bytes that differ from public/${expectedPath}`,
    );
  }
  if (
    baseUrl === canonicalBaseUrl &&
    expectedMediaType &&
    mediaType(response.headers.get('content-type')) !== expectedMediaType
  ) {
    throw new Error(
      `${url} returned ${response.headers.get('content-type')}, expected ${expectedMediaType}`,
    );
  }
}

async function checkEntry(entry, retrySignal) {
  const uri = entryUri(entry);
  const path = uriPath(uri);
  if (entry.artifact_sha256) {
    const expectedMediaType = expectedArtifactMediaType(entry.source);
    await fetchExact(localUrl(uri), path, expectedMediaType, retrySignal);
    if (!entry.immutable_uri) {
      throw new Error(`${uri} does not name an immutable artifact URI`);
    }
    await fetchExact(
      localUrl(entry.immutable_uri),
      uriPath(entry.immutable_uri),
      expectedMediaType,
      retrySignal,
    );
    return;
  }

  const pagePath = `${path.replace(/\/$/, '')}/index.html`;
  await fetchExact(localUrl(uri), pagePath, 'text/html', retrySignal);
  const recordPath = entry.kind === 'problem'
    ? `${path}.json`
    : path.endsWith('/')
      ? `${path}index.json`
      : `${path}.json`;
  await fetchExact(
    `${baseUrl}/${recordPath}`,
    recordPath,
    'application/json',
    retrySignal,
  );
}

// Runs checks with bounded concurrency. A retry deadline stops new checks and
// marks work it aborts so the caller can retain the last completed failure.
async function runAll(checksToRun, { signal } = {}) {
  let nextIndex = 0;
  const results = new Array(checksToRun.length);
  async function worker() {
    while (nextIndex < checksToRun.length) {
      if (signal?.aborted) {
        break;
      }
      const index = nextIndex;
      nextIndex += 1;
      try {
        await checksToRun[index].run(signal);
        results[index] = { status: 'fulfilled' };
      } catch (reason) {
        results[index] = signal?.aborted
          ? { status: 'deadline-exceeded' }
          : { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(8, checksToRun.length) }, worker),
  );
  return results;
}

function rejectedIndexes(results) {
  return results.reduce(
    (indexes, result, index) =>
      result.status === 'rejected' ? [...indexes, index] : indexes,
    [],
  );
}

// Runs every check, then retries only the checks that failed with backoff
// until every check passes or the bounded retry window elapses. Returns
// results in the original order, matching `runAll`'s result shape.
export async function runChecksWithRetry(
  checks,
  {
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    retryWindowMs = DEFAULT_RETRY_WINDOW_MS,
    sleep: sleepFn = sleep,
    now: nowFn = () => performance.now(),
    deadlineSignal: deadlineSignalFn = (remainingMs) =>
      AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs))),
  } = {},
) {
  const deadlineMs = nowFn() + retryWindowMs;
  const results = await runAll(checks);
  let pending = rejectedIndexes(results);
  let attempt = 0;
  while (pending.length > 0) {
    const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
    if (nowFn() + delay > deadlineMs) {
      break;
    }
    console.warn(
      `${pending.length} of ${checks.length} check(s) saw stale content; retrying in ${delay}ms`,
    );
    await sleepFn(delay);
    attempt += 1;
    const remainingMs = deadlineMs - nowFn();
    if (remainingMs <= 0) {
      break;
    }
    const deadlineSignal = deadlineSignalFn(remainingMs);
    const retried = await runAll(
      pending.map((index) => checks[index]),
      { signal: deadlineSignal },
    );
    pending.forEach((index, position) => {
      if (
        retried[position] &&
        retried[position].status !== 'deadline-exceeded'
      ) {
        results[index] = retried[position];
      }
    });
    pending = rejectedIndexes(results);
    if (deadlineSignal.aborted) {
      break;
    }
  }
  return results;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const entries = catalogFiles.flatMap(
    (path) => readJson(`src/catalogs/${path}`).entries,
  );
  const digestArtifacts = readdirSync(resolve(repoRoot, 'src/artifacts/sha256'))
    .sort()
    .map((name) => ({
      name,
      run: (signal) => fetchExact(
        `${baseUrl}/artifacts/sha256/${name}`,
        `artifacts/sha256/${name}`,
        expectedArtifactMediaType(name),
        signal,
      ),
    }));
  const checks = [
    ...entries.map((entry) => ({
      name: entryUri(entry),
      run: (signal) => checkEntry(entry, signal),
    })),
    ...digestArtifacts.map((artifact) => ({
      name: `${canonicalBaseUrl}/artifacts/sha256/${artifact.name}`,
      run: artifact.run,
    })),
  ];

  const retryWindowMs = parseRetryWindowMs(
    process.env.IDENTIFIER_SMOKE_RETRY_WINDOW_MS,
  );
  const results = await runChecksWithRetry(checks, { retryWindowMs });
  const failures = results
    .map((result, index) => ({ result, check: checks[index] }))
    .filter(({ result }) => result.status === 'rejected');
  for (const { result, check } of failures) {
    console.error(`${check.name}: ${result.reason.message}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${checks.length} catalog and immutable artifact checks failed on ${baseUrl}`,
    );
  }
  console.log(
    `all ${entries.length} active and deprecated identifiers plus ${digestArtifacts.length} retained immutable artifacts passed exact-byte checks on ${baseUrl}`,
  );
}
