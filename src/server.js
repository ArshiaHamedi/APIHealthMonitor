import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CATEGORIES } from './classify.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOUR = 3600 * 1000;
const CERT_WARN_DAYS = 14;

// Worst outcome in a time bucket decides its colour.
function bucketState(rows) {
  if (rows.length === 0) return 'none';
  if (rows.every((r) => r.ok)) return 'up';
  if (rows.some((r) => r.ok)) return 'degraded';
  return 'down';
}

export function createServer(endpoints, db) {
  const app = express();
  app.use(express.static(publicDir));

  app.get('/api/status', (_req, res) => {
    const now = Date.now();
    const since = new Date(now - 24 * HOUR).toISOString();

    const items = endpoints.map((ep) => {
      const latest = db.latest(ep.id);
      const finals = db.finalsSince(ep.id, since);
      const upCount = finals.filter((r) => r.ok).length;

      const buckets = Array.from({ length: 24 }, (_, i) => {
        const start = now - (24 - i) * HOUR;
        return bucketState(finals.filter((r) => { const t = Date.parse(r.ts); return t >= start && t < start + HOUR; }));
      });

      const certValidTo = db.latestCert(ep.id);
      const certDaysLeft = certValidTo ? Math.floor((Date.parse(certValidTo) - now) / (24 * HOUR)) : null;

      return {
        id: ep.id,
        name: ep.name,
        method: ep.method ?? 'GET',
        url: ep.url,
        latest: latest && {
          ts: latest.ts,
          ok: !!latest.ok,
          status: latest.status,
          category: latest.category,
          technical: latest.technical,
          plain: CATEGORIES[latest.category]?.plain,
          totalMs: latest.total_ms,
        },
        uptime24h: finals.length ? Math.round((upCount / finals.length) * 1000) / 10 : null,
        buckets,
        cert: certValidTo && { validTo: certValidTo, daysLeft: certDaysLeft, warning: certDaysLeft < CERT_WARN_DAYS },
      };
    });

    res.json({ generatedAt: new Date(now).toISOString(), endpoints: items });
  });

  app.get('/api/history/:id', (req, res) => {
    const ep = endpoints.find((e) => e.id === req.params.id);
    if (!ep) return res.status(404).json({ error: `Unknown endpoint "${req.params.id}"` });
    const rows = db.history(ep.id).map((r) => ({ ...r, plain: CATEGORIES[r.category]?.plain }));
    res.json({ endpoint: ep, history: rows });
  });

  return app;
}
