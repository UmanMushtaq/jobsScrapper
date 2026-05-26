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
import { HimalayasJobsSource } from './sources/himalayas.source';
import { JobicyJobsSource } from './sources/jobicy.source';
import { LeverJobsSource } from './sources/lever.source';
import { RemoteOKJobsSource } from './sources/remoteok.source';
import { RemotiveJobsSource } from './sources/remotive.source';
import { WeWorkRemotelyJobsSource } from './sources/weworkremotely.source';
import { WellfoundJobsSource } from './sources/wellfound.source';
import { WttjJobsSource } from './sources/wttj.source';
import {
  addUrlsToStore,
  normalizeUrl,
  readJsonFile,
  readUrlSet,
  removeUrlsFromStore,
  writeJsonFile,
} from './storage';
import { isRedisAvailable } from './redis-store';
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
  'apec.fr', 'greenhouse.io', 'jobs.lever.co', 'himalayas.app', 'jobicy.com',
  'weworkremotely.com', 'remotive.com', 'remoteok.com', 'arbeitnow.com',
  'news.ycombinator.com',
];
const BLOCKED_SOURCES = ['startup.jobs', 'indeed.com', 'linkedin.com'];

export async function runJobSearchOnce(
  overrideProfile?: SearchProfile,
): Promise<RunSummary> {
  const profile = overrideProfile ?? (await loadSearchProfile());
  if (isRedisAvailable()) {
    console.log('[storage] Redis (Upstash) — state persists across restarts');
  } else {
    console.warn('[storage] File-based — state will be lost on restart (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to fix)');
  }

  // Normalize a URL safely — never throws, falls back to raw string
  const safeNorm = (url: string): string => { try { return normalizeUrl(url); } catch { return url; } };
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
      new LeverJobsSource(),
      new HimalayasJobsSource(),
      new JobicyJobsSource(),
      new WeWorkRemotelyJobsSource(),
      new RemotiveJobsSource(),
      new RemoteOKJobsSource(),
      new ArbeitnowJobsSource(),
      new HackerNewsJobsSource(),
    ];
    const jobLists = await Promise.all(
      sources.map(async (s) => {
        try {
          return await s.fetch(profile.search.queries, profile.search);
        } catch (err) {
          console.error(`[source:${s.name}] unexpected crash — isolated, other sources unaffected: ${err instanceof Error ? err.message : String(err)}`);
          return [] as JobPosting[];
        }
      }),
    );
    const jobMap = new Map<string, JobPosting>();
    for (const [i, list] of jobLists.entries()) {
      if (list.length > 0) {
        console.log(`[source] ${sources[i].name}: ${list.length} jobs`);
      } else {
        console.log(`[source] ${sources[i].name}: 0 jobs (blocked, error, or no results)`);
      }
      for (const job of list) {
        jobMap.set(job.canonicalUrl, job);
      }
    }
    const jobs = Array.from(jobMap.values());

    // Always compare normalized URLs — sources may return raw URLs while Redis stores normalized ones.
    const baseFilter = (job: { canonicalUrl: string }) => {
      const url = safeNorm(job.canonicalUrl);
      return !seenUrls.has(url) && !appliedUrls.has(url) && !dismissedUrls.has(url);
    };

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

    console.log(`[scorer] ${jobs.length} fetched → ${freshJobs.length} fresh → ${rawMatches.length} passed scoring`);
    if (rawMatches.length === 0 && freshJobs.length > 0) {
      const EXCL_ROLES = ['frontend','front-end','front end','ui developer','ui engineer','ux developer','ux engineer','react developer','react.js','react native','vue developer','vue.js','angular developer','flutter','ios developer','android developer','mobile developer','ai engineer','ml engineer','machine learning engineer','machine learning developer','data engineer','data scientist','data analyst','nlp engineer','llm engineer','prompt engineer','computer vision engineer','devops engineer','site reliability engineer','sre engineer','infrastructure engineer','platform engineer','cloud engineer'];
      const desiredLang = (profile.search.language ?? 'en').toLowerCase();
      const expMin = profile.search.experience.min;
      const expMax = profile.search.experience.max;
      const counts = { lang: 0, title: 0, role: 0, location: 0, exp: 0, mandatory: 0, score: 0 };
      const locBreak = { usaRemote: 0, euOnsite: 0, euHybrid: 0, other: 0 };
      const mandBreak = { nodeOnly: 0, tsOnly: 0, backendOnly: 0, none: 0 };
      const nearMisses: Array<{ title: string; company: string; source: string; mandatory: number }> = [];

      for (const job of freshJobs) {
        const title = job.title.toLowerCase();
        const txt = [job.title, job.description, job.companySummary, ...job.keyMissions].join(' ').toLowerCase();
        const jobLang = (job.language ?? '').toLowerCase();
        if (jobLang && jobLang !== desiredLang) { counts.lang++; continue; }
        if (profile.search.excludedTitleKeywords.some((k) => title.includes(k))) { counts.title++; continue; }
        if (EXCL_ROLES.some((k) => title.includes(k))) { counts.role++; continue; }

        const cc = job.countryCode;
        const wm = job.workMode;
        const isUsaRemote = wm === 'remote' && cc && profile.search.usaCountryCodes?.includes(cc) && !profile.search.usaJobs;
        const isPrefCountry = profile.search.preferredCountries?.includes(cc ?? '');
        const isEU = profile.search.europeCountryCodes?.includes(cc ?? '');
        const locOk = isPrefCountry || (wm === 'remote' && !isUsaRemote) || (isEU && wm !== 'hybrid' && wm !== 'on-site') || (!cc && wm !== 'on-site');
        if (!locOk) {
          counts.location++;
          if (isUsaRemote) locBreak.usaRemote++;
          else if (isEU && wm === 'on-site') locBreak.euOnsite++;
          else if (isEU && wm === 'hybrid') locBreak.euHybrid++;
          else locBreak.other++;
          continue;
        }

        const exp = job.experienceLevelMinimum;
        if (exp !== null && exp !== undefined && (exp < expMin || exp > expMax)) { counts.exp++; continue; }

        const hasNode = ['node.js','nodejs','nestjs','nest.js','express.js'].some((t) => txt.includes(t));
        const hasTs = txt.includes('typescript') || txt.includes('javascript');
        const hasBackend = ['backend','back-end','api','rest','server-side','microservice'].some((t) => txt.includes(t));
        const mandatory = (hasNode ? 24 : 0) + (hasTs ? 18 : 0) + (hasBackend ? 18 : 0);
        if (mandatory < 36) {
          counts.mandatory++;
          if (!hasNode && !hasTs && !hasBackend) mandBreak.none++;
          else if (hasNode) mandBreak.nodeOnly++;
          else if (hasTs) mandBreak.tsOnly++;
          else mandBreak.backendOnly++;
          continue;
        }

        // Passed all pre-filters + mandatory — scored <78 or failed salary in the real scorer
        nearMisses.push({ title: job.title, company: job.company, source: job.source, mandatory });
        counts.score++;
      }

      console.log(`[scorer-diag] ${freshJobs.length} fresh jobs → 0 matched. Breakdown:`);
      console.log(`  lang=${counts.lang} | titleExcl=${counts.title} | roleExcl=${counts.role}`);
      console.log(`  location=${counts.location} (usa-remote=${locBreak.usaRemote} eu-onsite=${locBreak.euOnsite} eu-hybrid=${locBreak.euHybrid} other=${locBreak.other})`);
      console.log(`  exp=${counts.exp} | mandatory=${counts.mandatory} (node-only=${mandBreak.nodeOnly} ts-only=${mandBreak.tsOnly} backend-only=${mandBreak.backendOnly} none=${mandBreak.none})`);
      console.log(`  score<78=${counts.score}`);

      if (nearMisses.length > 0) {
        console.log(`[scorer-near-miss] ${nearMisses.length} jobs passed mandatory but scored <78 — top 5:`);
        for (const nm of nearMisses.slice(0, 5)) {
          console.log(`  "${nm.title}" @ ${nm.company} [${nm.source}] mandatory=${nm.mandatory}`);
        }
      }
    }

    // Only enrich jobs not yet sent — no point calling Gemini for jobs Telegram already received.
    // Enrichment is sequential across jobs: each job's 3 parallel calls complete before the next
    // job starts, so we never fire 60 simultaneous requests that exhaust all keys at once.
    const unseenRaw = rawMatches.filter((m) => !sentUrls.has(safeNorm(m.job.canonicalUrl)));
    const alreadySentCount = rawMatches.length - unseenRaw.length;
    console.log(`[notify] ${rawMatches.length} scored → ${unseenRaw.length} not yet sent (${alreadySentCount} already sent before)`);

    const newMatches: MatchResult[] = [];
    for (const match of unseenRaw) {
      const ai = await enrichMatch(match, profile);
      if (ai && ai.isSuspicious) {
        console.log(`[notify] SUSPICIOUS — skipped: "${match.job.title}" @ ${match.job.company} [${match.job.source}]`);
        continue;
      }
      newMatches.push(
        ai
          ? {
              ...match,
              coverLetter: ai.coverLetter,
              fraudScore: ai.fraudScore,
              fraudReasons: ai.fraudReasons,
              suggestedSalary: ai.suggestedSalary ?? undefined,
              companyQualityScore: ai.companyQualityScore,
              companyRedFlags: ai.companyRedFlags,
            }
          : match,
      );
    }
    if (unseenRaw.length > 0) {
      console.log(`[notify] AI enrichment done: ${newMatches.length}/${unseenRaw.length} passed`);
    }

    // All scored matches (new + already-sent) for the report and seenUrls tracking
    const matches: MatchResult[] = [...newMatches, ...rawMatches.filter((m) => sentUrls.has(safeNorm(m.job.canonicalUrl)))];

    const effectiveFreshJobs = freshJobs;

    const reportLocation = await writeReport(reportPath, matches, BLOCKED_SOURCES);

    const liveNewMatches = await filterDeadUrls(newMatches);
    if (newMatches.length > liveNewMatches.length) {
      const deadCount = newMatches.length - liveNewMatches.length;
      const deadJobs = newMatches.filter((m) => !liveNewMatches.includes(m));
      console.log(`[notify] URL check: ${deadCount} dead URL(s) filtered out, ${liveNewMatches.length} live`);
      for (const m of deadJobs) {
        console.log(`  DEAD URL: "${m.job.title}" @ ${m.job.company} — ${m.job.applyUrl}`);
      }
    } else if (newMatches.length > 0) {
      console.log(`[notify] URL check: all ${newMatches.length} URL(s) alive → sending to Telegram`);
    }
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
      { ttlMs: seenTtlMs },
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
        // Strip large fields (description, coverLetter) before persisting to Redis.
        // The dashboard only uses title, company, location, score, reasons and applyUrl.
        // Keeping state small prevents silent Redis write failures that would cause
        // lastSuccessAt to never be saved, resulting in a run on every service restart.
        latestMatches: slimMatchesForState(summary.matches),
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

function slimMatchesForState(matches: MatchResult[]): MatchResult[] {
  return matches.map((m) => ({
    ...m,
    // Strip large text fields — dashboard only needs title/company/location/score/reasons/applyUrl.
    // Keeping state small prevents Redis write failures that lose lastSuccessAt.
    job: { ...m.job, description: '', companySummary: '', keyMissions: [] },
    coverLetter: '',
    shortAnswers: [],
  }));
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
