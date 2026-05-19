import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { enrichMatch } from './ai-enrichment';
import { checkFollowups } from './followup';
import { scoreJob } from './matcher';
import { loadSearchProfile } from './profile';
import { writeReport } from './report';
import { AdzunaJobsSource } from './sources/adzuna.source';
import { ApecJobsSource } from './sources/apec.source';
import { ArbeitnowJobsSource } from './sources/arbeitnow.source';
import { FranceTravailJobsSource } from './sources/france-travail.source';
import { GreenhouseJobsSource } from './sources/greenhouse.source';
import { HackerNewsJobsSource } from './sources/hackernews.source';
import { RemoteOKJobsSource } from './sources/remoteok.source';
import { RemotiveJobsSource } from './sources/remotive.source';
import { WellfoundJobsSource } from './sources/wellfound.source';
import { WttjJobsSource } from './sources/wttj.source';
import {
  addUrlsToStore,
  readJsonFile,
  readUrlSet,
  removeUrlsFromStore,
  writeJsonFile,
} from './storage';
import { sendTelegramMessages } from './telegram';
import { JobPosting, JobSearchState, MatchResult, RunSummary, SearchProfile } from './types';

const DEFAULT_SEEN_FILE = 'job_search_seen.json';
const DEFAULT_APPLIED_FILE = 'job_search_applied.json';
const DEFAULT_DISMISSED_FILE = 'job_search_dismissed.json';
const DEFAULT_SENT_FILE = 'job_search_sent.json';
const DEFAULT_REPORT_FILE = 'job_search_latest.md';
const DEFAULT_STATE_FILE = 'job_search_state.json';
const ACTIVE_SOURCES = [
  'welcometothejungle.com', 'wellfound.com', 'adzuna.com', 'francetravail.fr',
  'apec.fr', 'greenhouse.io', 'remotive.com', 'remoteok.com', 'arbeitnow.com',
  'news.ycombinator.com',
];
const BLOCKED_SOURCES = ['startup.jobs', 'indeed.com', 'linkedin.com'];

