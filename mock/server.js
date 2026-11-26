// A local API that misbehaves on purpose, so every failure type can be demoed offline.
import http from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 4000);
let flakyCount = 0;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  switch (path) {
    case '/ok':
      return send(res, 200, { status: 'healthy' });

    case '/flaky':
      // Fails twice, then succeeds: shows the retry logic recovering.
      flakyCount++;
      return flakyCount % 3 === 0
        ? send(res, 200, { status: 'healthy', note: 'succeeded after failures' })
        : send(res, 503, { error: 'Service temporarily unavailable' });

    case '/rate-limited':
      return send(res, 429, { error: 'Too many requests' }, { 'Retry-After': '2' });

    case '/protected':
      return req.headers.authorization === 'Bearer demo-token'
        ? send(res, 200, { user: 'demo' })
        : send(res, 401, { error: 'Missing or invalid token' });

    case '/slow':
      return setTimeout(() => send(res, 200, { status: 'slow but fine' }), 5000);

    default:
      return send(res, 404, { error: `No route ${path}` });
  }
}).listen(port, () => console.log(`Mock API on http://localhost:${port}`));
