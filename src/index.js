import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { createServer } from './server.js';

// Usage: node src/index.js [config.json]   (defaults to endpoints.json)
const configPath = process.argv[2] ?? process.env.CONFIG ?? 'endpoints.json';
const port = Number(process.env.PORT ?? 3000);

const endpoints = JSON.parse(readFileSync(configPath, 'utf8'));
const ids = new Set();
for (const ep of endpoints) {
  if (!ep.id || !ep.url) throw new Error(`Every endpoint needs an "id" and a "url": ${JSON.stringify(ep)}`);
  if (ids.has(ep.id)) throw new Error(`Duplicate endpoint id "${ep.id}"`);
  ids.add(ep.id);
}

const db = openDb(process.env.DB_PATH ?? 'data/monitor.db');
startScheduler(endpoints, db);
createServer(endpoints, db).listen(port, () => {
  console.log(`Monitoring ${endpoints.length} endpoints from ${configPath}`);
  console.log(`Dashboard: http://localhost:${port}`);
});
