/**
 * Retroactive cleanup for the tightened experience cap (reject > profile.search.experience.max,
 * currently 5 — see job_search_profile.json). Re-scores every currently-matched (visible,
 * non-dismissed) dashboard job against the corrected experience check and dismisses any
 * job that now fails it, with diagnostic reason `experience-over-cap-5yr`.
 *
 * Two real parser gaps were fixed alongside this cleanup (experience-parser.ts):
 *   - "minimum of 6 years" (filler word between "minimum" and the number) previously
 *     wasn't recognised by the minimum-phrase pattern.
 *   - Bare German "Erfahrung" (without the "Berufs-" prefix) previously wasn't
 *     recognised as an experience keyword at all.
 * Jobs whose only 6+-year signal was phrased one of these two ways could have slipped
 * through before; this run catches them retroactively.
 *
 * Does NOT delete anything — dismissed jobs keep their decision history for the
 * learning loop (same path as a manual dashboard dismiss).
 *
 * Run with: npx ts-node scripts/purge-experience-cap-5yr.ts
 * Requires a reachable Redis (dashboard jobs live there, not in Postgres — the
 * job_decisions Postgres table is applied/dismissed HISTORY only, not the live queue).
 */

import 'dotenv/config';
import {
  redisGetDashboardJobs,
  redisDeleteDashboardJob,
  redisRecordJobDecisionHistory,
  isRedisAvailable,
} from '../src/job-search/redis-store';
import { markJobDecision } from '../src/job-search/run';
import { loadSearchProfile } from '../src/job-search/profile';
import { extractRequiredMinimumYears } from '../src/job-search/experience-parser';
import { JobPosting } from '../src/job-search/types';

// Mirrors matcher.ts's effectiveExperience logic exactly: prefer the structured field,
// fall back to text-parsing the description when it's absent.
function resolveMinimumYears(job: JobPosting): number | null {
  if (job.experienceLevelMinimum !== null) return job.experienceLevelMinimum;
  return extractRequiredMinimumYears(job.description ?? '');
}

async function main() {
  if (!isRedisAvailable()) {
    console.error('[purge-experience-cap-5yr] Redis not configured — nothing to do. Run this from an environment with the production Redis reachable.');
    process.exit(1);
  }

  const profile = await loadSearchProfile();
  const maxYears = profile.search.experience.max;

  const entries = await redisGetDashboardJobs();
  console.log(`[purge-experience-cap-5yr] scanning ${entries.length} currently-matched dashboard job(s) against the >${maxYears}-year cap`);

  const purged: Array<{ company: string; title: string; minYears: number }> = [];

  for (const entry of entries) {
    const m = entry.match as { job?: JobPosting; score?: number } | null;
    const job = m?.job;
    if (!job) continue;

    const minYears = resolveMinimumYears(job);
    if (minYears === null || minYears <= maxYears) continue;

    console.log(`[purge-experience-cap-5yr] DISMISS "${job.title}" @ ${job.company} — ${minYears}+ years required (cap is ${maxYears})`);

    await redisRecordJobDecisionHistory('dismissed', {
      title: job.title,
      company: job.company,
      countryCode: job.countryCode ?? null,
      score: m?.score ?? 0,
      foundAt: entry.foundAt,
    });
    await markJobDecision('dismissed', job.canonicalUrl, {
      title: job.title,
      company: job.company,
      score: m?.score,
    });
    await redisDeleteDashboardJob(entry.jobId);

    purged.push({ company: job.company, title: job.title, minYears });
  }

  console.log(`\n[purge-experience-cap-5yr] === SUMMARY: ${purged.length} job(s) purged (reason: experience-over-cap-5yr) ===`);
  for (const { company, title, minYears } of purged) {
    console.log(`  - ${company} — ${title} (${minYears}+ years required)`);
  }
  if (purged.length === 0) {
    console.log('No currently-matched jobs exceed the cap — nothing purged.');
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
