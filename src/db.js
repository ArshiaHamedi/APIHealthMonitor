import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = 'data/monitor.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS checks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      check_id      TEXT NOT NULL,      -- groups the attempts of one scheduled check
      endpoint_id   TEXT NOT NULL,
      ts            TEXT NOT NULL,
      attempt       INTEGER NOT NULL,
      final         INTEGER NOT NULL,   -- 1 = last attempt of the check
      ok            INTEGER NOT NULL,
      status        INTEGER,
      category      TEXT NOT NULL,
      technical     TEXT,
      dns_ms REAL, tcp_ms REAL, tls_ms REAL, ttfb_ms REAL, download_ms REAL, total_ms REAL,
      next_retry_ms INTEGER,
      cert_valid_to TEXT,
      body_snippet  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checks_endpoint_ts ON checks (endpoint_id, ts);
  `);

  // Migration: databases created before the STUN check have no detail_json column.
  const columns = db.prepare(`PRAGMA table_info(checks)`).all().map((c) => c.name);
  if (!columns.includes('detail_json')) db.exec(`ALTER TABLE checks ADD COLUMN detail_json TEXT`);

  const insert = db.prepare(`
    INSERT INTO checks (check_id, endpoint_id, ts, attempt, final, ok, status, category, technical,
      dns_ms, tcp_ms, tls_ms, ttfb_ms, download_ms, total_ms, next_retry_ms, cert_valid_to, body_snippet, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    raw: db,

    saveAttempts(endpointId, checkId, attempts) {
      attempts.forEach((a, i) => {
        const t = a.timings ?? {};
        insert.run(
          checkId, endpointId, a.ts, a.attempt, i === attempts.length - 1 ? 1 : 0, a.ok ? 1 : 0,
          a.status ?? null, a.category, a.technical ?? null,
          t.dns ?? null, t.tcp ?? null, t.tls ?? null, t.ttfb ?? null, t.download ?? null, t.total ?? null,
          a.nextRetryInMs ?? null, a.cert?.validTo ?? null, a.bodySnippet ?? null,
          a.stun ? JSON.stringify(a.stun) : null,
        );
      });
    },

    latest(endpointId) {
      return db.prepare(`SELECT * FROM checks WHERE endpoint_id = ? AND final = 1 ORDER BY id DESC LIMIT 1`).get(endpointId);
    },

    latestCert(endpointId) {
      return db.prepare(`SELECT cert_valid_to FROM checks WHERE endpoint_id = ? AND cert_valid_to IS NOT NULL ORDER BY id DESC LIMIT 1`).get(endpointId)?.cert_valid_to ?? null;
    },

    finalsSince(endpointId, sinceIso) {
      return db.prepare(`SELECT ts, ok, category, total_ms FROM checks WHERE endpoint_id = ? AND final = 1 AND ts >= ? ORDER BY ts`).all(endpointId, sinceIso);
    },

    // All attempts of the most recent check, in order.
    lastCheck(endpointId) {
      const last = db.prepare(`SELECT check_id FROM checks WHERE endpoint_id = ? ORDER BY id DESC LIMIT 1`).get(endpointId);
      if (!last) return [];
      return db.prepare(`SELECT * FROM checks WHERE check_id = ? ORDER BY attempt`).all(last.check_id);
    },

    // When the current run of failures started, and how many checks have failed since the last success.
    failureStreak(endpointId) {
      const lastOk = db.prepare(`SELECT ts FROM checks WHERE endpoint_id = ? AND final = 1 AND ok = 1 ORDER BY id DESC LIMIT 1`).get(endpointId)?.ts ?? null;
      const streak = db.prepare(`SELECT MIN(ts) AS firstFailure, COUNT(*) AS failedChecks FROM checks WHERE endpoint_id = ? AND final = 1 AND ok = 0 AND ts > ?`).get(endpointId, lastOk ?? '');
      return { lastSuccess: lastOk, firstFailure: streak.firstFailure, failedChecks: streak.failedChecks };
    },

    history(endpointId, limit = 60) {
      return db.prepare(`SELECT * FROM checks WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?`).all(endpointId, limit);
    },
  };
}
