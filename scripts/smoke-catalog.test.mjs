import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_RETRY_WINDOW_MS,
  parseRetryWindowMs,
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

function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (delayMs) => {
      nowMs += delayMs;
    },
  };
}

test('the default retry window and backoff match the propagation runbook', () => {
  assert.equal(DEFAULT_RETRY_WINDOW_MS, 180_000);
  assert.deepEqual(
    DEFAULT_RETRY_DELAYS_MS,
    [5_000, 10_000, 20_000, 30_000],
  );
});

test('the retry-window override must be finite and nonnegative', () => {
  assert.equal(parseRetryWindowMs(undefined), DEFAULT_RETRY_WINDOW_MS);
  assert.equal(parseRetryWindowMs('0'), 0);
  assert.equal(parseRetryWindowMs('1250'), 1_250);
  for (const value of ['abc', 'Infinity', '-1']) {
    assert.throws(
      () => parseRetryWindowMs(value),
      /must be a finite, nonnegative number/,
    );
  }
});

test('a check that returns stale bytes a few times then fresh bytes eventually passes', async (t) => {
  let calls = 0;
  const clock = fakeClock();
  stubFetch(t, async () => {
    calls += 1;
    return { text: async () => (calls < 3 ? 'stale' : 'fresh') };
  });

  const results = await runChecksWithRetry(
    [makeCheck('https://id.registrystack.org/problems/example')],
    { retryDelaysMs: [1, 1, 1], retryWindowMs: 10, ...clock },
  );

  assert.deepEqual(results, [{ status: 'fulfilled' }]);
  assert.equal(calls, 3);
});

test('a check that stays stale fails after the retry window elapses, with the same failure reason', async (t) => {
  const clock = fakeClock();
  stubFetch(t, async () => ({ text: async () => 'stale' }));

  const results = await runChecksWithRetry(
    [makeCheck('https://id.registrystack.org/problems/example')],
    { retryDelaysMs: [1, 1], retryWindowMs: 2, ...clock },
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
  const clock = fakeClock();
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
    { retryDelaysMs: [1], retryWindowMs: 5, ...clock },
  );

  assert.deepEqual(
    results.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(freshCalls, 1);
  assert.equal(catchesUpCalls, 2);
});

test('check execution time consumes the retry window', async () => {
  let nowMs = 0;
  let calls = 0;
  let sleeps = 0;
  const results = await runChecksWithRetry(
    [{
      name: 'slow check',
      run: async () => {
        calls += 1;
        nowMs += 11;
        throw new Error('still stale');
      },
    }],
    {
      retryDelaysMs: [1],
      retryWindowMs: 10,
      sleep: async () => {
        sleeps += 1;
      },
      now: () => nowMs,
    },
  );

  assert.equal(results[0].status, 'rejected');
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});
