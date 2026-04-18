import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { scoreJob } from './matcher';
import { loadSearchProfile } from './profile';
import { writeReport } from './report';
import { WttjJobsSource } from './sources/wttj.source';
import {
  addUrlsToStore,
  readJsonFile,
  readUrlSet,
  removeUrlsFromStore,
  writeJsonFile,
} from './storage';
import { sendTelegramMessages } from './telegram';
import { JobSearchState, MatchResult, RunSummary, SearchProfile } from './types';

const DEFAULT_SEEN_FILE = 'job_search_seen.json';
const DEFAULT_APPLIED_FILE = 'job_search_applied.json';
const DEFAULT_DISMISSED_FILE = 'job_search_dismissed.json';
const DEFAULT_REPORT_FILE = 'job_search_latest.md';
const DEFAULT_STATE_FILE = 'job_search_state.json';
const ACTIVE_SOURCES = ['welcometothejungle.com'];
const BLOCKED_SOURCES = ['wellfound.com', 'startup.jobs', 'indeed.com', 'linkedin.com'];

export async function runJobSearchOnce(
  overrideProfile?: SearchProfile,
): Promise<RunSummary> {
  const profile = overrideProfile ?? (await loadSearchProfile());
  const seenFile = process.env.JOB_SEARCH_SEEN_FILE ?? DEFAULT_SEEN_FILE;
  const appliedFile = process.env.JOB_SEARCH_APPLIED_FILE ?? DEFAULT_APPLIED_FILE;
  const dismissedFile = process.env.JOB_SEARCH_DISMISSED_FILE ?? DEFAULT_DISMISSED_FILE;
  const reportPath = process.env.JOB_SEARCH_REPORT_PATH ?? DEFAULT_REPORT_FILE;
  const stateFile = process.env.JOB_SEARCH_STATE_FILE ?? DEFAULT_STATE_FILE;
  const seenTtlHours = profile.search.seenTtlHours ?? 1;
  const seenTtlMs = seenTtlHours * 60 * 60 * 1000;
  const maxResults = Number(process.env.JOB_SEARCH_MAX_RESULTS ?? profile.search.maxResults);

  await Promise.all([ensureOutputDir(reportPath), ensureOutputDir(stateFile)]);

  await updateState(stateFile, (current) => ({
    ...current,
    lastRunAt: new Date().toISOString(),
    lastRunStatus: 'running',
    lastError: null,
  }), profile);

  try {
    const [seenUrls, appliedUrls, dismissedUrls] = await Promise.all([
      readUrlSet(seenFile, 'seen_urls', { ttlMs: seenTtlMs }),
      readUrlSet(appliedFile, 'applied_urls'),
      readUrlSet(dismissedFile, 'dismissed_urls'),
    ]);

    const source = new WttjJobsSource();
    const jobs = await source.fetch(profile.search.queries, profile.search);

    const baseFilter = (job: { canonicalUrl: string }) =>
      !seenUrls.has(job.canonicalUrl) &&
      !appliedUrls.has(job.canonicalUrl) &&
      !dismissedUrls.has(job.canonicalUrl);

    const freshJobs = jobs.filter(
      (job) =>
        job.publishedAtTimestamp * 1000 >=
          Date.now() - profile.search.maxAgeHours * 60 * 60 * 1000 && baseFilter(job),
    );

    let matches = freshJobs
      .map((job) => scoreJob(job, profile))
      .filter((match): match is MatchResult => match !== null)
      .sort(sortMatches)
      .slice(0, maxResults);

    let effectiveFreshJobs = freshJobs;
    if (matches.length === 0) {
      const fallbackHours = Math.max(profile.search.maxAgeHours, 24 * 30);
      const fallbackJobs = jobs.filter(
        (job) =>
          job.publishedAtTimestamp * 1000 >= Date.now() - fallbackHours * 60 * 60 * 1000 &&
          baseFilter(job),
      );

      const fallbackMatches = fallbackJobs
        .map((job) => scoreJob(job, profile))
        .filter((match): match is MatchResult => match !== null)
        .sort(sortMatches)
        .slice(0, maxResults);

      if (fallbackMatches.length > 0) {
        matches = fallbackMatches;
        effectiveFreshJobs = fallbackJobs;
      }
    }

    const reportLocation = await writeReport(reportPath, matches, BLOCKED_SOURCES);
    const messages = buildTelegramPayload(matches, reportLocation, profile);

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId && messages.length > 0) {
      await sendTelegramMessages(botToken, chatId, messages);
    }

    await addUrlsToStore(
      seenFile,
      'seen_urls',
      matches.map((match) => match.job.canonicalUrl),
    );

    const summary: RunSummary = {
      reportPath: resolve(reportLocation),
      allJobsCount: jobs.length,
      freshJobsCount: effectiveFreshJobs.length,
      matchCount: matches.length,
      matches,
      blockedSources: BLOCKED_SOURCES,
      activeSources: ACTIVE_SOURCES,
      ranAt: new Date().toISOString(),
    };

    await updateState(
      stateFile,
      () => ({
        lastRunAt: summary.ranAt,
        lastSuccessAt: summary.ranAt,
        lastRunStatus: 'success',
        lastError: null,
        latestMatches: summary.matches,
        reportPath: summary.reportPath,
        blockedSources: summary.blockedSources,
        activeSources: summary.activeSources,
        stats: {
          allJobsCount: summary.allJobsCount,
          freshJobsCount: summary.freshJobsCount,
          matchCount: summary.matchCount,
        },
        intervalMinutes: getIntervalMinutes(profile),
        seenTtlHours,
        nextRunAt: new Date(Date.now() + getIntervalMinutes(profile) * 60 * 1000).toISOString(),
      }),
      profile,
    );

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateState(
      stateFile,
      (current) => ({
        ...current,
        lastRunAt: new Date().toISOString(),
        lastRunStatus: 'error',
        lastError: message,
        nextRunAt: new Date(Date.now() + getIntervalMinutes(profile) * 60 * 1000).toISOString(),
      }),
      profile,
    );
    throw error;
  }
}

