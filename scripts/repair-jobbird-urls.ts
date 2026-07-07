/**
 * One-off repair: fix jobbird.nl job_decisions rows saved with the missing-slash URL
 * bug (e.g. "https://www.jobbird.com25360359-backend-developer" instead of
 * "https://www.jobbird.com/nl/vacature/25360359-backend-developer"), caused by
 * jobbird.source.ts's old naive string concatenation (fixed in jobbird.source.ts).
 *
 * Run with: npx ts-node scripts/repair-jobbird-urls.ts
 * Requires DATABASE_URL in the environment (not run here — this sandbox has no
 * DATABASE_URL/Supabase access; run this from wherever the production DB is reachable).
 */

import 'dotenv/config';
import { Pool } from 'pg';

const BROKEN_PATTERN = /^https:\/\/www\.jobbird\.com(\d.*)$/;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[repair-jobbird] DATABASE_URL not set — nothing to do');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query<{ id: number; job_url: string }>(
    `SELECT id, job_url FROM job_decisions WHERE job_url ~ '^https://www\\.jobbird\\.com[0-9]'`,
  );

  console.log(`[repair-jobbird] found ${rows.length} broken row(s)`);

  let fixed = 0;
  let skippedConflicts = 0;
  for (const row of rows) {
    const match = row.job_url.match(BROKEN_PATTERN);
    if (!match) continue;
    const repaired = `https://www.jobbird.com/nl/vacature/${match[1]}`;
    try {
      await pool.query('UPDATE job_decisions SET job_url = $1 WHERE id = $2', [repaired, row.id]);
      console.log(`[repair-jobbird] fixed #${row.id}: ${row.job_url} -> ${repaired}`);
      fixed++;
    } catch (err) {
      // UNIQUE(job_url) conflict — a correctly-shaped row for the same job already exists.
      console.warn(`[repair-jobbird] skip #${row.id} (conflict): ${(err as Error).message}`);
      skippedConflicts++;
    }
  }

  console.log(`[repair-jobbird] done — fixed ${fixed}, skipped ${skippedConflicts} conflict(s)`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
