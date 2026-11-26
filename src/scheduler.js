import { randomUUID } from 'node:crypto';
import { checkWithRetry } from './checker.js';

// Runs each endpoint on its own interval. Skips a tick if the previous check is still running.
export function startScheduler(endpoints, db, { log = console.log } = {}) {
  const timers = [];

  for (const ep of endpoints) {
    let running = false;

    const run = async () => {
      if (running) return;
      running = true;
      try {
        const attempts = await checkWithRetry(ep);
        db.saveAttempts(ep.id, randomUUID(), attempts);
        const last = attempts.at(-1);
        const retries = attempts.length > 1 ? ` after ${attempts.length - 1} retr${attempts.length === 2 ? 'y' : 'ies'}` : '';
        log(`[${last.ts}] ${ep.name}: ${last.ok ? 'OK' : last.category} (${last.technical}, ${last.timings.total ?? '?'} ms)${retries}`);
      } catch (err) {
        log(`[scheduler] ${ep.name} check crashed: ${err.stack}`);
      } finally {
        running = false;
      }
    };

    run();
    timers.push(setInterval(run, (ep.intervalSec ?? 60) * 1000));
  }

  return () => timers.forEach(clearInterval);
}
