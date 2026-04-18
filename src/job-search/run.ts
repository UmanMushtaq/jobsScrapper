import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scoreJob } from './matcher';
import { loadSearchProfile } from './profile';
import { writeReport } from './report';
import { JobSourceRegistry } from './sources/registry';
import { WttjJobsSource } from './sources/wttj.source';
import { AngelListSource, EuresJobsSource, IndeedJobsSource } from './sources/multi-source';
import { addUrlsToStore, readUrlSet } from './storage';
import { sendTelegramMessages } from './telegram';
import { MatchResult } from './types';

const DEFAULT_SEEN_FILE = 'job_search_seen.json';
const DEFAULT_APPLIED_FILE = 'job_search_applied.json';
const DEFAULT_REPORT_FILE = 'job_search_latest.md';

async function main(): Promise<void> {
  const profile = await loadSearchProfile();
  console.log(`🤖 Job Search Bot Started (Multi-platform)`);
  console.log(`📋 Profile: ${profile.candidate.name} (${profile.candidate.location})`);
  console.log(`---`);

  await runJobSearch(profile);
}

async function runJobSearch(profile: any): Promise<void> {
  const seenFile = process.env.JOB_SEARCH_SEEN_FILE ?? DEFAULT_SEEN_FILE;
  const appliedFile = process.env.JOB_SEARCH_APPLIED_FILE ?? DEFAULT_APPLIED_FILE;
  const reportPath = process.env.JOB_SEARCH_REPORT_PATH ?? DEFAULT_REPORT_FILE;

  await ensureOutputDir(reportPath);

  const [seenUrls, appliedUrls] = await Promise.all([
    readUrlSet(seenFile, 'seen_urls'),
    readUrlSet(appliedFile, 'applied_urls'),
  ]);

  const registry = new JobSourceRegistry();

  registry.register(new WttjJobsSource());
  registry.register(new AngelListSource());
  registry.register(new EuresJobsSource());
  registry.register(new IndeedJobsSource());

  const jobs = await registry.fetchFromAll([], profile.search);

  console.log(`[DEBUG] Total jobs from all platforms: ${jobs.length}`);

  const filteredJobs = jobs.filter(
    (job) => !seenUrls.has(job.canonicalUrl) && !appliedUrls.has(job.canonicalUrl)
  );

  console.log(`[DEBUG] After seen/applied filter: ${filteredJobs.length} jobs`);

  const scoredMatches = filteredJobs
    .map((job) => scoreJob(job, profile))
    .filter((match): match is MatchResult => match !== null);

  console.log(`[DEBUG] After scoring: ${scoredMatches.length} matches`);

  const reportLocation = await writeReport(reportPath, scoredMatches, ['wellfound.com', 'startup.jobs']);
  const messages = buildTelegramPayload(scoredMatches, reportLocation, profile);

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (botToken && chatId && messages.length > 0) {
    await sendTelegramMessages(botToken, chatId, messages);
    console.log(`✅ Sent ${messages.length} message(s) to Telegram`);
  }

  await addUrlsToStore(seenFile, 'seen_urls', scoredMatches.map(m => m.job.canonicalUrl));

  console.log(`✅ Saved report to ${resolve(reportLocation)}`);
  console.log(`📊 Found ${scoredMatches.length} new matching jobs.`);
}

function buildTelegramPayload(matches: MatchResult[], reportPath: string, profile: any): string[] {
  if (matches.length === 0) return [`No new matching jobs found.`];

  const header = [`🎯 Found ${matches.length} new matching jobs for ${profile.candidate.name}`];
  const jobLines = matches.map((match, i) => 
    `${i+1}. ${match.job.title} — ${match.job.company}\n${match.job.locationLabel} | ${match.job.workMode}\nApply: ${match.job.applyUrl}`
  );

  return [[...header, ...jobLines, `\nReport: ${resolve(reportPath)}`].join('\n\n')];
}

async function ensureOutputDir(filePath: string): Promise<void> {
  await mkdir(dirname(resolve(filePath)), { recursive: true });
}

main().catch(console.error);