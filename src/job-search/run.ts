import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AiEnrichment, enrichMatch, clearGeminiOverloadFlag, isGeminiOverloaded } from './ai-enrichment';
import { scoreLocation } from './sources/location-filter';
import { isFrontendPrimaryStack } from './stack-filter';
import { checkFollowups } from './followup';
import { salaryMeetsMinimum, scoreJob } from './matcher';
import { buildPreferenceContext, buildPreferenceModel } from './preference';
import { loadSearchProfile } from './profile';
import { writeReport } from './report';
import { AdzunaJobsSource } from './sources/adzuna.source';
import { ApecPlaywrightSource } from './sources/apec.playwright';
import { ArbeitnowJobsSource } from './sources/arbeitnow.source';
import { AshbyJobsSource } from './sources/ashby.source';
import { BerlinStartupJobsSource } from './sources/berlinstartupjobs.source';
import { BundesagenturJobsSource } from './sources/bundesagentur.source';
import { FranceTravailJobsSource } from './sources/france-travail.source';
import { GreenhouseJobsSource } from './sources/greenhouse.source';
import { HackerNewsJobsSource } from './sources/hackernews.source';
import { IndeedJobsSource } from './sources/indeed.source';
import { JobicyJobsSource } from './sources/jobicy.source';
import { JustJoinSource } from './sources/justjoin.source';
import { NoFluffJobsSource } from './sources/nofluffjobs.source';
import { LeverJobsSource } from './sources/lever.source';
import { RemoteOKJobsSource } from './sources/remoteok.source';
import { RemotiveJobsSource } from './sources/remotive.source';
import { TalentioJobsSource } from './sources/talentio.source';
import { WeWorkRemotelyJobsSource } from './sources/weworkremotely.source';
import { WttjJobsSource } from './sources/wttj.source';
import { StepstoneGermanySource } from './sources/stepstone-de.source';
import { StellenanzeigenSource } from './sources/stellenanzeigen.source';
import { JobbirdNlSource } from './sources/jobbird.source';
import { EuroBrusselsSource } from './sources/eurobrussels.source';
import { IctJobBelgiumSource } from './sources/ictjob-be.source';
import { NvbNlSource } from './sources/nvb.source';
import { PracujPlSource } from './sources/pracuj.source';
import { TheProtocolSource } from './sources/theprotocol.source';
import { JobbSafariSource } from './sources/jobbsafari.source';
import { PlatsbankenSource } from './sources/platsbanken.source';
import { CadremploiSource } from './sources/cadremploi.source';
import { HelloWorkSource } from './sources/hellowork.source';
import { JobatSource } from './sources/jobat.source';
import { VacancyNlSource } from './sources/vacancy-nl.source';
import { IntermediairSource } from './sources/intermediair.source';
import { XingJobsSource } from './sources/xing.source';
import { JobwareSource } from './sources/jobware.source';
import { InfoJobsItSource } from './sources/infojobs-it.source';
import { TalentItSource } from './sources/talent-it.source';
import { JobsLuSource } from './sources/jobslu.source';
import { MoovijobSource } from './sources/moovijob.source';
import { HimalayasSource } from './sources/himalayas.source';
import { NodeskSource } from './sources/nodesk.source';
import { GlassdoorSource } from './sources/glassdoor.source';
import {
  addUrlsToStore,
  normalizeUrl,
  readJsonFile,
  readUrlSet,
  removeUrlsFromStore,
  writeJsonFile,
} from './storage';
import { detectLanguage, hasEnglishTeamSignals } from './sources/language-detect';
import { buildRoleKey, isRedisAvailable, redisAddRoleKey, redisGet, redisGetJobHistory, redisGetRoleSet, redisLog, redisSetEx, redisStoreJobHistory, redisSaveDashboardJobBatch } from './redis-store';
import { recordPlatformHealth, SourceRunResult } from './platform-health';
import { TelegramOutgoingMessage, sendTelegramMessages, storeJobRef, hashJobUrl } from './telegram';
import { JobPosting, JobSearchState, MatchResult, RunSummary, ScorerDiagnostic, SearchProfile } from './types';
import { saveJobDecision } from '../database/database.service';

const DEFAULT_SEEN_FILE = 'job_search_seen.json';
const DEFAULT_APPLIED_FILE = 'job_search_applied.json';
const DEFAULT_DISMISSED_FILE = 'job_search_dismissed.json';
const DEFAULT_SENT_FILE = 'job_search_sent.json';
const DEFAULT_REPORT_FILE = 'job_search_latest.md';
const DEFAULT_STATE_FILE = 'job_search_state.json';
const ACTIVE_SOURCES = [
  'welcometothejungle.com', 'adzuna.com', 'francetravail.fr',
  'apec.fr', 'greenhouse.io', 'jobs.lever.co', 'jobicy.com',
  'weworkremotely.com', 'remotive.com', 'remoteok.com', 'arbeitnow.com',
  'berlinstartupjobs.com', 'bundesagentur.de',
  'stepstone.de', 'stellenanzeigen.de',
  'news.ycombinator.com',
  'jobs.ashbyhq.com', 'eu.talent.io',
  'nofluffjobs.com', 'justjoin.it',
  'eurobrussels.com', 'ictjob.be',
  'nationalevacaturebank.nl', 'jobbird.nl',
  'pracuj.pl', 'theprotocol.it',

  'cadremploi.fr', 'hellowork.com',
  'jobat.be',
  'vacancy.nl', 'intermediair.nl',
  'xing.com', 'jobware.de',
  'infojobs.it', 'talent.it',
  'jobs.lu', 'moovijob.com',
  'himalayas.app', 'nodesk.co',
  // removed (blocked/dead): europeremotely.com (502),
  // startup.jobs (403), wellfound.com (cloud IP block)
];
// linkedin.com has no public API — requires a paid partner integration
const BLOCKED_SOURCES = ['linkedin.com'];

// Sources that do NOT use ScraperAPI — safe to run on a faster 180-min schedule.
export const FAST_SOURCES = [
  'apec.fr',
  'welcometothejungle.com',
  'news.ycombinator.com',
  'arbeitsagentur.de',
  'arbetsformedlingen.se',
  'arbeitnow.com',
  'berlinstartupjobs.com',
  'greenhouse.io',
  'jobs.lever.co',
  'weworkremotely.com',
  'remotive.com',
  'remoteok.com',
  'jobbird.nl',
  'ictjob.be',
  'francetravail.fr',
  'jobicy.com',
  'jobware.de',
  'justjoin.it',
];

