import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';
import { classify, isTlsError } from './classify.js';

const certInfo = (c) => (c && c.valid_to
  ? { validTo: new Date(c.valid_to).toISOString(), subject: c.subject?.CN ?? null, issuer: c.issuer?.O ?? c.issuer?.CN ?? null }
  : null);

// Reads a server's certificate without trusting it. Only used after a TLS failure,
// so the dashboard can still show when a bad certificate expired. No request is sent.
export function readCertificate(hostname, port = 443, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
      const cert = certInfo(socket.getPeerCertificate());
      socket.end();
      resolve(cert);
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(null); });
    socket.on('error', () => resolve(null));
  });
}

const round = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10) / 10);

// Turn raw timestamps into per-stage durations (ms).
export function phases(t) {
  const dnsDone = t.dns ?? t.start;
  return {
    dns: t.dns != null ? round(t.dns - t.start) : null,
    tcp: t.connect != null ? round(t.connect - dnsDone) : null,
    tls: t.tls != null && t.connect != null ? round(t.tls - t.connect) : null,
    ttfb: t.firstByte != null ? round(t.firstByte - (t.tls ?? t.connect ?? t.start)) : null,
    download: t.end != null && t.firstByte != null ? round(t.end - t.firstByte) : null,
    total: t.end != null ? round(t.end - t.start) : null,
  };
}

// One HTTP(S) request with a timing breakdown. Never rejects: errors come back in the result.
export function timedRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const t = { start: performance.now() };
    let cert = null;
    let settled = false;
    let timer;

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      t.end ??= performance.now();
      resolve({ ...result, timings: phases(t), cert });
    };

    // agent: false forces a fresh connection, so DNS/TCP/TLS are measured every time.
    const req = lib.request(u, { method, headers, agent: false }, (res) => {
      t.firstByte = performance.now();
      let snippet = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (snippet.length < 500) snippet += chunk.slice(0, 500 - snippet.length);
      });
      res.on('end', () => {
        t.end = performance.now();
        done({ status: res.statusCode, headers: res.headers, bodySnippet: snippet });
      });
      res.on('error', (err) => done({ status: res.statusCode, error: { code: err.code, message: err.message } }));
    });

    req.on('socket', (socket) => {
      socket.on('lookup', () => { t.dns = performance.now(); });
      socket.on('connect', () => { t.connect = performance.now(); });
      socket.on('secureConnect', () => {
        t.tls = performance.now();
        cert = certInfo(socket.getPeerCertificate());
      });
    });

    req.on('error', (err) => {
      t.end = performance.now();
      const result = { status: null, error: { code: err.code ?? 'UNKNOWN', message: err.message } };
      if (u.protocol === 'https:' && isTlsError(err.code)) {
        readCertificate(u.hostname, Number(u.port) || 443).then((c) => { cert = c; done(result); });
      } else {
        done(result);
      }
    });

    timer = setTimeout(() => {
      const err = new Error(`No complete response within ${timeoutMs} ms`);
      err.code = 'APP_TIMEOUT';
      req.destroy(err);
    }, timeoutMs);

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Retry-After can be seconds ("30") or an HTTP date. Returns ms or null.
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

// Exponential backoff with jitter: base * 2^attempt, plus up to 20% random.
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 15000, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp + exp * 0.2 * random());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs a check with retries. Returns every attempt so the history shows the full story.
export async function checkWithRetry(endpoint, { maxRetries = 2, baseMs = 1000, maxWaitMs = 15000, request = timedRequest, wait = sleep } = {}) {
  const attempts = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await request(endpoint);
    const verdict = classify(result, endpoint);
    const record = { attempt, ts: new Date().toISOString(), ...result, ...verdict };
    attempts.push(record);

    if (verdict.ok || !verdict.retryable || attempt === maxRetries) break;

    const retryAfter = parseRetryAfter(result.headers?.['retry-after']);
    const delay = Math.min(maxWaitMs, retryAfter ?? backoffDelay(attempt, { baseMs, maxMs: maxWaitMs }));
    record.nextRetryInMs = delay;
    await wait(delay);
  }
  return attempts;
}