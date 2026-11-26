import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';

const err = (code) => ({ status: null, error: { code, message: code } });

test('HTTP statuses map to the right category', () => {
  assert.equal(classify({ status: 200 }).category, 'ok');
  assert.equal(classify({ status: 401 }).category, 'auth');
  assert.equal(classify({ status: 403 }).category, 'auth');
  assert.equal(classify({ status: 429 }).category, 'rate_limit');
  assert.equal(classify({ status: 503 }).category, 'server_error');
  assert.equal(classify({ status: 404 }).category, 'client_error');
  assert.equal(classify({ status: 301 }).category, 'unexpected_status');
});

test('expectedStatus overrides the default of 200', () => {
  assert.equal(classify({ status: 204 }, { expectedStatus: 204 }).category, 'ok');
  assert.equal(classify({ status: 200 }, { expectedStatus: 204 }).category, 'unexpected_status');
});

test('network errors map to the right category', () => {
  assert.equal(classify(err('ENOTFOUND')).category, 'dns');
  assert.equal(classify(err('ECONNREFUSED')).category, 'connection_refused');
  assert.equal(classify(err('ECONNRESET')).category, 'connection_reset');
  assert.equal(classify(err('APP_TIMEOUT')).category, 'timeout');
  assert.equal(classify(err('CERT_HAS_EXPIRED')).category, 'tls');
  assert.equal(classify(err('ERR_TLS_CERT_ALTNAME_INVALID')).category, 'tls');
  assert.equal(classify(err('SOMETHING_ELSE')).category, 'network');
});

test('auth and TLS failures are not retried, rate limits and 5xx are', () => {
  assert.equal(classify({ status: 401 }).retryable, false);
  assert.equal(classify(err('CERT_HAS_EXPIRED')).retryable, false);
  assert.equal(classify({ status: 429 }).retryable, true);
  assert.equal(classify({ status: 502 }).retryable, true);
});

test('every result carries technical and plain explanations', () => {
  const r = classify({ status: 429 });
  assert.match(r.technical, /429/);
  assert.ok(r.plain.length > 20);
});
