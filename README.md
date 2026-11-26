# API Health Monitor

A Node.js service that checks REST APIs on a schedule and explains why they fail, not only that they failed.

For every check it records:

- **Status and latency**, broken down by network stage: DNS lookup, TCP connect, TLS handshake, server time (TTFB) and download.
- **The cause of a failure**, classified as DNS, connection refused, connection reset, timeout, TLS, auth (401/403), rate limit (429), server error (5xx) or client error (4xx). Each cause comes with a technical explanation and a plain-language one.
- **Retries** with exponential backoff and jitter. Rate-limited calls honour the `Retry-After` header. Auth and TLS failures are not retried, because retrying can't fix them.
- **TLS certificate expiry**, flagged when under 14 days.
- **Uptime history** in SQLite, shown as a 24-hour bar per endpoint.
- **STUN over UDP**, the protocol WebRTC voice and video use to discover a client's public address. The check builds RFC 5389 Binding Requests by hand, resends lost UDP packets, and decodes the XOR-MAPPED-ADDRESS reply. A failure usually means a firewall is blocking UDP, which breaks direct real-time calls.
- **One-click bug reports.** Each failing endpoint has a "Copy bug report" button that produces a Markdown ticket: summary, environment, impact (failing since when), a reproducible `curl` command, expected vs. actual result, diagnosis and every attempt's timings. API keys, tokens and auth headers are redacted.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite` module, so there is no native database driver to compile)

## Quick start

```bash
npm install
npm start            # monitors the public APIs in endpoints.json
```

Open http://localhost:3000.

### Offline demo with the mock API

`mock/server.js` is a local API that fails on purpose (503s that recover, 429s, 401s, slow responses), plus two STUN servers on UDP 3478 and 3479. The one on 3479 drops the first packet of every request, to show retransmission recovering from packet loss.

```bash
npm run mock         # terminal 1: mock API on port 4000
npm run start:local  # terminal 2: monitor using endpoints.local.json
```

### Tests

```bash
npm test
```

## Configuring endpoints

`endpoints.json` is a list of endpoints:

```json
{
  "id": "github",
  "name": "GitHub API",
  "url": "https://api.github.com/zen",
  "method": "GET",
  "headers": { "User-Agent": "api-health-monitor" },
  "expectedStatus": 200,
  "timeoutMs": 10000,
  "intervalSec": 60
}
```

Only `id` and `url` are required. Use another file with `node src/index.js my-endpoints.json`.

For a STUN check, set `"type": "stun"` and use a `stun:host:port` URL:

```json
{ "id": "stun-google", "name": "Google STUN", "type": "stun", "url": "stun:stun.l.google.com:19302", "timeoutMs": 3000 }
```

## API

| Route | Returns |
|---|---|
| `GET /api/status` | Latest result, 24h uptime, hourly buckets and cert expiry for every endpoint |
| `GET /api/history/:id` | The last 60 attempts for one endpoint, with timing breakdown and retry waits |
| `GET /api/bugreport/:id` | A Markdown bug report for the endpoint's latest check (secrets redacted) |

## Project structure

```
src/
  checker.js    HTTP(S) request with stage timings, retry with backoff, Retry-After parsing
  stun.js       STUN Binding Request over UDP, retransmission, XOR-MAPPED-ADDRESS decoding
  bugreport.js  Markdown bug report with a redacted, reproducible curl command
  classify.js   maps errors and status codes to causes, with technical and plain explanations
  db.js         SQLite storage and queries
  scheduler.js  runs each endpoint on its own interval, never overlapping
  server.js     Express JSON API and static dashboard
  index.js      loads config and starts everything
public/         dashboard (plain HTML and JavaScript)
mock/           local API that misbehaves on purpose
test/           unit tests (node:test)
```

## Roadmap

- [x] STUN/UDP check for WebRTC connectivity
- [x] "Copy bug report" with a reproducible curl command
- [ ] CORS preflight check
- [ ] Webhook alerts (Discord or Slack) on state changes
- [ ] Webhook receiver with HMAC signature verification
- [ ] Dockerfile and cloud deployment
