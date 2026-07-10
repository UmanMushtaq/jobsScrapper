/**
 * Retroactive cleanup for the July 8 2026 manual-review rules — re-scores every
 * currently-matched (visible, non-dismissed) dashboard job against the 7 new
 * deterministic rules and dismisses any job that now fails one of them.
 *
 * Does NOT delete anything — dismissed jobs keep their decision history for the
 * learning loop (same path as a manual dashboard dismiss).
 *
 * Run with: npx ts-node scripts/purge-new-rules.ts
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
import { isRejectedCompany } from '../src/job-search/rejected-companies';
import { evaluateLanguageRequirement } from '../src/job-search/language-requirement-filter';
import { extractRequiredMinimumYears } from '../src/job-search/experience-parser';
import { hasNoAiApplicationPolicy } from '../src/job-search/no-ai-policy-filter';
import { isMarketingEngineeringRole } from '../src/job-search/stack-filter';
import { US_TIMEZONE_OVERLAP_PATTERNS } from '../src/job-search/sources/location-filter';
import { JobPosting } from '../src/job-search/types';

interface RuleHit {
  rule: string;
  detail: string;
}

function evaluateNewRules(job: JobPosting, targetCountryCodes: string[], experienceMaxYears: number): RuleHit | null {
  if (isRejectedCompany(job.company)) {
    return { rule: 'rejected-company', detail: job.company };
  }

  const languageResult = evaluateLanguageRequirement(job.requiredLanguages, job.description);
  if (languageResult.reject) {
    return { rule: 'language-requirement', detail: languageResult.reason };
  }

  const minYears = extractRequiredMinimumYears(job.description ?? '');
  if (minYears !== null && minYears > experienceMaxYears) {
    return { rule: 'experience-over-cap', detail: `${minYears}+ years required` };
  }

  if (
    (job.workMode === 'on-site' || job.workMode === 'hybrid') &&
    job.countryCode &&
    targetCountryCodes.length > 0 &&
    !targetCountryCodes.includes(job.countryCode)
  ) {
    return { rule: 'location-outside-targets', detail: `${job.workMode} in ${job.countryCode}` };
  }

  const noAiResult = hasNoAiApplicationPolicy(job.description);
  if (noAiResult.reject) {
    return { rule: 'no-ai-application-policy', detail: noAiResult.reason };
  }

  const marketingResult = isMarketingEngineeringRole(job.title, job.description);
  if (marketingResult.reject) {
    return { rule: 'role-type-marketing-engineering', detail: marketingResult.reason };
  }

  if (job.workMode === 'remote') {
    const scanText = `${job.locationLabel ?? ''} ${(job.description ?? '').slice(0, 1500)}`;
    const timezoneMatch = US_TIMEZONE_OVERLAP_PATTERNS.find((p) => p.test(scanText));
    if (timezoneMatch) {
      return { rule: 'remote-us-timezone', detail: `matched ${timezoneMatch}` };
    }
  }

  return null;
}

async function main() {
  if (!isRedisAvailable()) {
    console.error('[purge-new-rules] Redis not configured — nothing to do. Run this from an environment with the production Redis reachable.');
    process.exit(1);
  }

  const profile = await loadSearchProfile();
  const targetCountryCodes = profile.search.targetCountryCodes ?? [];

  const entries = await redisGetDashboardJobs();
  console.log(`[purge-new-rules] scanning ${entries.length} currently-matched dashboard job(s)`);

  const summary = new Map<string, Array<{ company: string; title: string }>>();

  for (const entry of entries) {
    const m = entry.match as { job?: JobPosting; score?: number } | null;
    const job = m?.job;
    if (!job) continue;

    const hit = evaluateNewRules(job, targetCountryCodes, profile.search.experience.max);
    if (!hit) continue;

    console.log(`[purge-new-rules] DISMISS "${job.title}" @ ${job.company} — ${hit.rule} (${hit.detail})`);

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

    const list = summary.get(hit.rule) ?? [];
    list.push({ company: job.company, title: job.title });
    summary.set(hit.rule, list);
  }

  const totalPurged = Array.from(summary.values()).reduce((sum, list) => sum + list.length, 0);
  console.log(`\n[purge-new-rules] === SUMMARY: ${totalPurged} job(s) purged across ${summary.size} rule(s) ===`);
  for (const [rule, list] of summary.entries()) {
    console.log(`\n${rule}: ${list.length}`);
    for (const { company, title } of list) {
      console.log(`  - ${company} — ${title}`);
    }
  }
  if (totalPurged === 0) {
    console.log('No jobs matched any new rule — nothing purged.');
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