export async function markJobDecision(
  decision: 'applied' | 'dismissed',
  rawUrl: string,
): Promise<void> {
  const normalizedUrl = rawUrl.trim();
  const appliedFile = process.env.JOB_SEARCH_APPLIED_FILE ?? DEFAULT_APPLIED_FILE;
  const dismissedFile = process.env.JOB_SEARCH_DISMISSED_FILE ?? DEFAULT_DISMISSED_FILE;
  const seenFile = process.env.JOB_SEARCH_SEEN_FILE ?? DEFAULT_SEEN_FILE;
  const stateFile = process.env.JOB_SEARCH_STATE_FILE ?? DEFAULT_STATE_FILE;

  if (decision === 'applied') {
    await addUrlsToStore(appliedFile, 'applied_urls', [normalizedUrl]);
  } else {
    await addUrlsToStore(dismissedFile, 'dismissed_urls', [normalizedUrl]);
  }

  await removeUrlsFromStore(seenFile, 'seen_urls', [normalizedUrl]);

  await updateState(stateFile, (current) => ({
    ...current,
    latestMatches: current.latestMatches.filter((match) => match.job.canonicalUrl !== normalizedUrl),
  }));
}

export async function readJobSearchState(): Promise<JobSearchState> {
  const stateFile = process.env.JOB_SEARCH_STATE_FILE ?? DEFAULT_STATE_FILE;
  return readJsonFile<JobSearchState>(stateFile, buildEmptyState());
}

function buildTelegramPayload(
  matches: MatchResult[],
  reportPath: string,
  profile: SearchProfile,
): string[] {
  if (matches.length === 0) {
    return [
      [
        `No new strong matches for ${profile.candidate.name} in this run.`,
        `Active source: ${ACTIVE_SOURCES.join(', ')}`,
        `Blocked sources: ${BLOCKED_SOURCES.join(', ')}`,
        `Report path: ${resolve(reportPath)}`,
      ].join('\n'),
    ];
  }

  const lines = [
    `Found ${matches.length} new strong matches for ${profile.candidate.name}.`,
    `Active source: ${ACTIVE_SOURCES.join(', ')}`,
    '',
  ];

  for (const [index, match] of matches.entries()) {
    lines.push(
      `${index + 1}. ${match.job.title} — ${match.job.company}\n${match.job.locationLabel} | ${match.job.workMode} | ${match.salaryLabel} | ${match.score}%\nApply: ${match.job.applyUrl}\nWhy: ${match.reasons.join('; ')}`,
    );
    lines.push('');
  }

  lines.push(`Report path: ${resolve(reportPath)}`);
  return [lines.join('\n')];
}

function sortMatches(left: MatchResult, right: MatchResult): number {
  return (
    right.startupScore - left.startupScore ||
    right.score - left.score ||
    right.job.sourcePriority - left.job.sourcePriority ||
    right.job.publishedAtTimestamp - left.job.publishedAtTimestamp
  );
}

function getIntervalMinutes(profile: SearchProfile): number {
  const envInterval = Number(process.env.CHECK_INTERVAL_MINUTES ?? 0);
  if (envInterval > 0) {
    return envInterval;
  }

  return Math.max(15, Math.round(profile.search.checkIntervalHours * 60));
}

async function updateState(
  stateFile: string,
  updater: (current: JobSearchState) => JobSearchState,
  profile?: SearchProfile,
): Promise<void> {
  const currentState = await readJsonFile<JobSearchState>(stateFile, buildEmptyState(profile));
  const nextState = updater(currentState);
  await writeJsonFile(stateFile, nextState);
}

function buildEmptyState(profile?: SearchProfile): JobSearchState {
  const intervalMinutes = profile ? getIntervalMinutes(profile) : 60;
  const seenTtlHours = profile?.search.seenTtlHours ?? 1;

  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastRunStatus: 'idle',
    lastError: null,
    latestMatches: [],
    reportPath: null,
    blockedSources: BLOCKED_SOURCES,
    activeSources: ACTIVE_SOURCES,
    stats: {
      allJobsCount: 0,
      freshJobsCount: 0,
      matchCount: 0,
    },
    intervalMinutes,
    seenTtlHours,
    nextRunAt: null,
  };
}

async function ensureOutputDir(filePath: string): Promise<void> {
  await mkdir(dirname(resolve(filePath)), { recursive: true });
}

async function cli(): Promise<void> {
  const summary = await runJobSearchOnce();
  console.log(`Saved report to ${summary.reportPath}`);
  console.log(
    `Found ${summary.matchCount} matching jobs out of ${summary.freshJobsCount} fresh jobs (${summary.allJobsCount} total fetched).`,
  );
}

if (require.main === module) {
  cli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
