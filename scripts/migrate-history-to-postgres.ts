/**
 * One-time migration: copy applied/dismissed history from Redis to PostgreSQL.
 * Run with: npx ts-node scripts/migrate-history-to-postgres.ts
 * Does NOT delete from Redis.
 */

import 'dotenv/config';
import { redisGetJobDecisionHistory } from '../src/job-search/redis-store';
import { initDatabase, saveJobDecision } from '../src/database/database.service';

async function main() {
  await initDatabase();

  const [applied, dismissed] = await Promise.all([
    redisGetJobDecisionHistory('applied', 100),
    redisGetJobDecisionHistory('dismissed', 100),
  ]);

  console.log(`[migration] found ${applied.length} applied, ${dismissed.length} dismissed in Redis`);

  let ok = 0;
  for (const e of applied) {
    try {
      await saveJobDecision({
        jobUrl: `redis-migrated:applied:${e.company}:${e.title}`,
        jobTitle: e.title,
        company: e.company,
        source: 'redis-migration',
        matcherScore: e.score,
        aiScore: e.score,
        decision: 'applied',
        country: e.countryCode ?? undefined,
      });
      ok++;
    } catch (err) {
      console.error(`[migration] applied skip: ${e.title}`, (err as Error).message);
    }
  }

  for (const e of dismissed) {
    try {
      await saveJobDecision({
        jobUrl: `redis-migrated:dismissed:${e.company}:${e.title}`,
        jobTitle: e.title,
        company: e.company,
        source: 'redis-migration',
        matcherScore: e.score,
        aiScore: e.score,
        decision: 'dismissed',
        country: e.countryCode ?? undefined,
      });
      ok++;
    } catch (err) {
      console.error(`[migration] dismissed skip: ${e.title}`, (err as Error).message);
    }
  }

  console.log(`[migration] ${ok} applied + dismissed migrated to PostgreSQL`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
