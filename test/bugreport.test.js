import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl, redactHeaders, curlCommand, buildBugReport } from '../src/bugreport.js';

test('redacts secrets in query strings and headers', () => {
  assert.equal(redactUrl('https://api.example.com/v1?api_key=abc&city=Vancouver'), 'https://api.example.com/v1?api_key=REDACTED&city=Vancouver');
  assert.deepEqual(redactHeaders({ Authorization: 'Bearer xyz', Accept: 'application/json' }), { Authorization: 'REDACTED', Accept: 'application/json' });
});

test('curl command reproduces the request without leaking secrets', () => {
  const cmd = curlCommand({ url: 'https://api.example.com/me?token=abc', method: 'POST', headers: { Authorization: 'Bearer xyz' }, body: { a: 1 }, timeoutMs: 3000 });
  assert.match(cmd, /^curl -v/);
  assert.match(cmd, /-X POST/);
  assert.match(cmd, /--max-time 3/);
  assert.match(cmd, /--data-raw '\{"a":1\}'/);
  assert.match(cmd, /time_namelookup/);
  assert.doesNotMatch(cmd, /xyz|token=abc/);
});

const failedAttempts = [
  { attempt: 0, ts: '2026-11-26T08:00:00.000Z', ok: 0, category: 'server_error', technical: 'HTTP 503 (expected 200)', dns_ms: 5, tcp_ms: 20, tls_ms: 60, ttfb_ms: 100, total_ms: 190, next_retry_ms: 1100 },
  { attempt: 1, ts: '2026-11-26T08:00:01.300Z', ok: 0, category: 'server_error', technical: 'HTTP 503 (expected 200)', dns_ms: 4, tcp_ms: 18, tls_ms: 55, ttfb_ms: 98, total_ms: 180, body_snippet: '{"error":"unavailable"}' },
];

test('HTTP report has every section a ticket needs', () => {
  const report = buildBugReport(
    { id: 'x', name: 'Example API', url: 'https://api.example.com/health' },
    failedAttempts,
    { firstFailure: '2026-11-26T07:55:00.000Z', failedChecks: 3, lastSuccess: '2026-11-26T07:50:00.000Z' },
  );
  for (const heading of ['Summary:', '## Environment', '## Impact', '## Steps to reproduce', '## Expected result', '## Actual result', '## Diagnosis', '## Attempts in the latest check', '## Response body']) {
    assert.ok(report.includes(heading), `missing ${heading}`);
  }
  assert.match(report, /3 consecutive failed checks/);
  assert.match(report, /curl -v/);
});

test('STUN report gives UDP reproduction steps instead of curl', () => {
  const report = buildBugReport(
    { id: 's', name: 'STUN', type: 'stun', url: 'stun:stun.example.com:3478' },
    [{ attempt: 0, ts: '2026-11-26T08:00:00.000Z', ok: 0, category: 'udp_no_response', technical: 'STUN_TIMEOUT: no reply' }],
  );
  assert.match(report, /stunclient stun\.example\.com 3478/);
  assert.doesNotMatch(report, /curl -v/);
});
