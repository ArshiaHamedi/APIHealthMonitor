// Builds a ready-to-paste bug report (JIRA, GitHub issue, email) for an endpoint's latest check.
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { CATEGORIES } from './classify.js';
import { parseStunUrl } from './stun.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Secrets never go into a report: these header values and query parameters are replaced.
const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;
const SENSITIVE_PARAMS = /^(api[_-]?key|key|token|access[_-]?token|secret|password|signature|sig)$/i;
const REDACTED = 'REDACTED';

export function redactUrl(url) {
  const u = new URL(url);
  for (const name of [...u.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.test(name)) u.searchParams.set(name, REDACTED);
  }
  return u.toString();
}

export function redactHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SENSITIVE_HEADERS.test(k) ? REDACTED : v]));
}

// POSIX shell quoting (bash, zsh, Git Bash).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// curl's -w timers are cumulative from the start, unlike the monitor's per-stage numbers.
const CURL_TIMINGS = '\\ndns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s first_byte=%{time_starttransfer}s total=%{time_total}s http=%{http_code}\\n';

export function curlCommand(endpoint) {
  const parts = ['curl -v', `-X ${endpoint.method ?? 'GET'}`];
  for (const [k, v] of Object.entries(redactHeaders(endpoint.headers))) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (endpoint.body) parts.push(`--data-raw ${shq(typeof endpoint.body === 'string' ? endpoint.body : JSON.stringify(endpoint.body))}`);
  parts.push(`--max-time ${Math.ceil((endpoint.timeoutMs ?? 10000) / 1000)}`);
  parts.push(`-w ${shq(CURL_TIMINGS)}`);
  parts.push(shq(redactUrl(endpoint.url)));
  return parts.join(' \\\n  ');
}

const ms = (v) => (v == null ? '-' : `${Math.round(v)} ms`);
const utc = (iso) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'n/a');

function attemptsTable(attempts) {
  const rows = attempts.map((a) => {
    const waited = a.next_retry_ms ? `${(a.next_retry_ms / 1000).toFixed(1)} s` : '-';
    const result = a.ok ? 'OK' : `${a.category}: ${a.technical}`;
    return `| ${a.attempt + 1} | ${utc(a.ts)} | ${result} | ${ms(a.dns_ms)} | ${ms(a.tcp_ms)} | ${ms(a.tls_ms)} | ${ms(a.ttfb_ms)} | ${ms(a.total_ms)} | ${waited} |`;
  });
  return [
    '| # | Time | Result | DNS | TCP | TLS | Server / RTT | Total | Wait before retry |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function reproduceSection(endpoint) {
  if (endpoint.type === 'stun') {
    const { host, port } = parseStunUrl(endpoint.url);
    return [
      `1. From the same network, send a STUN Binding Request (RFC 5389) over UDP to \`${host}:${port}\`.`,
      `   For example, with the Stuntman client: \`stunclient ${host} ${port}\``,
      '2. Compare the result with a different network (for example a phone hotspot) to rule out a local firewall.',
    ].join('\n');
  }
  return [
    '1. Run (bash, macOS Terminal or Git Bash; on Windows PowerShell use `curl.exe` and double quotes):',
    '',
    '```',
    curlCommand(endpoint),
    '```',
    '',
    '2. Compare the status line and the timing line printed at the end with the expected result below.',
  ].join('\n');
}

export function buildBugReport(endpoint, attempts, streak = {}) {
  if (!attempts.length) throw new Error(`No checks recorded yet for "${endpoint.id}"`);

  const last = attempts.at(-1);
  const isStun = endpoint.type === 'stun';
  const target = isStun ? `UDP ${endpoint.url}` : `${endpoint.method ?? 'GET'} ${redactUrl(endpoint.url)}`;
  const timeout = endpoint.timeoutMs ?? (isStun ? 3000 : 10000);
  const expected = isStun
    ? `A STUN Binding Success response with the client's public address, within ${timeout} ms.`
    : `HTTP ${endpoint.expectedStatus ?? 200} within ${timeout} ms.`;

  const sections = [
    `Summary: [API Health Monitor] ${endpoint.name} ${last.ok ? 'is healthy' : `failing: ${last.category}`} (${last.technical})`,
    '',
    '## Environment',
    `- Endpoint: \`${target}\``,
    `- Monitor: ${pkg.name} ${pkg.version}, Node ${process.version}, ${os.platform()} ${os.arch()}`,
    `- Report generated: ${utc(new Date().toISOString())}`,
    '',
    '## Impact',
    last.ok
      ? '- The latest check succeeded.'
      : `- Failing since ${utc(streak.firstFailure)} (${streak.failedChecks ?? 1} consecutive failed check${streak.failedChecks === 1 ? '' : 's'}). Last success: ${streak.lastSuccess ? utc(streak.lastSuccess) : 'none in recorded history'}.`,
    '',
    '## Steps to reproduce',
    reproduceSection(endpoint),
    '',
    '## Expected result',
    expected,
    '',
    '## Actual result',
    last.technical,
    '',
    '## Diagnosis',
    `- Category: \`${last.category}\``,
    `- In plain terms: ${CATEGORIES[last.category]?.plain ?? 'n/a'}`,
    `- Retries: ${attempts.length - 1} (${CATEGORIES[last.category]?.retryable ? 'this failure type is retried with backoff' : 'this failure type is not retried, because retrying cannot fix it'})`,
    '',
    '## Attempts in the latest check',
    attemptsTable(attempts),
  ];

  const certTo = attempts.map((a) => a.cert_valid_to).find(Boolean);
  if (certTo) {
    const days = Math.floor((Date.parse(certTo) - Date.now()) / 86400000);
    sections.push('', '## TLS certificate', `- ${days < 0 ? `Expired ${-days} days ago` : `Expires in ${days} days`} (${utc(certTo)})`);
  }

  if (last.body_snippet) {
    sections.push('', '## Response body (first 500 characters, review before sharing)', '```', last.body_snippet.trim(), '```');
  }

  return sections.join('\n');
}
