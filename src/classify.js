// Maps a raw result to a failure category, with a technical and a plain-language explanation.

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);

export const CATEGORIES = {
  ok: {
    retryable: false,
    plain: 'The service is working normally.',
  },
  dns: {
    retryable: true,
    plain: "The service's address could not be found. The domain may be misspelled, expired, or the DNS provider is having problems.",
  },
  connection_refused: {
    retryable: true,
    plain: 'The server is reachable but nothing is accepting connections. The service is probably down or a firewall is blocking it.',
  },
  connection_reset: {
    retryable: true,
    plain: 'The connection was cut off partway through. This often points to a proxy, load balancer or firewall in between.',
  },
  timeout: {
    retryable: true,
    plain: 'The service took too long to answer. It may be overloaded, or the request is doing too much work.',
  },
  tls: {
    retryable: false,
    plain: "The service's security certificate has a problem, so apps and browsers will refuse to connect. The provider must fix it on their server.",
  },
  auth: {
    retryable: false,
    plain: 'The service rejected the credentials. The API key or token is missing, wrong, expired, or lacks permission.',
  },
  rate_limit: {
    retryable: true,
    plain: 'Too many requests were sent in a short time, so the service is temporarily refusing more. Slowing down or raising the limit fixes this.',
  },
  server_error: {
    retryable: true,
    plain: "The service hit an error on its own side. This is the provider's problem, not the caller's.",
  },
  client_error: {
    retryable: false,
    plain: "The service didn't accept the request as sent. The URL, method or request body likely needs correcting.",
  },
  unexpected_status: {
    retryable: false,
    plain: 'The service answered, but not with the response that was expected.',
  },
  network: {
    retryable: true,
    plain: 'A network problem stopped the request from completing.',
  },
};

function errorCategory(code = '') {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (code === 'APP_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) return 'tls';
  return 'network';
}

function statusCategory(status, expected) {
  if (status === expected) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'unexpected_status';
}

export function classify(result, endpoint = {}) {
  const expected = endpoint.expectedStatus ?? 200;
  const category = result.error ? errorCategory(result.error.code) : statusCategory(result.status, expected);
  const info = CATEGORIES[category];

  const technical = result.error
    ? `${result.error.code}: ${result.error.message}`
    : `HTTP ${result.status} (expected ${expected})`;

  return { ok: category === 'ok', category, retryable: info.retryable, technical, plain: info.plain };
}