export async function runJobSearchOnce(
  overrideProfile?: SearchProfile,
  excludeSources?: string[],
  onlySources?: string[],
): Promise<RunSummary> {
  const profile = overrideProfile ?? (await loadSearchProfile());
  if (isRedisAvailable()) {
    console.log('[storage] Redis (Upstash) — state persists across restarts');
  } else {
    console.warn('[storage] File-based — state will be lost on restart (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to fix)');
  }

  const scraperKey = process.env.SCRAPER_API_KEY_1 ?? process.env.SCRAPERAPI_KEY;
  if (scraperKey) {
    const dual = process.env.SCRAPER_API_DUAL_KEY_ENABLED === 'true' && process.env.SCRAPER_API_KEY_2;
    console.log(`[scraperapi] active on: pracuj.pl, stellenanzeigen.de${dual ? ' (dual-key rotation)' : ''}`);
  } else {
    console.log('[scraperapi] key not set — all sources running direct');
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
  await redisLog('info', 'run', 'Run started');

  try {
    const [seenUrls, appliedUrls, dismissedUrls, sentUrls] = await Promise.all([
      readUrlSet(seenFile, 'seen_urls', { ttlMs: seenTtlMs }),
      readUrlSet(appliedFile, 'applied_urls', { ttlMs: 180 * 24 * 60 * 60 * 1000 }),
      readUrlSet(dismissedFile, 'dismissed_urls', { ttlMs: 60 * 24 * 60 * 60 * 1000 }),
      readUrlSet(sentFile, 'sent_urls', { ttlMs: 30 * 24 * 60 * 60 * 1000 }),
    ]);
    const [appliedRoles, dismissedRoles] = await Promise.all([
      redisGetRoleSet('applied', 180 * 24 * 60 * 60 * 1000),
      redisGetRoleSet('dismissed', 60 * 24 * 60 * 60 * 1000),
    ]);
    console.log(`[storage] seen=${seenUrls.size} applied=${appliedUrls.size} dismissed=${dismissedUrls.size} sent=${sentUrls.size} applied-roles=${appliedRoles.size} dismissed-roles=${dismissedRoles.size}`);
    await redisLog('info', 'storage', `seen=${seenUrls.size} applied=${appliedUrls.size} dismissed=${dismissedUrls.size} sent=${sentUrls.size}`);

    // Preference learning: derive a scoring model + an AI context block from your
    // Applied/Dismissed history. Built once per run and reused for every job.
    const decisionHistory = await redisGetJobHistory();
    const prefModel = buildPreferenceModel(decisionHistory);
    const prefContext = buildPreferenceContext(decisionHistory);
    if (prefModel.appliedCount + prefModel.dismissedCount > 0) {
      console.log(`[preference] learning from ${prefModel.appliedCount} applied + ${prefModel.dismissedCount} dismissed → ${prefModel.weights.size} weighted words`);
    }

    const allSources = [
      new WttjJobsSource(),
      new AdzunaJobsSource(),
      new FranceTravailJobsSource(),
      new GreenhouseJobsSource(),
      new AshbyJobsSource(),
      new LeverJobsSource(),
      new JobicyJobsSource(),
      new WeWorkRemotelyJobsSource(),
      new RemotiveJobsSource(),
      new RemoteOKJobsSource(),
      new ArbeitnowJobsSource(),
      new BerlinStartupJobsSource(),
      new BundesagenturJobsSource(),
      new StepstoneGermanySource(),
      new StellenanzeigenSource(),
      new TalentioJobsSource(),
      new IndeedJobsSource(),
      new HackerNewsJobsSource(),
      new EuroBrusselsSource(),
      new IctJobBelgiumSource(),
      new NvbNlSource(),
      new JobbirdNlSource(),
      new PracujPlSource(),
      new TheProtocolSource(),
      new PlatsbankenSource(),
      new CadremploiSource(),
      new HelloWorkSource(),
      new JobatSource(),
      new VacancyNlSource(),
      new IntermediairSource(),
      new XingJobsSource(),
      new JobwareSource(),
      new InfoJobsItSource(),
      new TalentItSource(),
      new JobsLuSource(),
      new MoovijobSource(),
      new HimalayasSource(),
      new NodeskSource(),
      new ApecPlaywrightSource(),
      new JustJoinSource(),
      new JobbSafariSource(),
      new NoFluffJobsSource(),
      new GlassdoorSource(),
    ];
    const sources = onlySources?.length
      ? allSources.filter((s) => onlySources.includes(s.name))
      : excludeSources?.length
        ? allSources.filter((s) => !excludeSources.includes(s.name))
        : allSources;
    // Split sources into Playwright (memory-heavy) and non-Playwright (safe to parallelize)
    const PLAYWRIGHT_SOURCES = new Set([
      'cadremploi.fr', 'hellowork.com', 'eurobrussels.com', 'apec.fr', 'nofluffjobs.com',
    ]);

    const playwrightSources = sources.filter((s) => PLAYWRIGHT_SOURCES.has(s.name));
    const fastSources = sources.filter((s) => !PLAYWRIGHT_SOURCES.has(s.name));

    // Run non-Playwright sources in parallel
    const fastResults: SourceRunResult[] = await Promise.all(
      fastSources.map(async (s): Promise<SourceRunResult> => {
        const startedAt = Date.now();
        try {
          const jobs = await s.fetch(profile.search.queries, profile.search);
          return { source: s.name, jobs, durationMs: Date.now() - startedAt, error: null };
        } catch (err) {
          console.error(`[source:${s.name}] unexpected crash — isolated, other sources unaffected: ${err instanceof Error ? err.message : String(err)}`);
          return {
            source: s.name,
            jobs: [],
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }),
    );

    // Run only ONE Playwright source per slow run to stay under 512MB RAM.
    // Rotate between cadremploi, hellowork, eurobrussels, nofluffjobs using Redis to track last run.
    const playwrightResults: SourceRunResult[] = [];
    if (playwrightSources.length > 0) {
      let s: (typeof playwrightSources)[number];
      if (playwrightSources.length === 1) {
        // Single-source run (e.g. APEC-only scheduler): run it directly,
        // do NOT touch the shared rotation index — writing it would poison
        // the slow scheduler's 3-source rotation.
        s = playwrightSources[0];
        console.log(`[run] Playwright single source: ${s.name}`);
      } else {
        const REDIS_PLAYWRIGHT_KEY = 'scheduler:playwright:last_index';
        let lastIndex = 0;
        try {
          const stored = await redisGet(REDIS_PLAYWRIGHT_KEY);
          if (stored) lastIndex = parseInt(stored, 10);
        } catch { lastIndex = 0; }
        const nextIndex = (lastIndex + 1) % playwrightSources.length;
        s = playwrightSources[nextIndex];
        await redisSetEx(REDIS_PLAYWRIGHT_KEY, String(nextIndex), 86400 * 7);
        console.log(`[run] Playwright slot ${nextIndex + 1}/${playwrightSources.length}: ${s.name}`);
      }
      try {
        const startedAt = Date.now();
        const jobs = await s.fetch(profile.search.queries, profile.search);
        playwrightResults.push({ source: s.name, jobs, durationMs: Date.now() - startedAt, error: null });
        console.log(`[run] finished Playwright source: ${s.name} — ${jobs.length} jobs`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[run] ${s.name} failed: ${msg}`);
        playwrightResults.push({ source: s.name, jobs: [], durationMs: 0, error: new Error(msg) });
      }
    }

    const sourceResults: SourceRunResult[] = [...fastResults, ...playwrightResults];
    const jobMap = new Map<string, JobPosting>();
    // Also dedup by title+company+source to catch same job posted under multiple tracking URLs
    const jobDedupeKeys = new Set<string>();
    for (const result of sourceResults) {
      if (result.jobs.length > 0) {
        console.log(`[source] ${result.source}: ${result.jobs.length} jobs`);
      } else {
        console.log(`[source] ${result.source}: 0 jobs — ${result.error ? `crash: ${result.error.message}` : 'blocked or no results'}`);
      }
      for (const job of result.jobs) {
        // Primary dedup: normalized canonical URL
        const normUrl = safeNorm(job.canonicalUrl);
        if (jobMap.has(normUrl)) continue;
        // Secondary dedup: title+company+source catches same job under different tracking URLs
        const dedupeKey = `${job.title.toLowerCase().trim()}|${job.company.toLowerCase().trim()}|${job.source}`;
        if (jobDedupeKeys.has(dedupeKey)) {
          console.log(`[dedup] skipped duplicate: "${job.title}" @ ${job.company} (${job.source})`);
          continue;
        }
        jobDedupeKeys.add(dedupeKey);
        jobMap.set(normUrl, job);
      }
    }

    // Record per-source health + proxy status so platform issues are tracked
    // and visible on /platform-status. Best-effort — never blocks the scan.
    await recordPlatformHealth(sourceResults).catch((err: unknown) =>
      console.error('[platform-health] record failed:', err instanceof Error ? err.message : String(err)),
    );

    const jobs = Array.from(jobMap.values());
    const sourceSummary = sourceResults.map((r) => `${r.source}:${r.jobs.length}${r.error ? '(ERR)' : ''}`).join(' ');
    await redisLog('info', 'sources', `${jobs.length} jobs from ${sourceResults.length} sources — ${sourceSummary}`);

    // A company dismissed repeatedly (different roles, same employer) should stop resurfacing
    // even when the exact role+title has never been seen before.
    const DISMISSED_COMPANY_THRESHOLD = 2;
    const dismissedCompanyCounts = new Map<string, number>();
    for (const roleKey of dismissedRoles) {
      const companyKey = roleKey.split('::')[0];
      dismissedCompanyCounts.set(companyKey, (dismissedCompanyCounts.get(companyKey) ?? 0) + 1);
    }

    // Always compare normalized URLs — sources may return raw URLs while Redis stores normalized ones.
    // Also check company+title role keys to catch reposts of the same role with a new URL.
    const baseFilter = (job: { canonicalUrl: string; company: string; title: string }) => {
      const url = safeNorm(job.canonicalUrl);
      if (seenUrls.has(url) || appliedUrls.has(url) || dismissedUrls.has(url)) return false;
      const roleKey = buildRoleKey(job.company, job.title);
      if (appliedRoles.has(roleKey) || dismissedRoles.has(roleKey)) return false;
      const companyKey = roleKey.split('::')[0];
      const dismissedCompanyCount = dismissedCompanyCounts.get(companyKey) ?? 0;
      if (dismissedCompanyCount >= DISMISSED_COMPANY_THRESHOLD) {
        console.log(`[dismissed-learning] SKIPPED: ${job.company} has ${dismissedCompanyCount} dismissed roles`);
        return false;
      }
      return true;
    };

    const freshJobs = jobs.filter(
      (job) =>
        job.publishedAtTimestamp * 1000 >=
          Date.now() - profile.search.maxAgeHours * 60 * 60 * 1000 && baseFilter(job),
    );

    // Per-source fresh/scored diagnostics — helps track sources that fetch many jobs but pass 0
    const apecTotal = jobs.filter((j) => j.source === 'apec.fr').length;
    const apecFresh = freshJobs.filter((j) => j.source === 'apec.fr').length;
    if (apecTotal > 0) {
      console.log(`[apec] ${apecFresh}/${apecTotal} jobs are fresh (not seen before)`);
    }

    const rawMatches = freshJobs
      .map((job) => scoreJob(job, profile, prefModel))
      .filter((match): match is MatchResult => match !== null)
      .filter((match) => checkLocationEligibility(match.job))
      .sort(sortMatches);

    if (apecTotal > 0) {
      const apecScored = rawMatches.filter((m) => m.job.source === 'apec.fr').length;
      console.log(`[apec] ${apecScored} passed scoring threshold out of ${apecFresh} fresh`);
    }

    // Deduplicate: job aggregators (Adzuna) post the same role across many cities/sources.
    // Key includes source so cross-source matches are preserved; strip "|city" suffixes from title.
    const seenCompanyRole = new Set<string>();
    const dedupedMatches: MatchResult[] = [];
    for (const match of rawMatches) {
      const baseTitle = match.job.title.split('|')[0].trim().toLowerCase().replace(/\s+/g, ' ');
      // Cross-source key: same title+company regardless of source
      const crossSourceKey = `${match.job.company.toLowerCase()}::${baseTitle}`;
      if (seenCompanyRole.has(crossSourceKey)) {
        console.log(`[dedup] skipped duplicate: "${match.job.title}" @ ${match.job.company} (${match.job.source})`);
        continue;
      }
      seenCompanyRole.add(crossSourceKey);
      dedupedMatches.push(match);
    }
    const dupCount = rawMatches.length - dedupedMatches.length;
    if (dupCount > 0) {
      console.log(`[scorer] deduplicated ${dupCount} same-company/role listings (job aggregator multi-city posts)`);
    }
    const slicedMatches = dedupedMatches.slice(0, maxResults);

    if (apecTotal > 0) {
      const apecInBatch = slicedMatches.filter((m) => m.job.source === 'apec.fr').length;
      console.log(`[apec] ${apecInBatch} in final batch after maxResults cut`);
    }

    console.log(`[scorer] ${jobs.length} fetched → ${freshJobs.length} fresh → ${slicedMatches.length} passed scoring (${dupCount} dupes removed)`);
    await redisLog('info', 'scorer', `${jobs.length} fetched → ${freshJobs.length} fresh → ${slicedMatches.length} matched (${dupCount} dupes removed)`);

    // Always compute diagnostic counters so they can be persisted to state and
    // surfaced via /health regardless of whether any matches were found.
    const EXCL_ROLES = ['frontend','front-end','front end','ui developer','ui engineer','ux developer','ux engineer','react developer','react.js','react native','vue developer','vue.js','angular developer','flutter','ios developer','android developer','mobile developer','ai engineer','ml engineer','machine learning engineer','machine learning developer','data engineer','data scientist','data analyst','nlp engineer','llm engineer','prompt engineer','computer vision engineer','devops engineer','site reliability engineer','site reliability','sre engineer','sre','infrastructure engineer','platform engineer','cloud engineer','mcp engineer','ai backend','ai infrastructure','mlops','ml ops','generative ai','genai engineer','solutions engineer','solution engineer','sales engineer','pre-sales','presales','solutions architect','solutions consultant','implementation engineer','implementation consultant','customer success','success engineer','support engineer','technical support','developer advocate','developer relations','devrel','technical account manager','technical advisor','field engineer','evangelist','sales development','account executive'];
    const desiredLang = (profile.search.language ?? 'en').toLowerCase();
    const expMin = profile.search.experience.min;
    const expMax = profile.search.experience.max;
    const diagCounts = { lang: 0, title: 0, role: 0, location: 0, exp: 0, salary: 0, mandatory: 0, score: 0, frontendPrimary: 0 };
    const diagLocBreak = { usaRemote: 0, euOnsite: 0, euHybrid: 0, other: 0 };
    const mandBreak = { nodeOnly: 0, tsOnly: 0, backendOnly: 0, none: 0 };
    const nearMisses: Array<{ title: string; company: string; source: string; mandatory: number }> = [];

    for (const job of freshJobs) {
      const title = job.title.toLowerCase();
      const txt = [job.title, job.description, job.companySummary, ...job.keyMissions].join(' ').toLowerCase();
      const jobLang = (job.language ?? '').toLowerCase();
      const isLangPrefCountry = profile.search.preferredCountries?.includes(job.countryCode ?? '');
      if (jobLang && jobLang !== desiredLang && !hasEnglishTeamSignals(txt) && !isLangPrefCountry) { diagCounts.lang++; continue; }
      // Secondary title-accent check — skip for preferred countries (DE, NL, FR, etc.)
      // because those companies commonly write titles in their local language.
      if (!isLangPrefCountry && /[àâéèêëîïôùûüçœæäöüß]/i.test(job.title) && detectLanguage(job.title) !== desiredLang) { diagCounts.lang++; continue; }
      if (profile.search.excludedTitleKeywords.some((k) => title.includes(k))) { diagCounts.title++; continue; }
      if (EXCL_ROLES.some((k) => title.includes(k))) { diagCounts.role++; continue; }

      const frontendStack = isFrontendPrimaryStack(job.title, job.description);
      if (frontendStack.reject) {
        diagCounts.frontendPrimary++;
        console.log(`[stack-filter] REJECTED frontend-primary: ${job.company} — ${frontendStack.reason}`);
        continue;
      }

      const cc = job.countryCode;
      const wm = job.workMode;
      const locResult = scoreLocation(cc, job.city, wm, job.offersRelocation, profile.search, job.locationLabel, job.description);
      if (!locResult.isAcceptable) {
        diagCounts.location++;
        const isUsaRemote = wm === 'remote' && cc && profile.search.usaCountryCodes?.includes(cc) && !profile.search.usaJobs;
        const isEU = profile.search.europeCountryCodes?.includes(cc ?? '');
        if (isUsaRemote) diagLocBreak.usaRemote++;
        else if (isEU && wm === 'on-site') diagLocBreak.euOnsite++;
        else if (isEU && wm === 'hybrid') diagLocBreak.euHybrid++;
        else diagLocBreak.other++;
        continue;
      }

      const exp = job.experienceLevelMinimum;
      if (exp !== null && exp !== undefined && (exp < expMin || exp > expMax)) { diagCounts.exp++; continue; }

      if (!salaryMeetsMinimum(job, profile)) { diagCounts.salary++; continue; }

      const hasNode = ['node.js','nodejs','nestjs','nest.js','express.js'].some((t) => txt.includes(t));
      const hasTs = txt.includes('typescript') || txt.includes('javascript');
      const hasBackend = ['backend','back-end','api','rest','server-side','microservice','server'].some((t) => txt.includes(t));
      const mandatory = (hasNode ? 24 : 0) + (hasTs ? 18 : 0) + (hasBackend ? 18 : 0);
      // Threshold 36 = ts+backend passes (18+18), node-only (24) still fails, ts-only (18) still fails
      if (mandatory < 36) {
        diagCounts.mandatory++;
        if (!hasNode && !hasTs && !hasBackend) mandBreak.none++;
        else if (hasNode) mandBreak.nodeOnly++;
        else if (hasTs) mandBreak.tsOnly++;
        else mandBreak.backendOnly++;
        continue;
      }

      nearMisses.push({ title: job.title, company: job.company, source: job.source, mandatory });
      diagCounts.score++;
    }

    if (slicedMatches.length === 0 && freshJobs.length > 0) {
      console.log(`[scorer-diag] ${freshJobs.length} fresh jobs → 0 matched. Breakdown:`);
      console.log(`  lang=${diagCounts.lang} | titleExcl=${diagCounts.title} | roleExcl=${diagCounts.role} | frontendPrimary=${diagCounts.frontendPrimary}`);
      console.log(`  location=${diagCounts.location} (usa-remote=${diagLocBreak.usaRemote} eu-onsite=${diagLocBreak.euOnsite} eu-hybrid=${diagLocBreak.euHybrid} other=${diagLocBreak.other})`);
      console.log(`  exp=${diagCounts.exp} | salary<min=${diagCounts.salary} | mandatory=${diagCounts.mandatory} (node-only=${mandBreak.nodeOnly} ts-only=${mandBreak.tsOnly} backend-only=${mandBreak.backendOnly} none=${mandBreak.none})`);
      console.log(`  score<threshold=${diagCounts.score} (adaptive: <120w→54, 120-350w→56, >350w→59)`);

      if (nearMisses.length > 0) {
        console.log(`[scorer-near-miss] ${nearMisses.length} jobs passed mandatory but scored <threshold — top 5:`);
        for (const nm of nearMisses.slice(0, 5)) {
          console.log(`  "${nm.title}" @ ${nm.company} [${nm.source}] mandatory=${nm.mandatory}`);
        }
      }
    }
    await redisLog(
      slicedMatches.length === 0 && freshJobs.length > 0 ? 'warn' : 'info',
      'scorer-diag',
      `lang=${diagCounts.lang} titleExcl=${diagCounts.title} roleExcl=${diagCounts.role} frontendPrimary=${diagCounts.frontendPrimary} loc=${diagCounts.location}(eu-onsite=${diagLocBreak.euOnsite},eu-hybrid=${diagLocBreak.euHybrid},usa=${diagLocBreak.usaRemote}) exp=${diagCounts.exp} mandatory=${diagCounts.mandatory} score=${diagCounts.score}`,
    );

    // Only enrich jobs not yet sent — no point calling Gemini for jobs Telegram already received.
    // Enrichment is sequential across jobs: each job's 3 parallel calls complete before the next
    // job starts, so we never fire 60 simultaneous requests that exhaust all keys at once.
    const unseenRaw = slicedMatches.filter((m) => !sentUrls.has(safeNorm(m.job.canonicalUrl)));
    const alreadySentCount = slicedMatches.length - unseenRaw.length;
    console.log(`[notify] ${slicedMatches.length} scored → ${unseenRaw.length} not yet sent (${alreadySentCount} already sent before)`);

    // ── AI enrichment with Gemini-overload (503) retry ───────────────────────
    // When Gemini returns 503 "high demand", we pause up to 1 hour and retry
    // every 5 minutes rather than immediately sending jobs without enrichment.
    // Other failures (quota exhausted, 404 model not found) fall through normally.
    const MAX_GEMINI_OVERLOAD_RETRIES = 12;  // 12 × 5 min = 1 hour
    const GEMINI_OVERLOAD_RETRY_MS = 5 * 60 * 1000;

    type EnrichEntry = { match: MatchResult; ai: AiEnrichment | null; overloaded: boolean };

    const runEnrichPass = async (jobs: MatchResult[]): Promise<EnrichEntry[]> => {
      clearGeminiOverloadFlag();
      const out: EnrichEntry[] = [];
      for (const match of jobs) {
        const ai = await enrichMatch(match, profile, prefContext);
        out.push({ match, ai, overloaded: ai === null && isGeminiOverloaded() });
      }
      return out;
    };

    let enrichPassResults = await runEnrichPass(unseenRaw);
    let pendingOverload = enrichPassResults.filter((r) => r.overloaded).map((r) => r.match);
    const enrichSettled: EnrichEntry[] = enrichPassResults.filter((r) => !r.overloaded);
    let geminiOverloadGaveUp = false;

    if (pendingOverload.length > 0) {
      const _tgToken = process.env.TELEGRAM_BOT_TOKEN;
      const _tgChat = process.env.TELEGRAM_CHAT_ID;
      if (_tgToken && _tgChat) {
        await sendTelegramMessages(_tgToken, _tgChat, [{
          text: `⚠️ Gemini is experiencing high demand right now.\n${pendingOverload.length} job(s) are waiting for AI enrichment.\nRetrying every 5 minutes (up to ${MAX_GEMINI_OVERLOAD_RETRIES} attempts = 1 hour).`,
        }]);
      }
      await redisLog('warn', 'gemini', `503 overloaded — ${pendingOverload.length} job(s) pending enrichment, retrying every 5 min`);

      for (let retry = 1; pendingOverload.length > 0 && retry <= MAX_GEMINI_OVERLOAD_RETRIES; retry++) {
        const nextAt = new Date(Date.now() + GEMINI_OVERLOAD_RETRY_MS).toISOString();
        await updateState(stateFile, (current) => ({
          ...current,
          lastRunStatus: 'gemini_waiting',
          geminiRetry: { count: retry, max: MAX_GEMINI_OVERLOAD_RETRIES, nextAt },
        }), profile);
        await redisLog('warn', 'gemini', `Overload retry ${retry}/${MAX_GEMINI_OVERLOAD_RETRIES} — next attempt at ${nextAt.slice(11, 16)} UTC`);
        await new Promise<void>((resolve) => setTimeout(resolve, GEMINI_OVERLOAD_RETRY_MS));

        const retryResults = await runEnrichPass(pendingOverload);
        enrichSettled.push(...retryResults.filter((r) => !r.overloaded));
        pendingOverload = retryResults.filter((r) => r.overloaded).map((r) => r.match);
      }

      if (pendingOverload.length > 0) {
        geminiOverloadGaveUp = true;
        enrichSettled.push(...pendingOverload.map((match) => ({ match, ai: null, overloaded: false })));
        await redisLog('warn', 'gemini', `Gemini still overloaded after ${MAX_GEMINI_OVERLOAD_RETRIES} retries (1 hour) — sending ${pendingOverload.length} job(s) without enrichment`);
      }
    }

    const newMatches: MatchResult[] = [];
    const rejectedByAi: MatchResult[] = [];
    for (const { match, ai } of enrichSettled) {
      if (ai && ai.relevanceScore < 55) {
        console.log(`[notify] LOW RELEVANCE (${ai.relevanceScore}/100) — skipped: "${match.job.title}" @ ${match.job.company} [${match.job.source}]${ai.relevanceIssues.length ? ` — ${ai.relevanceIssues[0]}` : ''}`);
        rejectedByAi.push(match);
        continue;
      }
      if (ai && ai.isSuspicious) {
        console.log(`[notify] SUSPICIOUS (fraud=${ai.fraudScore}) — skipped: "${match.job.title}" @ ${match.job.company} [${match.job.source}]`);
        rejectedByAi.push(match);
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
              relevanceScore: ai.relevanceScore,
              visaFriendly: ai.visaFriendly,
              visaNote: ai.visaNote,
              visaRisk: ai.visaRisk,
              atsMissingKeywords: ai.atsMissingKeywords,
              atsPlacementSuggestions: ai.atsPlacementSuggestions,
              relevanceIssues: ai.relevanceIssues,
              hiringEmail: ai.hiringEmail,
              emailSubject: ai.emailSubject,
              emailBody: ai.emailBody,
            }
          : match,
      );
    }
    if (unseenRaw.length > 0) {
      console.log(`[notify] AI enrichment done: ${newMatches.length}/${unseenRaw.length} passed (${rejectedByAi.length} rejected)`);
      await redisLog('info', 'gemini', `enrichment: ${newMatches.length}/${unseenRaw.length} passed, ${rejectedByAi.length} rejected`);
    }

    // All scored matches (new + already-sent) for the report and seenUrls tracking
    // Suspicious matches are included in seenUrls so they are not re-enriched on the next run.
    const matches: MatchResult[] = [...newMatches, ...slicedMatches.filter((m) => sentUrls.has(safeNorm(m.job.canonicalUrl)))];

    const effectiveFreshJobs = freshJobs;

    const reportLocation = await writeReport(reportPath, matches, BLOCKED_SOURCES);

    const liveNewMatches = await filterDeadUrls(newMatches);

    const runDiagnostic: ScorerDiagnostic = {
      freshJobs: freshJobs.length,
      matched: slicedMatches.length,
      filtered: {
        lang: diagCounts.lang,
        titleExcl: diagCounts.title,
        roleExcl: diagCounts.role,
        location: diagCounts.location,
        exp: diagCounts.exp,
        salary: diagCounts.salary,
        mandatory: diagCounts.mandatory,
        score: diagCounts.score,
        frontendPrimary: diagCounts.frontendPrimary,
      },
      locationBreak: diagLocBreak,
      geminiRejected: rejectedByAi.length,
      deadUrls: newMatches.length - liveNewMatches.length,
      sent: liveNewMatches.length,
    };

    if (newMatches.length > liveNewMatches.length) {
      const deadCount = newMatches.length - liveNewMatches.length;
      const deadJobs = newMatches.filter((m) => !liveNewMatches.includes(m));
      console.log(`[notify] URL check: ${deadCount} dead URL(s) filtered out, ${liveNewMatches.length} live`);
      for (const m of deadJobs) {
        console.log(`  DEAD URL: "${m.job.title}" @ ${m.job.company} — ${m.job.applyUrl}`);
      }
      await redisLog('warn', 'url-check', `${deadCount} dead URL(s) filtered, ${liveNewMatches.length} live`);
    } else if (newMatches.length > 0) {
      console.log(`[notify] URL check: all ${newMatches.length} URL(s) alive → sending to Telegram`);
      await redisLog('info', 'url-check', `all ${newMatches.length} URL(s) alive`);
    }
    const messages = await buildTelegramPayload(
      liveNewMatches,
      reportLocation,
      profile,
      geminiOverloadGaveUp
        ? `AI enrichment skipped — Gemini was overloaded for the full 1-hour retry window (${MAX_GEMINI_OVERLOAD_RETRIES} attempts). Scores and cover letters below are template-only.`
        : undefined,
    );

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId && messages.length > 0) {
      await sendTelegramMessages(botToken, chatId, messages);
      await addUrlsToStore(sentFile, 'sent_urls', liveNewMatches.map((m) => m.job.canonicalUrl));
      await redisLog('info', 'telegram', `Sent ${messages.length} message(s) — ${liveNewMatches.map((m) => `"${m.job.title}" @ ${m.job.company}`).join(', ')}`);
    }

    // Check for 7-day follow-up reminders on applied jobs
    await checkFollowups().catch((err: unknown) => {
      console.error('[followup] check failed:', err instanceof Error ? err.message : String(err));
    });

    // Mark all scored matches as seen with the configured seenTtlMs.
    // AI-rejected jobs use a longer TTL: max(seenTtlMs, maxAgeMs) so a rejected job
    // stays in seenUrls for at least the full maxAgeHours window (e.g. 72h).
    // Without this fix, a rejected job with seenTtlHours=48 expires after 48h but
    // is still "fresh" until 72h, triggering 8 extra Gemini calls per rejected job.
    const maxAgeMs = profile.search.maxAgeHours * 60 * 60 * 1000;
    const rejectedTtlMs = Math.max(seenTtlMs, maxAgeMs);
    await addUrlsToStore(seenFile, 'seen_urls', matches.map((m) => m.job.canonicalUrl), { ttlMs: seenTtlMs });
    if (rejectedByAi.length > 0) {
      await addUrlsToStore(seenFile, 'seen_urls', rejectedByAi.map((m) => m.job.canonicalUrl), { ttlMs: rejectedTtlMs });
    }

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
        geminiRetry: null,
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
        lastRunDiagnostic: runDiagnostic,
      }),
      profile,
    );

    // Persist matched jobs to dashboard store (SET NX — never overwrite existing cards).
    // Final dedup guard: title+company+source in case multiple runs surfaced same job under different URLs.
    const slimMatches = slimMatchesForState(summary.matches);
    const foundAt = Date.now();
    const dashboardDedupeKeys = new Set<string>();
    const dedupedSlim = slimMatches.filter((m) => {
      const k = `${m.job.title.toLowerCase().trim()}|${m.job.company.toLowerCase().trim()}|${m.job.source}`;
      if (dashboardDedupeKeys.has(k)) {
        console.log(`[dedup] skipped dashboard duplicate: "${m.job.title}" @ ${m.job.company} (${m.job.source})`);
        return false;
      }
      dashboardDedupeKeys.add(k);
      return true;
    });
    await redisSaveDashboardJobBatch(
      dedupedSlim.map((m) => ({ jobId: hashJobUrl(m.job.canonicalUrl), match: m, foundAt })),
    );

    await redisLog('info', 'run', `Run complete — ${liveNewMatches.length} job(s) sent, ${slicedMatches.length} matched`);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await redisLog('error', 'run', `Run failed: ${message}`);
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

export interface JobDecisionMeta {
  title?: string;
  company?: string;
  score?: number;
  source?: string;
}

export async function runSingleSource(sourceName: 'apec' | 'indeed'): Promise<void> {
  const profile = await loadSearchProfile();
  const source = sourceName === 'apec' ? new ApecPlaywrightSource() : new IndeedJobsSource();
  console.log(`[manual] running single source: ${source.name}`);
  try {
    const jobs = await source.fetch(profile.search.queries, profile.search);
    console.log(`[manual] ${source.name}: ${jobs.length} jobs fetched`);
  } catch (err) {
    console.error(`[manual] ${source.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function markJobDecision(
  decision: 'applied' | 'dismissed',
  rawUrl: string,
  fallback?: JobDecisionMeta,
): Promise<void> {
  const normalizedUrl = rawUrl.trim();
  const appliedFile = process.env.JOB_SEARCH_APPLIED_FILE ?? DEFAULT_APPLIED_FILE;
  const dismissedFile = process.env.JOB_SEARCH_DISMISSED_FILE ?? DEFAULT_DISMISSED_FILE;
  const seenFile = process.env.JOB_SEARCH_SEEN_FILE ?? DEFAULT_SEEN_FILE;
  const stateFile = process.env.JOB_SEARCH_STATE_FILE ?? DEFAULT_STATE_FILE;

  const normDecision = (url: string) => { try { return normalizeUrl(url); } catch { return url; } };

  const state = await readJobSearchState();
  const match = state.latestMatches.find((m) => normDecision(m.job.canonicalUrl) === normDecision(normalizedUrl));

  const historyTitle   = match?.job.title   ?? fallback?.title   ?? '';
  const historyCompany = match?.job.company  ?? fallback?.company ?? '';
  const historyScore   = match?.score        ?? fallback?.score   ?? 0;
  const historySource  = match?.job.source   ?? fallback?.source  ?? '';

  if (decision === 'applied') {
    await addUrlsToStore(appliedFile, 'applied_urls', [normalizedUrl], { ttlMs: 180 * 24 * 60 * 60 * 1000 });
    if (historyCompany && historyTitle) {
      await redisAddRoleKey('applied', buildRoleKey(historyCompany, historyTitle), 180 * 24 * 60 * 60 * 1000);
    }
  } else {
    await addUrlsToStore(dismissedFile, 'dismissed_urls', [normalizedUrl], { ttlMs: 60 * 24 * 60 * 60 * 1000 });
    if (historyCompany && historyTitle) {
      await redisAddRoleKey('dismissed', buildRoleKey(historyCompany, historyTitle), 60 * 24 * 60 * 60 * 1000);
    }
  }

  if (historyTitle && historyCompany) {
    await redisStoreJobHistory({
      type: decision,
      title: historyTitle,
      company: historyCompany,
      url: match?.job.canonicalUrl ?? normalizedUrl,
      score: historyScore,
      source: historySource,
      date: new Date().toISOString(),
    });
  }

  // Detect primary stack and role type from job description for richer Gemini calibration
  const jobDesc = match?.job.description ?? '';
  const primaryStack = /(nestjs|nest\.js)/i.test(jobDesc) ? 'NestJS'
    : /node\.?js/i.test(jobDesc) ? 'Node.js'
    : /angular/i.test(jobDesc) ? 'Angular'
    : /vue/i.test(jobDesc) ? 'Vue'
    : /react/i.test(jobDesc) ? 'React'
    : /python/i.test(jobDesc) ? 'Python'
    : /java[^s]/i.test(jobDesc) ? 'Java'
    : /\.net|c#/i.test(jobDesc) ? '.NET'
    : null;
  const roleType = /fullstack|full.stack|full stack/i.test(historyTitle + jobDesc) ? 'fullstack'
    : /frontend|front.end|front end/i.test(historyTitle + jobDesc) ? 'frontend'
    : 'backend';

  await saveJobDecision({
    jobUrl: match?.job.canonicalUrl ?? normalizedUrl,
    jobTitle: historyTitle,
    company: historyCompany,
    source: historySource,
    matcherScore: historyScore,
    aiScore: match?.relevanceScore ?? 0,
    decision,
    country: match?.job.countryCode ?? undefined,
    salaryMin: match?.job.salaryMinimum ?? undefined,
    salaryMax: match?.job.salaryMaximum ?? undefined,
    primaryStack: primaryStack ?? undefined,
    roleType,
    jobDescription: jobDesc.slice(0, 2000) || undefined,
    coverLetter: match?.coverLetter?.slice(0, 2000) || undefined,
  });

  await removeUrlsFromStore(seenFile, 'seen_urls', [normalizedUrl]);

  await updateState(stateFile, (current) => ({
    ...current,
    latestMatches: current.latestMatches.filter((m) => normDecision(m.job.canonicalUrl) !== normDecision(normalizedUrl)),
  }));
}

export async function readJobSearchState(): Promise<JobSearchState> {
  const stateFile = process.env.JOB_SEARCH_STATE_FILE ?? DEFAULT_STATE_FILE;
  return readJsonFile<JobSearchState>(stateFile, buildEmptyState());
}

async function buildTelegramPayload(
  matches: MatchResult[],
  reportPath: string,
  profile: SearchProfile,
  overloadNote?: string,
): Promise<TelegramOutgoingMessage[]> {
  if (matches.length === 0) {
    return [
      {
        text: [
          ...(overloadNote ? [`⚠️ ${overloadNote}`, ''] : []),
          `No new strong matches for ${profile.candidate.name} in this run.`,
          `Active sources: ${ACTIVE_SOURCES.join(', ')}`,
          `Blocked sources: ${BLOCKED_SOURCES.join(', ')}`,
        ].join('\n'),
      },
    ];
  }

  const messages: TelegramOutgoingMessage[] = [];

  // Message 1: quick overview of all matches
  const summaryLines = [
    ...(overloadNote ? [`⚠️ ${overloadNote}`, ''] : []),
    `${matches.length} new match${matches.length > 1 ? 'es' : ''} for ${profile.candidate.name}:`,
    '',
  ];
  for (const [i, match] of matches.entries()) {
    summaryLines.push(
      `${i + 1}. ${match.job.title} — ${match.job.company}`,
      `   ${match.job.locationLabel} | ${match.job.workMode} | ${match.salaryLabel} | ${match.score}%`,
    );
  }
  messages.push({ text: summaryLines.join('\n') });

  // One message per job with full details + cover letter + action buttons
  for (const [i, match] of matches.entries()) {
    const bd = match.scoreBreakdown;
    const scoreDetail = bd
      ? ` [Tech:${bd.mandatory} | KW:${bd.keywords} | Loc:${bd.location} | Startup:${bd.startup}${bd.sponsor ? ` | Sponsor:${bd.sponsor}` : ''}${bd.preference ? ` | Pref:${bd.preference > 0 ? '+' : ''}${bd.preference}` : ''}]`
      : '';

    const lines: string[] = [
      `[${i + 1}/${matches.length}] ${match.job.title}`,
      `Company: ${match.job.company}`,
      `Location: ${match.job.locationLabel} | ${match.job.workMode}`,
      `Score: ${match.score}%${scoreDetail}`,
      `Apply: ${match.job.applyUrl}`,
      `Why: ${match.reasons.slice(0, 2).join('; ')}`,
    ];

    if (match.relevanceScore !== undefined) {
      const r = match.relevanceScore;
      const rIcon = r >= 80 ? '✓' : r >= 60 ? '~' : '⚠️';
      lines.push(`AI relevance: ${r}/100 ${rIcon}`);
    }

    if (match.job.offersRelocation) {
      lines.push('Sponsor/relocation: mentioned in posting ✓');
    }

    if (match.visaFriendly !== undefined && match.visaFriendly !== null) {
      const visaIcon = match.visaFriendly ? '✓' : '⚠️';
      const note = match.visaNote ? ` (${match.visaNote})` : '';
      lines.push(`APS visa: ${match.visaFriendly ? 'compatible' : 'sponsorship needed'}${note} ${visaIcon}`);
    }

    if (match.visaRisk) {
      lines.push(`Permit risk: ${match.visaRisk}`);
    }

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

    if (match.atsMissingKeywords?.length) {
      lines.push(`ATS gaps: ${match.atsMissingKeywords.join(', ')}`);
      if (match.atsPlacementSuggestions?.length) {
        lines.push(`Tip: ${match.atsPlacementSuggestions[0]}`);
      }
    }

    if (match.coverLetter) {
      lines.push('', '--- Cover letter ---', '', match.coverLetter);
    }

    if (match.hiringEmail) {
      lines.push(
        '',
        '--- Direct email to hiring manager ---',
        `To: ${match.hiringEmail}`,
        `Subject: ${match.emailSubject ?? `Application: ${match.job.title} — ${match.job.company}`}`,
        '',
        match.emailBody ?? '',
      );
    }

    // Store hash → URL + metadata for button callbacks so history saves even after redeploy
    const hash = await storeJobRef(match.job.canonicalUrl, {
      title: match.job.title,
      company: match.job.company,
      score: match.score,
      source: match.job.source ?? '',
    });

    messages.push({
      text: lines.join('\n'),
      inlineKeyboard: [[
        { text: '✅ Applied', callback_data: `a:${hash}` },
        { text: '❌ Reject', callback_data: `d:${hash}` },
      ]],
    });
  }

  return messages;
}


const FR_CITIES = [
  'paris','lyon','marseille','bordeaux','toulouse','nantes','nice','strasbourg',
  'lille','rennes','montpellier','grenoble','reims','le havre','saint-étienne',
  'toulon','dijon','angers','brest','le mans','aix-en-provence','clermont-ferrand',
  'amiens','tours','limoges','metz','besançon','perpignan','orléans','mulhouse','rouen',
  // broader France signals
  'ile-de-france','île-de-france','idf','france',
];

const TIER2_SIGNALS = ['relocation','visa sponsorship','blue card','remote','hybrid','relocation support','relocation package','we sponsor','work from anywhere','fully remote','open to relocation'];

const TIER3_SIGNALS = ['remote','relocation','visa sponsorship','relocation support','relocation package','we sponsor'];

const UK_VISA_SIGNALS = ['visa sponsorship','we sponsor','right to work','skilled worker visa'];

const EU_WORLDWIDE_SIGNALS = ['eu candidates welcome','eu applicants','open to eu','european candidates','worldwide'];

function checkLocationEligibility(job: JobPosting): boolean {
  const cc = (job.countryCode ?? '').toUpperCase();
  const locLabel = (job.locationLabel ?? '').toLowerCase();
  const combined = `${job.title} ${job.description}`.toLowerCase();

  // Rule 1: France — always accept.
  // Check cc, locLabel, and the full combined text for any France signal.
  const isFranceSignal = cc === 'FR'
    || FR_CITIES.some((city) => locLabel.includes(city))
    || FR_CITIES.some((city) => combined.includes(city));
  if (isFranceSignal) return true;

  // Fix 2: Hybrid job in a Paris/France location — always pass even without relocation signal.
  // A hybrid role that explicitly mentions France/Paris is by definition accessible from Paris.
  if (job.workMode === 'hybrid' && (
    locLabel.includes('paris') || locLabel.includes('france') || locLabel.includes('idf') ||
    locLabel.includes('ile-de-france') || locLabel.includes('île-de-france')
  )) {
    return true;
  }

  // Rule 2: BE, DE, LU, NL, IE — need remote/relocation/visa/hybrid signal
  if (['BE','DE','LU','NL','IE'].includes(cc)) {
    const pass = TIER2_SIGNALS.some((s) => combined.includes(s));
    if (!pass) console.log(`[loc-filter] FILTERED: ${job.company} (${cc}), no remote/relocation/visa signal`);
    return pass;
  }

  // Rule 3: Other EU
  const OTHER_EU = ['ES','IT','PT','PL','SE','DK','NO','AT','CZ','RO','FI','HR','SK','HU','BG','EE','LV','LT','SI','CY','MT'];
  if (OTHER_EU.includes(cc)) {
    const pass = TIER3_SIGNALS.some((s) => combined.includes(s));
    if (!pass) console.log(`[loc-filter] FILTERED: ${job.company} (${cc}), no remote or relocation signal`);
    return pass;
  }

  // Rule 4: UK
  if (cc === 'GB' || cc === 'UK') {
    const hasRemote = combined.includes('remote');
    const hasVisa = UK_VISA_SIGNALS.some((s) => combined.includes(s));
    const pass = hasRemote && hasVisa;
    if (!pass) console.log(`[loc-filter] FILTERED: ${job.company} (GB), needs remote + visa sponsorship signal`);
    return pass;
  }

  // Rule 5: US / Canada — remote + explicit EU-welcome required
  const isCanadaText = locLabel.includes('canada') || combined.includes('canada') || combined.includes('canadian');
  if (cc === 'US' || cc === 'CA' || isCanadaText) {
    const hasRemote = combined.includes('remote');
    const hasEuWelcome = EU_WORLDWIDE_SIGNALS.some((s) => combined.includes(s));
    const pass = hasRemote && hasEuWelcome;
    const label = cc || (isCanadaText ? 'CA-text' : 'US');
    if (!pass) console.log(`[loc-filter] FILTERED: ${job.company} (${label}), US/CA requires remote + EU-welcome signal`);
    return pass;
  }

  // Rule 6: Any other country or unknown country code.
  // Fix 1: remote job with no detected country defaults to PASS — more likely worldwide than restricted.
  // Only reject if explicitly on-site with an unknown/unlisted country.
  if (!cc && job.workMode === 'remote') {
    console.log(`[loc-filter] PASSED: ${job.company}, remote job with undetected country, defaulting to pass`);
    return true;
  }
  const pass = combined.includes('remote');
  if (!pass) console.log(`[loc-filter] FILTERED: ${job.company} (${cc || 'unknown'}), non-listed country requires remote`);
  return pass;
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

  const profileMinutes = Math.round(profile.search.checkIntervalHours * 60);
  return Math.max(480, profileMinutes);
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
    // Strip the largest fields (job description body) to keep Redis state under 256 KB.
    // Keep all AI-generated fields (coverLetter, emailBody, atsPlacementSuggestions)
    // because the dashboard displays them — trimmed to reasonable lengths.
    job: { ...m.job, description: '', companySummary: '', keyMissions: [] },
    shortAnswers: [],
    coverLetter: m.coverLetter ? m.coverLetter.slice(0, 2000) : '',
    emailBody: m.emailBody ? m.emailBody.slice(0, 1500) : undefined,
    atsPlacementSuggestions: m.atsPlacementSuggestions?.slice(0, 3),
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
