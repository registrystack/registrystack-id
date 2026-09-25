import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_RETRY_WINDOW_MS,
  runChecksWithRetry,
} from './smoke-catalog.mjs';

function makeCheck(url) {
  return {
    name: url,
    run: async () => {
      const response = await fetch(url);
      const body = await response.text();
      if (body !== 'fresh') {
        throw new Error(`${url} saw stale bytes`);
      }
    },
  };
}

function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test('the default retry window and backoff match the propagation runbook', () => {
  assert.equal(DEFAULT_RETRY_WINDOW_MS, 180_000);
  assert.deepEqual(
    DEFAULT_RETRY_DELAYS_MS,
    [5_000, 10_000, 20_000, 30_000],
  );
});

test('a check that returns stale bytes a few times then fresh bytes eventually passes', async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    return { text: async () => (calls < 3 ? 'stale' : 'fresh') };
  });

  const results = await runChecksWithRetry(
    [makeCheck('https://id.registrystack.org/problems/example')],
    { retryDelaysMs: [1, 1, 1], retryWindowMs: 10, sleep: async () => {} },
  );

  assert.deepEqual(results, [{ status: 'fulfilled' }]);
  assert.equal(calls, 3);
});

test('a check that stays stale fails after the retry window elapses, with the same failure reason', async (t) => {
  stubFetch(t, async () => ({ text: async () => 'stale' }));

  const results = await runChecksWithRetry(
    [makeCheck('https://id.registrystack.org/problems/example')],
    { retryDelaysMs: [1, 1], retryWindowMs: 2, sleep: async () => {} },
  );

  assert.equal(results[0].status, 'rejected');
  assert.equal(
    results[0].reason.message,
    'https://id.registrystack.org/problems/example saw stale bytes',
  );
});

test('only the checks that mismatched in the previous attempt are retried', async (t) => {
  let freshCalls = 0;
  let catchesUpCalls = 0;
  stubFetch(t, async (url) => {
    if (url === 'https://id.registrystack.org/always-fresh') {
      freshCalls += 1;
      return { text: async () => 'fresh' };
    }
    catchesUpCalls += 1;
    return { text: async () => (catchesUpCalls < 2 ? 'stale' : 'fresh') };
  });

  const results = await runChecksWithRetry(
    [
      makeCheck('https://id.registrystack.org/always-fresh'),
      makeCheck('https://id.registrystack.org/catches-up'),
    ],
    { retryDelaysMs: [1], retryWindowMs: 5, sleep: async () => {} },
  );

  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(freshCalls, 1);
  assert.equal(catchesUpCalls, 2);
});
