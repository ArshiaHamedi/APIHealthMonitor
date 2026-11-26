import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, parseRetryAfter, checkWithRetry, phases } from '../src/checker.js';

test('backoff doubles each attempt and respects the cap', () => {
  const noJitter = { random: () => 0 };
  assert.equal(backoffDelay(0, noJitter), 1000);
  assert.equal(backoffDelay(1, noJitter), 2000);
  assert.equal(backoffDelay(2, noJitter), 4000);
  assert.equal(backoffDelay(10, { ...noJitter, maxMs: 15000 }), 15000);
  assert.equal(backoffDelay(0, { random: () => 1 }), 1200);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('30'), 30000);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10000);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter('garbage'), null);
});

test('retries a 503 and stops once it succeeds', async () => {
  const responses = [{ status: 503 }, { status: 503 }, { status: 200 }];
  const waits = [];
  const attempts = await checkWithRetry({}, {
    maxRetries: 3,
    request: async () => ({ ...responses.shift(), timings: {} }),
    wait: async (ms) => waits.push(ms),
  });
  assert.equal(attempts.length, 3);
  assert.equal(attempts.at(-1).ok, true);
  assert.equal(waits.length, 2);
});

test('does not retry an auth failure', async () => {
  let calls = 0;
  const attempts = await checkWithRetry({}, {
    request: async () => { calls++; return { status: 401, timings: {} }; },
    wait: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(attempts[0].category, 'auth');
});

test('uses Retry-After when the server sends it', async () => {
  const waits = [];
  await checkWithRetry({}, {
    maxRetries: 1,
    request: async () => ({ status: 429, headers: { 'retry-after': '3' }, timings: {} }),
    wait: async (ms) => waits.push(ms),
  });
  assert.deepEqual(waits, [3000]);
});

test('phases splits a request into stages', () => {
  const p = phases({ start: 0, dns: 5, connect: 25, tls: 85, firstByte: 285, end: 300 });
  assert.deepEqual(p, { dns: 5, tcp: 20, tls: 60, ttfb: 200, download: 15, total: 300 });
});