export async function runJobSearchOnce(
  overrideProfile?: SearchProfile,
): Promise<RunSummary> {
  const profile = overrideProfile ?? (await loadSearchProfile());
  const seenFile = process.env.JOB_SEARCH_SEEN_FILE ?? DEFAULT_SEEN_FILE;
  const appliedFile = process.env.JOB_SEARCH_APPLIED_FILE ?? DEFAULT_APPLIED_FILE;
  const dismissedFile = process.env.JOB_SEARCH_DISMISSED_FILE ?? DEFAULT_DISMISSED_FILE;
  // Derive sent file from same directory as seen file so it lands on the persistent disk
  const sentFile = process.env.JOB_SEARCH_SENT_FILE ?? resolve(dirname(resolve(seenFile)), 'job_search_sent.json');
  const reportPath = process.env.JOB_SEARCH_REPORT_PATH ?? DEFAULT_REPORT_FILE;
  const stateFile = process.env.JOB_SEARCH_STATE_FILE ?? DEFAULT_STATE_FILE;
  const seenTtlHours = profile.search.seenTtlHours ?? 168;
  const seenTtlMs = seenTtlHours * 60 * 60 * 1000;
  const maxResults = Number(process.env.JOB_SEARCH_MAX_RESULTS ?? profile.search.maxResults);

  await Promise.all([
    ensureOutputDir(reportPath),
    ensureOutputDir(stateFile),
    ensureOutputDir(seenFile),
    ensureOutputDir(sentFile),
    ensureOutputDir(appliedFile),
    ensureOutputDir(dismissedFile),
  ]);

  await updateState(stateFile, (current) => ({
    ...current,
    lastRunAt: new Date().toISOString(),
    lastRunStatus: 'running',
    lastError: null,
  }), profile);

  try {
    const [seenUrls, appliedUrls, dismissedUrls, sentUrls] = await Promise.all([
      readUrlSet(seenFile, 'seen_urls', { ttlMs: seenTtlMs }),
      readUrlSet(appliedFile, 'applied_urls'),
      readUrlSet(dismissedFile, 'dismissed_urls'),
      readUrlSet(sentFile, 'sent_urls'),
    ]);

    const sources = [
      new WttjJobsSource(),
      new WellfoundJobsSource(),
      new AdzunaJobsSource(),
      new FranceTravailJobsSource(),
      new ApecJobsSource(),
      new GreenhouseJobsSource(),
      new RemotiveJobsSource(),
      new RemoteOKJobsSource(),
      new ArbeitnowJobsSource(),
      new HackerNewsJobsSource(),
    ];
    const jobLists = await Promise.all(
      sources.map((s) => s.fetch(profile.search.queries, profile.search)),
    );
    const jobMap = new Map<string, JobPosting>();
    for (const list of jobLists) {
      for (const job of list) {
        jobMap.set(job.canonicalUrl, job);
      }
    }
    const jobs = Array.from(jobMap.values());

    const baseFilter = (job: { canonicalUrl: string }) =>
      !seenUrls.has(job.canonicalUrl) &&
      !appliedUrls.has(job.canonicalUrl) &&
      !dismissedUrls.has(job.canonicalUrl);

    const freshJobs = jobs.filter(
      (job) =>
        job.publishedAtTimestamp * 1000 >=
          Date.now() - profile.search.maxAgeHours * 60 * 60 * 1000 && baseFilter(job),
    );

    const rawMatches = freshJobs
      .map((job) => scoreJob(job, profile))
      .filter((match): match is MatchResult => match !== null)
      .sort(sortMatches)
      .slice(0, maxResults);

    // AI enrichment: fraud + quality detection, cover letters, salary (fails silently)
    const enrichments = await Promise.all(rawMatches.map((m) => enrichMatch(m, profile)));
    const matches: MatchResult[] = rawMatches
      .map((match, i) => {
        const ai = enrichments[i];
        if (!ai) return match;
        return {
          ...match,
          coverLetter: ai.isSuspicious ? match.coverLetter : ai.coverLetter,
          fraudScore: ai.fraudScore,
          fraudReasons: ai.fraudReasons,
          suggestedSalary: ai.suggestedSalary ?? undefined,
          companyQualityScore: ai.companyQualityScore,
          companyRedFlags: ai.companyRedFlags,
        };
      })
      .filter((_match, i) => {
        const ai = enrichments[i];
        return !ai || !ai.isSuspicious;
      });

    const effectiveFreshJobs = freshJobs;

    const reportLocation = await writeReport(reportPath, matches, BLOCKED_SOURCES);

    // Only send jobs that have never been sent to Telegram before
    const newMatches = matches.filter((m) => !sentUrls.has(m.job.canonicalUrl));
    const liveNewMatches = await filterDeadUrls(newMatches);
    const messages = buildTelegramPayload(liveNewMatches, reportLocation, profile);

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId && messages.length > 0) {
      await sendTelegramMessages(botToken, chatId, messages);
      // Permanently record every URL that was sent so it is never sent again
      await addUrlsToStore(sentFile, 'sent_urls', liveNewMatches.map((m) => m.job.canonicalUrl));
    }

    // Check for 7-day follow-up reminders on applied jobs
    await checkFollowups().catch((err: unknown) => {
      console.error('[followup] check failed:', err instanceof Error ? err.message : String(err));
    });

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
        `Active sources: ${ACTIVE_SOURCES.join(', ')}`,
        `Blocked sources: ${BLOCKED_SOURCES.join(', ')}`,
      ].join('\n'),
    ];
  }

  const messages: string[] = [];

  // Message 1: quick overview of all matches
  const summaryLines = [
    `${matches.length} new match${matches.length > 1 ? 'es' : ''} for ${profile.candidate.name}:`,
    '',
  ];
  for (const [i, match] of matches.entries()) {
    summaryLines.push(
      `${i + 1}. ${match.job.title} — ${match.job.company}`,
      `   ${match.job.locationLabel} | ${match.job.workMode} | ${match.salaryLabel} | ${match.score}%`,
    );
  }
  messages.push(summaryLines.join('\n'));

  // One message per job with full details + cover letter
  for (const [i, match] of matches.entries()) {
    const bd = match.scoreBreakdown;
    const scoreDetail = bd
      ? ` [Tech:${bd.mandatory} | KW:${bd.keywords} | Loc:${bd.location} | Startup:${bd.startup}]`
      : '';

    const lines: string[] = [
      `[${i + 1}/${matches.length}] ${match.job.title}`,
      `Company: ${match.job.company}`,
      `Location: ${match.job.locationLabel} | ${match.job.workMode}`,
      `Score: ${match.score}%${scoreDetail}`,
      `Apply: ${match.job.applyUrl}`,
      `Why: ${match.reasons.slice(0, 2).join('; ')}`,
    ];

    if (match.fraudScore !== undefined) {
      lines.push(`Fraud risk: ${match.fraudScore}% ${match.fraudScore >= 40 ? '⚠️' : '✓'}`);
    }

    if (match.companyQualityScore !== undefined) {
      const q = match.companyQualityScore;
      const icon = q >= 75 ? '✓' : q >= 50 ? '⚠️' : '🚩';
      const flags = match.companyRedFlags?.length ? ` (${match.companyRedFlags.slice(0, 2).join(', ')})` : '';
      lines.push(`Company quality: ${q}/100 ${icon}${flags}`);
    }

    if (match.suggestedSalary) {
      lines.push(`Salary to quote: ${match.suggestedSalary}`);
    }

    lines.push('', '--- Cover letter ---', '', match.coverLetter);
    messages.push(lines.join('\n'));
  }

  return messages;
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

const DEAD_JOB_SIGNALS = [
  // English
  'job no longer available',
  'position has been filled',
  'this position has been closed',
  'job listing has expired',
  'this job is no longer',
  'vacancy has been filled',
  'posting has been removed',
  'this role has been filled',
  // French
  "offre expirée",
  "offre n'est plus disponible",
  "ce poste est pourvu",
  "annonce expirée",
  "cette offre n'est plus",
  "poste pourvu",
];

async function isUrlAlive(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-search-bot/1.0)' },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 404 || response.status === 410) return false;
    // Non-404 error codes (403, 429, 5xx) — bot-blocking or server errors, assume alive
    if (!response.ok) return true;

    const text = await response.text();
    const lower = text.toLowerCase();
    return !DEAD_JOB_SIGNALS.some((signal) => lower.includes(signal));
  } catch {
    // Network error or timeout — assume alive to avoid false negatives
    return true;
  }
}

async function filterDeadUrls(matches: MatchResult[]): Promise<MatchResult[]> {
  if (matches.length === 0) return matches;
  const alive = await Promise.all(matches.map((m) => isUrlAlive(m.job.applyUrl)));
  return matches.filter((_, i) => alive[i]);
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
