import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Response } from 'express';
import { enrichMatch, generateShortAnswers, getGeminiModuleState, lastGeminiError } from './job-search/ai-enrichment';
import { loadSearchProfile } from './job-search/profile';
import {
  JobDecisionMeta,
  markJobDecision,
  readJobSearchState,
  runJobSearchOnce,
  runSingleSource,
} from './job-search/run';
import {
  answerCallbackQuery,
  editTelegramMessage,
  hashJobUrl,
  registerWebhook,
  resolveJobMeta,
  resolveJobRef,
  sendTelegramMessages,
} from './job-search/telegram';
import { ApecRunStatus, AppliedJobEntry, BotLogEntry, DashboardJobEntry, IndeedRunData, JobHistoryEntry, isRedisAvailable, redisCountUrlSets, redisDeleteDashboardJob, redisGetApecStatus, redisGetAppliedJobs, redisGetDashboardJobs, redisGetGeminiDailyCalls, redisGetIndeedLastRun, redisGetJobHistory, redisGetLogs, redisRecordJobDecisionHistory, redisSaveAppliedJob } from './job-search/redis-store';
import { getPlatformHealth } from './job-search/platform-health';
import { ApecPlaywrightStatus, getApecPlaywrightStatus } from './job-search/sources/apec.playwright';
import { JobSearchState, MatchResult, PlatformHealth, ScorerDiagnostic } from './job-search/types';

// Hardcoded recovery contact. Password recovery delivers to Telegram (already
// configured); this address is shown on the login page so you always know where
// the recovery message goes.
const RECOVERY_EMAIL = 'umanmushtaq72@gmail.com';

// Module-level in-memory caches — survive within a single process lifetime.
// Invalidated on Apply/Dismiss so the user always sees up-to-date state after an action.
let _dashboardCache: { html: string; ts: number } | null = null;
let _healthCache: { data: Record<string, unknown>; ts: number } | null = null;
let _platformStatusCache: { html: string; ts: number } | null = null;
const DASHBOARD_CACHE_TTL_MS = 60_000;   // 60 s
const HEALTH_CACHE_TTL_MS    = 60_000;   // 60 s
const PLATFORM_CACHE_TTL_MS  = 60_000;   // 60 s

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private pingHandle: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private intervalMinutes = 0;
  private _keyStatusCache: { result: Record<string, unknown>; at: number } | null = null;
  private readonly KEY_STATUS_CACHE_TTL_MS = 20 * 60 * 1000;

  async onModuleInit(): Promise<void> {
    const profile = await loadSearchProfile();
    const envMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? 0);
    const profileMinutes = Math.round(profile.search.checkIntervalHours * 60);
    this.intervalMinutes = envMinutes > 0 ? envMinutes : profileMinutes;

    this.startSelfPing();
    void this.registerTelegramWebhook();

    if (!shouldEnableScheduler()) {
      this.logger.log('Scheduler disabled; web app is running in health/dashboard mode only.');
      return;
    }

    const intervalMs = this.intervalMinutes * 60 * 1000;
    const state = await readJobSearchState();
    const msSinceLastSuccess = state.lastSuccessAt
      ? Date.now() - new Date(state.lastSuccessAt).getTime()
      : Infinity;

    if (msSinceLastSuccess < intervalMs - 60_000) {
      // A scan completed recently — skip startup scan to avoid re-sending same jobs on every deploy.
      // Schedule the next run at the correct offset from the last scan.
      const nextRunMs = intervalMs - msSinceLastSuccess;
      this.logger.log(
        `Skipping startup scan (last success ${Math.round(msSinceLastSuccess / 60_000)}min ago). ` +
          `Next scan in ${Math.round(nextRunMs / 60_000)}min.`,
      );
      const handle = setTimeout(() => {
        void this.safeRun('interval');
        this.intervalHandle = setInterval(() => void this.safeRun('interval'), intervalMs);
      }, nextRunMs);
      this.intervalHandle = handle as unknown as NodeJS.Timeout;
    } else {
      await this.safeRun('startup');
      this.intervalHandle = setInterval(() => void this.safeRun('interval'), intervalMs);
    }

    this.logger.log(`Scheduler running with ${this.intervalMinutes}min interval.`);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.pingHandle) {
      clearInterval(this.pingHandle);
      this.pingHandle = null;
    }
  }

  // Ping own /health endpoint every 4 minutes so Render free tier never spins down.
  // RENDER_EXTERNAL_URL is set automatically by Render — no config needed.
  private startSelfPing(): void {
    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    if (!externalUrl) return;

    const ping = (): void => {
      fetch(`${externalUrl}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    };

    this.pingHandle = setInterval(ping, 4 * 60 * 1000);
    this.logger.log(`Self-ping active — keeping Render instance awake (${externalUrl}/health every 4 min).`);
  }

  async runNow(): Promise<void> {
    await this.safeRun('manual');
  }

  async runSource(sourceName: 'apec' | 'indeed'): Promise<void> {
    await this.safeRunSource(sourceName);
  }

  private async safeRunSource(sourceName: 'apec' | 'indeed'): Promise<void> {
    const key = `source:${sourceName}`;
    if (this.activeRun) {
      this.logger.warn(`Skipping ${key} run because a full scan is already active.`);
      return;
    }
    this.activeRun = (async () => {
      try {
        await runSingleSource(sourceName);
        _dashboardCache = null;
        _healthCache = null;
        this.logger.log(`[manual] ${sourceName} source run complete.`);
      } catch (error) {
        this.logger.error(`[manual] ${sourceName} source run failed`, error instanceof Error ? error.stack : String(error));
      } finally {
        this.activeRun = null;
      }
    })();
    return this.activeRun;
  }

  private async registerTelegramWebhook(): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    if (!botToken || !externalUrl) return;
    try {
      await registerWebhook(botToken, `${externalUrl}/telegram/webhook`);
    } catch (err) {
      this.logger.warn(`[telegram] webhook registration failed: ${(err as Error).message}`);
    }
  }

  async handleTelegramWebhook(update: Record<string, unknown>, secret: string): Promise<void> {
    // Verify secret token if configured
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret && secret !== expectedSecret) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return;

    const cbq = update.callback_query as {
      id: string;
      data?: string;
      message?: { message_id: number; chat: { id: number }; text?: string };
    } | undefined;

    if (!cbq?.data || !cbq.message) return;

    const [action, hash] = cbq.data.split(':');
    if (!hash || (action !== 'a' && action !== 'd')) return;

    const url = await resolveJobRef(hash);
    if (!url) {
      await answerCallbackQuery(botToken, cbq.id, 'Job not found (may have expired)');
      return;
    }

    const meta = await resolveJobMeta(hash);
    const decision = action === 'a' ? 'applied' : 'dismissed';
    await markJobDecision(decision, url, meta ?? undefined);

    const label = action === 'a' ? '✅ Applied' : '❌ Rejected';
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const currentText = cbq.message.text ?? '';
    const newText = currentText.endsWith(`\n${label} on ${date}`)
      ? currentText
      : `${currentText}\n\n${label} on ${date}`;

    await editTelegramMessage(botToken, cbq.message.chat.id, cbq.message.message_id, newText);
    await answerCallbackQuery(botToken, cbq.id, `${label} saved!`);
  }

  async markApplied(url: string, meta?: JobDecisionMeta): Promise<void> {
    if (!url) return;
    await markJobDecision('applied', url, meta);
  }

  async markDismissed(url: string, meta?: JobDecisionMeta): Promise<void> {
    if (!url) return;
    await markJobDecision('dismissed', url, meta);
  }

  async dashboardJobApplied(jobId: string, meta?: JobDecisionMeta): Promise<void> {
    if (!jobId) return;
    const jobs = await redisGetDashboardJobs();
    const entry = jobs.find((j) => j.jobId === jobId);
    if (entry) {
      const m = entry.match as {
        job?: { canonicalUrl?: string; title?: string; company?: string; countryCode?: string | null; locationLabel?: string; workMode?: string };
        score?: number;
      };
      const url = m?.job?.canonicalUrl;
      if (url) await markJobDecision('applied', url, meta);
      const appliedAt = Date.now();
      // Record for Gemini calibration
      await redisRecordJobDecisionHistory('applied', {
        title: m?.job?.title ?? meta?.title ?? '',
        company: m?.job?.company ?? meta?.company ?? '',
        countryCode: m?.job?.countryCode ?? null,
        score: m?.score ?? meta?.score ?? 0,
        foundAt: entry.foundAt,
      });
      // Save full entry for Applied tab (10-day TTL)
      await redisSaveAppliedJob({
        jobId,
        title: m?.job?.title ?? meta?.title ?? '',
        company: m?.job?.company ?? meta?.company ?? '',
        locationLabel: m?.job?.locationLabel ?? '',
        countryCode: m?.job?.countryCode ?? null,
        workMode: m?.job?.workMode ?? '',
        score: m?.score ?? meta?.score ?? 0,
        appliedAt,
      });
    }
    if (entry) {
      const m = entry.match as { job?: { title?: string; company?: string } } | null;
      console.log(`[dashboard] removed job: ${m?.job?.company ?? '?'}, ${m?.job?.title ?? '?'}, reason: applied`);
    }
    await redisDeleteDashboardJob(jobId);
    _dashboardCache = null; // invalidate so next load reflects the removal
  }

  async dashboardJobDismiss(jobId: string): Promise<void> {
    if (!jobId) return;
    const jobs = await redisGetDashboardJobs();
    const entry = jobs.find((j) => j.jobId === jobId);
    if (entry) {
      const m = entry.match as { job?: { canonicalUrl?: string; title?: string; company?: string; countryCode?: string | null }; score?: number };
      // Record for Gemini calibration
      await redisRecordJobDecisionHistory('dismissed', {
        title: m?.job?.title ?? '',
        company: m?.job?.company ?? '',
        countryCode: m?.job?.countryCode ?? null,
        score: m?.score ?? 0,
        foundAt: entry.foundAt,
      });
      // Add to dismissed_urls + remove from seen_urls so bot never re-surfaces this job
      const url = m?.job?.canonicalUrl;
      if (url) {
        await markJobDecision('dismissed', url, {
          title: m?.job?.title,
          company: m?.job?.company,
          score: m?.score,
        });
      }
      console.log(`[dashboard] removed job: ${m?.job?.company ?? '?'}, ${m?.job?.title ?? '?'}, reason: dismissed`);
    }
    await redisDeleteDashboardJob(jobId);
    _dashboardCache = null; // invalidate so next load reflects the removal
  }

  async getAppliedJobs(): Promise<AppliedJobEntry[]> {
    return redisGetAppliedJobs();
  }

  async getHealth(): Promise<Record<string, unknown>> {
    if (_healthCache && Date.now() - _healthCache.ts < HEALTH_CACHE_TTL_MS) {
      return _healthCache.data;
    }
    const [state, urlCounts] = await Promise.all([readJobSearchState(), redisCountUrlSets()]);
    const data = {
      ok: true,
      status: state.lastRunStatus,
      lastRunAt: state.lastRunAt,
      lastSuccessAt: state.lastSuccessAt,
      nextRunAt: state.nextRunAt,
      intervalMinutes: state.intervalMinutes,
      matches: state.stats.matchCount,
      freshScanned: state.stats.freshJobsCount,
      error: state.lastError,
      redis: isRedisAvailable() ? 'connected' : 'not configured',
      telegram: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured',
      scheduler: shouldEnableScheduler() ? 'enabled' : 'disabled',
      urlCounts,
      lastRunDiagnostic: state.lastRunDiagnostic ?? null,
    };
    _healthCache = { data, ts: Date.now() };
    return data;
  }

  async testGemini(): Promise<Record<string, unknown>> {
    const keys = (process.env.GEMINI_API_KEY ?? '').split(',').filter(Boolean);
    for (let i = 1; i <= 10; i++) {
      const k = process.env[`GEMINI_API_KEY_${i}`];
      if (k?.trim()) keys.push(k.trim());
    }
    if (!keys.length) {
      return { ok: false, error: 'No GEMINI_API_KEY set in environment variables' };
    }
    const profile = await loadSearchProfile();
    const fakeMatch = {
      job: {
        source: 'test', sourcePriority: 1, canonicalUrl: 'https://test.com/job/1',
        title: 'Backend Engineer', company: 'Test Company',
        companySummary: 'A product company building SaaS tools.',
        companySlug: 'test-company', locationLabel: 'Remote', countryCode: null,
        city: null, workMode: 'remote' as const,
        language: 'en',
        description: 'We are looking for a Backend Engineer with Node.js, TypeScript, PostgreSQL and REST API experience. You will build microservices and work with Docker in a remote team.',
        keyMissions: [], experienceLevelMinimum: 3,
        salaryCurrency: null, salaryPeriod: null, salaryMinimum: null, salaryMaximum: null, salaryYearlyMinimum: null,
        publishedAt: new Date().toISOString(), publishedAtTimestamp: Math.floor(Date.now() / 1000),
        startupSignals: [], applyUrl: 'https://test.com/apply',
        offersRelocation: false, isStartup: false, employeeCount: null, companyCreationYear: null,
      },
      score: 85, scoreBreakdown: { mandatory: 60, keywords: 12, location: 9, startup: 0 },
      reasons: ['Node.js is explicitly required', 'TypeScript/JavaScript matches your backend stack'],
      startupScore: 0, salaryLabel: 'salary not listed', coverLetter: '', shortAnswers: [],
    };
    try {
      const start = Date.now();
      const result = await enrichMatch(fakeMatch, profile);
      const elapsed = Date.now() - start;
      if (!result) {
        return { ok: false, error: lastGeminiError || 'enrichMatch returned null (all keys/models failed)', keysConfigured: keys.length };
      }
      return {
        ok: true,
        keysConfigured: keys.length,
        elapsedMs: elapsed,
        fraudScore: result.fraudScore,
        isSuspicious: result.isSuspicious,
        companyQualityScore: result.companyQualityScore,
        coverLetterPreview: result.coverLetter.slice(0, 120) + '…',
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), keysConfigured: keys.length };
    }
  }

  async validateGeminiKeys(force = false): Promise<Record<string, unknown>> {
    if (!force && this._keyStatusCache && Date.now() - this._keyStatusCache.at < this.KEY_STATUS_CACHE_TTL_MS) {
      return this._keyStatusCache.result;
    }

    const { GoogleGenAI } = await import('@google/genai');
    const rawKeys: Array<{ key: string; source: string }> = [];
    const main = process.env.GEMINI_API_KEY ?? '';
    main.split(',').filter(Boolean).forEach((k, i) =>
      rawKeys.push({ key: k.trim(), source: i === 0 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY (slot ${i + 1})` }),
    );
    for (let i = 1; i <= 10; i++) {
      const k = process.env[`GEMINI_API_KEY_${i}`];
      if (k?.trim()) rawKeys.push({ key: k.trim(), source: `GEMINI_API_KEY_${i}` });
    }

    if (!rawKeys.length) {
      return { ok: false, error: 'No keys configured', advice: ['Add GEMINI_API_KEY or GEMINI_API_KEY_1..10 in Render env vars'] };
    }

    const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-8b', 'gemini-2.0-flash-exp'];
    const MINI_PROMPT = 'Reply with the single word: OK';
    const results: Array<Record<string, unknown>> = [];

    for (const { key, source } of rawKeys) {
      const keyPreview = `${key.slice(0, 8)}...${key.slice(-4)}`;

      let status = 'unknown';
      let model = '';
      let error = '';
      let rawError = '';

      for (const m of MODELS) {
        try {
          const ai = new GoogleGenAI({ apiKey: key });
          await ai.models.generateContent({ model: m, contents: MINI_PROMPT });
          status = 'ok';
          model = m;
          rawError = '';
          break;
        } catch (err) {
          const fullMsg = String(err instanceof Error ? err.message : err);
          rawError = fullMsg.slice(0, 400);
          const msg = fullMsg.toLowerCase();
          if (msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('429')) {
            status = 'quota_exhausted';
            error = 'Daily quota used up';
            break;
          } else if (
            msg.includes('api_key_invalid') || msg.includes('invalid api key') ||
            msg.includes('unauthenticated') || msg.includes('invalid credential') ||
            msg.includes('invalid_api_key') || msg.includes('401')
          ) {
            status = 'invalid_key';
            error = 'Key is invalid or revoked. Delete it from env vars.';
            break;
          } else if (msg.includes('403') || msg.includes('permission_denied')) {
            status = 'permission_denied';
            error = 'Gemini API not enabled for this project. Enable it at console.cloud.google.com.';
            break;
          } else {
            error = fullMsg.slice(0, 200);
          }
        }
      }

      results.push({ source, key: keyPreview, status, model: model || null, error: error || null, rawError: rawError || null });
    }

    const okCount = results.filter((r) => r.status === 'ok').length;
    const exhaustedCount = results.filter((r) => r.status === 'quota_exhausted').length;
    const invalidCount = results.filter((r) => r.status === 'invalid_key' || r.status === 'invalid_format').length;
    const permCount = results.filter((r) => r.status === 'permission_denied').length;
    const validKeyCount = results.filter((r) => r.status !== 'invalid_key').length;
    const dailyCapacity = okCount * 1500;

    const advice: string[] = [];

    if (invalidCount > 0) {
      advice.push(`${invalidCount} key(s) have wrong format or are revoked. Remove them from Render env vars.`);
    }
    if (permCount > 0) {
      advice.push(`${permCount} key(s) have Gemini API not enabled. Go to console.cloud.google.com, select the project, and enable the Gemini API.`);
    }

    if (exhaustedCount > 0 && okCount === 0) {
      const likelySameAccount = exhaustedCount === validKeyCount && validKeyCount > 1;
      advice.push(
        `All ${exhaustedCount} valid key(s) are quota-exhausted.` +
        (likelySameAccount
          ? ' If they all appeared on the same aistudio.google.com/apikey page, they share one quota pool. Add a key from a different Google account.'
          : ' Quota resets at midnight Pacific time. No action needed if keys are from different accounts.'),
      );
      advice.push(
        'Each Google account gives 1,500 free requests/day. ' +
        'To check which account a key belongs to: open aistudio.google.com/apikey in a browser and log in with each Gmail one at a time. The keys shown belong to that account.',
      );
    } else if (exhaustedCount > 0) {
      advice.push(`${exhaustedCount} key(s) exhausted, ${okCount} still working. Bot is using the working ones.`);
    }

    if (okCount > 0 && exhaustedCount === 0 && invalidCount === 0 && permCount === 0) {
      advice.push(
        `All ${okCount} key(s) working. ` +
        (okCount > 1
          ? `Estimated capacity: ${okCount.toLocaleString()} × 1,500 = ${dailyCapacity.toLocaleString()} req/day if each key is from a different Google account; 1,500 req/day total if they all share one account.`
          : 'Capacity: 1,500 req/day on the free tier.'),
      );
    }

    if (advice.length === 0) {
      advice.push('To verify accounts: open aistudio.google.com/apikey in a browser and log in with each Gmail. The keys listed belong to that account.');
    }

    const response = {
      testedAt: new Date().toISOString(),
      totalKeys: rawKeys.length,
      working: okCount,
      quotaExhausted: exhaustedCount,
      invalid: invalidCount,
      advice,
      keys: results,
    };
    this._keyStatusCache = { result: response, at: Date.now() };
    return response;
  }

  async renderDashboard(): Promise<string> {
    if (_dashboardCache && Date.now() - _dashboardCache.ts < DASHBOARD_CACHE_TTL_MS) {
      return _dashboardCache.html;
    }
    const [state, indeedStatus, dashboardJobs, apecStatus, apecRunStatus] = await Promise.all([
      readJobSearchState(),
      redisGetIndeedLastRun(),
      redisGetDashboardJobs(),
      getApecPlaywrightStatus(),
      redisGetApecStatus(),
    ]);
    const html = renderHtml(state, indeedStatus, dashboardJobs, apecStatus, apecRunStatus);
    _dashboardCache = { html, ts: Date.now() };
    return html;
  }

  async getHistoryPage(): Promise<string> {
    const entries = await redisGetJobHistory();
    return renderHistoryHtml(entries);
  }

  async getPlatformStatusPage(): Promise<string> {
    if (_platformStatusCache && Date.now() - _platformStatusCache.ts < PLATFORM_CACHE_TTL_MS) {
      return _platformStatusCache.html;
    }
    const health = await getPlatformHealth();
    const html = renderPlatformStatusHtml(health);
    _platformStatusCache = { html, ts: Date.now() };
    return html;
  }

  async getLogsPage(): Promise<string> {
    const logs = await redisGetLogs(300);
    return renderLogsHtml(logs);
  }

  async getPlatformStatusJson(): Promise<Record<string, unknown>> {
    const health = await getPlatformHealth();
    if (!health) {
      return { ok: false, error: 'No platform health recorded yet — run a scan first.' };
    }
    const failing = health.sources.filter((s) => s.status === 'error' || s.status === 'blocked' || s.status === 'proxy_offline');
    return {
      ok: true,
      updatedAt: health.updatedAt,
      proxy: health.proxy,
      totalSources: health.sources.length,
      failing: failing.length,
      sources: health.sources,
    };
  }

  async getTailoredCvPage(hash: string): Promise<string> {
    const state = await readJobSearchState();
    const match = state.latestMatches.find((m) => hashJobUrl(m.job.canonicalUrl) === hash);

    if (!match) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not found</title>
        <style>body{font-family:sans-serif;padding:40px;color:#374151;}a{color:#2563eb;}</style></head>
        <body><h2>Session expired</h2>
        <p>This job is no longer in the current match list. The bot may have restarted or completed a new cycle.</p>
        <p><a href="/">Back to Dashboard</a> — run the bot again to reload matches.</p></body></html>`;
    }

    const keywords = match.atsMissingKeywords ?? [];
    const suggestions = match.atsPlacementSuggestions ?? [];
    return renderCvHtml(match.job.title, match.job.company, keywords, suggestions);
  }

  async getGeminiStatusLite(): Promise<Record<string, unknown>> {
    const state = getGeminiModuleState();
    const today = state.dailyCallPacificDay || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
    const redisDailyCallCount = await redisGetGeminiDailyCalls(today);
    const working = state.keys.filter((k) => k.status === 'ok').length;
    const exhausted = state.keys.filter((k) => k.status === 'quota_exhausted').length;
    const untested = state.keys.filter((k) => k.status === 'untested').length;
    return {
      ...state,
      totalKeys: state.keys.length,
      working,
      quotaExhausted: exhausted,
      untested,
      redisDailyCallCount,
      checkedAt: new Date().toISOString(),
    };
  }

  private async safeRun(trigger: 'startup' | 'interval' | 'manual'): Promise<void> {
    if (this.activeRun) {
      this.logger.warn(`Skipping ${trigger} run because another scan is still active.`);
      return this.activeRun;
    }

    this.activeRun = (async () => {
      try {
        const summary = await runJobSearchOnce();
        _dashboardCache = null; // new jobs available — next load rebuilds from Redis
        _healthCache = null;
        this.logger.log(
          `[${trigger}] fetched ${summary.allJobsCount} jobs, ${summary.freshJobsCount} fresh, ${summary.matchCount} matched.`,
        );
      } catch (error) {
        this.logger.error(
          `[${trigger}] job scan failed`,
          error instanceof Error ? error.stack : String(error),
        );
      } finally {
        this.activeRun = null;
      }
    })();

    return this.activeRun;
  }

  // ─── Admin / permit-update page ──────────────────────────────────────────

  async getAdminPage(cookieHeader: string | undefined, flash?: string): Promise<string> {
    if (!isAdminAuthenticated(cookieHeader)) {
      return renderAdminLoginHtml(false);
    }
    const profile = await loadSearchProfile();
    const wa = profile.candidate.workAuthorization;
    return renderAdminSettingsHtml(
      wa?.permitName ?? '',
      wa?.expiry ?? '',
      flash,
    );
  }

  adminLogin(password: string, res: Response): void {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      res.status(500).send('ADMIN_PASSWORD environment variable is not set.');
      return;
    }
    if (password !== expected) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(renderAdminLoginHtml(true));
      return;
    }
    const token = signAdminToken(Date.now());
    const maxAge = 24 * 60 * 60; // 24 h in seconds
    res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Strict`);
    res.redirect('/admin');
  }

  adminLogout(res: Response): void {
    res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    res.redirect('/admin');
  }

  // Forgot password: send the current ADMIN_PASSWORD to the configured Telegram
  // chat. Nothing is exposed in the browser — the password only ever lands in
  // your private Telegram, which only you can read.
  async adminRecover(res: Response): Promise<void> {
    res.setHeader('content-type', 'text/html; charset=utf-8');

    const password = process.env.ADMIN_PASSWORD;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!password) {
      res.send(renderAdminRecoverResultHtml('error', 'No password is set yet. Set the ADMIN_PASSWORD environment variable on Render first.'));
      return;
    }
    if (!botToken || !chatId) {
      res.send(renderAdminRecoverResultHtml('error', 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing), so the password could not be sent.'));
      return;
    }

    try {
      await sendTelegramMessages(botToken, chatId, [
        {
          text:
            `🔐 Admin password recovery\n\n` +
            `Your admin password is:\n${password}\n\n` +
            `Recovery contact on file: ${RECOVERY_EMAIL}\n` +
            `Requested at ${new Date().toLocaleString('en-GB')}.\n\n` +
            `If you did not request this, change ADMIN_PASSWORD on Render immediately.`,
        },
      ]);
      res.send(renderAdminRecoverResultHtml('ok', 'Your password has been sent to your Telegram chat. Check your messages.'));
    } catch (err) {
      this.logger.warn(`[admin] recovery send failed: ${(err as Error).message}`);
      res.send(renderAdminRecoverResultHtml('error', 'Could not send the Telegram message. Please try again shortly.'));
    }
  }

  async adminUpdatePermit(
    permitName: string,
    expiry: string,
    cookieHeader: string | undefined,
    res: Response,
  ): Promise<void> {
    if (!isAdminAuthenticated(cookieHeader)) {
      res.redirect('/admin');
      return;
    }

    const pName = (permitName ?? '').trim();
    const pExpiry = (expiry ?? '').trim();
    if (!pName || !pExpiry) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(await this.getAdminPage(cookieHeader, 'error:Both fields are required.'));
      return;
    }

    const profilePath = join(process.cwd(), 'job_search_profile.json');
    const raw = await loadSearchProfile();

    const country = raw.candidate.workAuthorization?.country ?? 'France';
    const countryCode = raw.candidate.workAuthorization?.countryCode ?? 'FR';
    raw.candidate.workAuthorization = {
      permitName: pName,
      country,
      countryCode,
      expiry: pExpiry,
      statusLine: `Authorized to work in ${country}. ${pName} valid to ${pExpiry}, standard changement de statut on contract signing.`,
      visaContext: `French ${pName} (valid to ${pExpiry}). Already legally resident in France, no overseas visa process required.`,
    };

    await writeFile(profilePath, JSON.stringify(raw, null, 2), 'utf-8');
    res.redirect('/admin?updated=1');
  }

  async getAnswerQuestionsPage(hash?: string): Promise<string> {
    let company = '';
    let title = '';
    let description = '';
    if (hash) {
      const state = await readJobSearchState();
      const match = state.latestMatches.find((m) => hashJobUrl(m.job.canonicalUrl) === hash);
      if (match) {
        company = match.job.company;
        title = match.job.title;
        description = match.job.description?.slice(0, 600) ?? '';
      }
    }
    return renderAnswerQuestionsFormHtml(company, title, description, hash ?? '');
  }

  async submitAnswerQuestions(
    company: string,
    title: string,
    description: string,
    questionsText: string,
    hash: string,
  ): Promise<string> {
    const questions = (questionsText ?? '')
      .split('\n')
      .map((q) => q.trim())
      .filter(Boolean);
    if (!questions.length) {
      return renderAnswerQuestionsFormHtml(company, title, description, hash, 'Please enter at least one question.');
    }
    const profile = await loadSearchProfile();
    const answers = await generateShortAnswers(company, title, description, questions, profile);
    if (!answers) {
      return renderAnswerQuestionsFormHtml(company, title, description, hash, 'Gemini is currently unavailable — all API keys are quota-exhausted. Try again after midnight Pacific time.');
    }
    return renderAnswerQuestionsResultHtml(company, title, answers, hash);
  }
}

function shouldEnableScheduler(): boolean {
  const runMode = (process.env.RUN_MODE ?? 'continuous').toLowerCase();
  return runMode === 'continuous' || runMode === 'railway' || runMode === 'web';
}

function renderLogsHtml(logs: BotLogEntry[]): string {
  const fmtTs = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return iso; }
  };
  const levelStyle: Record<string, string> = {
    info:  'background:#dbeafe;color:#1e40af',
    warn:  'background:#fef3c7;color:#92400e',
    error: 'background:#fee2e2;color:#b91c1c',
  };
  const rows = logs.length === 0
    ? `<tr><td colspan="4" style="text-align:center;padding:40px;color:#6b7280;">No logs yet — run the bot once to start seeing entries here.</td></tr>`
    : logs.map((e) => {
        const ls = levelStyle[e.level] ?? levelStyle['info'];
        return `<tr>
          <td style="padding:8px 12px;font-size:12px;color:#6b7280;white-space:nowrap;">${fmtTs(e.ts)}</td>
          <td style="padding:8px 12px;">
            <span style="display:inline-block;padding:2px 7px;border-radius:99px;font-size:11px;font-weight:700;${ls}">${escapeHtml(e.level.toUpperCase())}</span>
          </td>
          <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#374151;white-space:nowrap;">${escapeHtml(e.tag)}</td>
          <td style="padding:8px 12px;font-size:13px;color:#111827;word-break:break-word;">${escapeHtml(e.msg)}</td>
        </tr>`;
      }).join('');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bot Logs</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             margin: 0; padding: 24px 20px; background: #f1f5f9; color: #111827; min-height: 100vh; }
      .page { max-width: 1200px; margin: 0 auto; }
      h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; }
      .subtitle { color: #6b7280; font-size: 14px; margin: 0 0 20px; }
      .card { background: white; border-radius: 14px; overflow: hidden;
              box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04); }
      .nav { margin-bottom: 20px; display: flex; align-items: center; gap: 16px; }
      .nav a { color: #2563eb; text-decoration: none; font-size: 14px; }
      .refresh-btn { padding: 6px 14px; background: #2563eb; color: white; border: 0;
                     border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
      table { width: 100%; border-collapse: collapse; }
      thead th { background: #f8fafc; padding: 10px 12px; text-align: left;
                 font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase;
                 letter-spacing: .05em; border-bottom: 1px solid #e5e7eb; }
      tbody tr:hover { background: #f8fafc; }
      tbody td { border-bottom: 1px solid #f3f4f6; vertical-align: top; }
      tbody tr:last-child td { border-bottom: 0; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="nav">
        <a href="/">← Dashboard</a>
        <button class="refresh-btn" onclick="location.reload()">Refresh</button>
        <span style="font-size:13px;color:#9ca3af;">Showing last ${logs.length} entries (newest first)</span>
      </div>
      <h1>Bot Logs</h1>
      <p class="subtitle">Persistent run log — survives restarts via Redis.</p>
      <div class="card">
        <table>
          <thead><tr>
            <th style="width:140px;">Time</th>
            <th style="width:70px;">Level</th>
            <th style="width:110px;">Tag</th>
            <th>Message</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </body>
</html>`;
}

function renderDiagnosticHtml(d: ScorerDiagnostic): string {
  const pct = (n: number) => d.freshJobs > 0 ? ` (${Math.round(n / d.freshJobs * 100)}%)` : '';
  const row = (label: string, n: number, sub?: string) =>
    n > 0 ? `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:13px;">
      <span style="color:#374151;">${label}${sub ? `<span style="color:#9ca3af;margin-left:8px;font-size:11px;">${sub}</span>` : ''}</span>
      <span style="font-weight:600;color:#ef4444;">${n}${pct(n)}</span>
    </div>` : '';
  const zeroMatch = d.matched === 0 && d.freshJobs > 0;
  const borderColor = zeroMatch ? '#f59e0b' : '#e5e7eb';
  const headerColor = zeroMatch ? '#92400e' : '#6b7280';
  return `
    <div style="margin-top:14px;padding:14px 16px;border-radius:10px;border:1px solid ${borderColor};background:${zeroMatch ? '#fffbeb' : '#f9fafb'};">
      <div style="font-size:12px;font-weight:700;color:${headerColor};text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">
        ${zeroMatch ? 'Why 0 matches? — last run breakdown' : 'Last run breakdown'}
      </div>
      <div style="font-size:13px;color:#6b7280;margin-bottom:10px;">
        <strong style="color:#111827;">${d.freshJobs}</strong> fresh jobs scanned →
        <strong style="color:${d.matched > 0 ? '#15803d' : '#ef4444'};">${d.matched} matched</strong>
        ${d.sent > 0 ? ` → <strong style="color:#2563eb;">${d.sent} sent to Telegram</strong>` : ''}
      </div>
      ${row('Language mismatch', d.filtered.lang)}
      ${row('Title excluded (intern / senior / lead / etc)', d.filtered.titleExcl)}
      ${row('Role excluded (frontend / AI / DevOps / etc)', d.filtered.roleExcl)}
      ${row('Location rejected', d.filtered.location, (d.locationBreak.euOnsite || d.locationBreak.euHybrid) ? `EU on-site: ${d.locationBreak.euOnsite} | EU hybrid: ${d.locationBreak.euHybrid} | USA remote: ${d.locationBreak.usaRemote} | other: ${d.locationBreak.other}` : undefined)}
      ${row('Experience out of range', d.filtered.exp)}
      ${row('Salary below minimum (€3,300/mo)', d.filtered.salary ?? 0)}
      ${row('Missing mandatory keywords (Node.js / TS / backend)', d.filtered.mandatory)}
      ${row('Score below threshold', d.filtered.score)}
      ${d.geminiRejected > 0 ? row('Gemini relevance < 55', d.geminiRejected) : ''}
      ${d.deadUrls > 0 ? row('Dead URLs filtered', d.deadUrls) : ''}
    </div>`;
}

function renderAnswerQuestionsFormHtml(
  company: string,
  title: string,
  description: string,
  hash: string,
  error?: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Answer Application Questions</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             margin: 0; padding: 24px 20px; background: #f1f5f9; color: #111827; min-height: 100vh; }
      .page { max-width: 700px; margin: 0 auto; }
      h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
      .card { background: white; border-radius: 14px; padding: 28px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04); }
      .nav { margin-bottom: 20px; }
      .nav a { color: #2563eb; text-decoration: none; font-size: 14px; }
      .field { margin-bottom: 18px; }
      .field label { display:block; font-size:13px; font-weight:600; color:#374151; margin-bottom:6px; }
      .field input, .field textarea { width:100%; padding:9px 12px; border:1px solid #d1d5db; border-radius:8px;
        font-size:14px; font-family:inherit; color:#111827; outline:none; resize:vertical; }
      .field input:focus, .field textarea:focus { border-color:#2563eb; box-shadow:0 0 0 3px rgba(37,99,235,.12); }
      .btn { padding:10px 24px; background:#2563eb; color:white; border:0; border-radius:8px;
             font-size:14px; font-weight:600; cursor:pointer; }
      .btn:hover { background:#1d4ed8; }
      .error { background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:10px 14px;
               color:#dc2626; font-size:13px; margin-bottom:18px; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="nav"><a href="/">← Back to Dashboard</a></div>
      <div class="card">
        <h1>Answer Application Questions</h1>
        <p style="color:#6b7280;margin:0 0 22px;font-size:14px;">Paste the questions from a job application form. Gemini will write tailored answers based on your CV and the specific role.</p>
        ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
        <form method="post" action="/jobs/answer-questions">
          <div class="field">
            <label>Company *</label>
            <input type="text" name="company" value="${escapeHtml(company)}" required placeholder="e.g. Stripe" />
          </div>
          <div class="field">
            <label>Job Title *</label>
            <input type="text" name="title" value="${escapeHtml(title)}" required placeholder="e.g. Backend Engineer" />
          </div>
          <div class="field">
            <label>Job Description <span style="font-weight:400;color:#9ca3af;">(optional — helps tailor answers)</span></label>
            <textarea name="description" rows="3" placeholder="Paste a few sentences about the role...">${escapeHtml(description)}</textarea>
          </div>
          <div class="field">
            <label>Application Questions <span style="font-weight:400;color:#9ca3af;">(one per line) *</span></label>
            <textarea name="questions" rows="8" required
              placeholder="Why do you want to work here?&#10;Describe your experience with microservices.&#10;What is your greatest professional achievement?"></textarea>
          </div>
          <input type="hidden" name="hash" value="${escapeHtml(hash)}" />
          <button type="submit" class="btn">Generate Answers</button>
        </form>
      </div>
    </div>
  </body>
</html>`;
}

function renderAnswerQuestionsResultHtml(
  company: string,
  title: string,
  answers: Array<{ question: string; answer: string }>,
  hash: string,
): string {
  const pairs = answers.map((a, i) => `
    <div style="margin-bottom:20px;padding:16px;background:#f8fafc;border-radius:10px;border:1px solid #e5e7eb;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Question ${i + 1}</div>
      <div style="font-size:14px;color:#374151;margin-bottom:10px;">${escapeHtml(a.question)}</div>
      <div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Answer</div>
      <div id="ans-${i}" style="font-size:14px;color:#111827;line-height:1.6;white-space:pre-wrap;">${escapeHtml(a.answer)}</div>
      <button onclick="copyAns(${i})" style="margin-top:10px;padding:5px 14px;background:white;border:1px solid #d1d5db;border-radius:6px;font-size:12px;cursor:pointer;color:#374151;">Copy</button>
    </div>`).join('');
  const backLink = hash
    ? `<a href="/jobs/answer-questions?hash=${encodeURIComponent(hash)}" style="color:#2563eb;text-decoration:none;">← Ask different questions</a> &nbsp;·&nbsp; `
    : `<a href="/jobs/answer-questions" style="color:#2563eb;text-decoration:none;">← New questions</a> &nbsp;·&nbsp; `;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Answers — ${escapeHtml(title)} at ${escapeHtml(company)}</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             margin: 0; padding: 24px 20px; background: #f1f5f9; color: #111827; min-height: 100vh; }
      .page { max-width: 700px; margin: 0 auto; }
      h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
      .card { background: white; border-radius: 14px; padding: 28px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04); }
      .nav { margin-bottom: 20px; font-size: 14px; }
      .nav a { color: #2563eb; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="nav">${backLink}<a href="/" style="color:#2563eb;text-decoration:none;">Dashboard</a></div>
      <div class="card">
        <h1>Answers</h1>
        <p style="color:#6b7280;font-size:14px;margin:0 0 20px;">${escapeHtml(title)} at ${escapeHtml(company)}</p>
        ${pairs}
      </div>
    </div>
    <script>
      function copyAns(i) {
        var el = document.getElementById('ans-' + i);
        navigator.clipboard.writeText(el.innerText).then(function() {
          var btn = el.nextElementSibling;
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
        });
      }
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scoreColor(score: number): string {
  if (score >= 80) return '#15803d';
  if (score >= 65) return '#b45309';
  return '#b91c1c';
}

function scoreBg(score: number): string {
  if (score >= 80) return '#dcfce7';
  if (score >= 65) return '#fef3c7';
  return '#fee2e2';
}

function workModeBadge(mode: string): string {
  const styles: Record<string, string> = {
    remote: 'background:#dbeafe;color:#1e40af',
    hybrid: 'background:#ede9fe;color:#5b21b6',
    'on-site': 'background:#f3f4f6;color:#374151',
  };
  const style = styles[mode] ?? styles['on-site'];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;${style}">${escapeHtml(mode)}</span>`;
}

function statusDot(status: string): string {
  const colors: Record<string, string> = { success: '#16a34a', error: '#dc2626', running: '#d97706', gemini_waiting: '#7c3aed', idle: '#9ca3af' };
  const color = colors[status] ?? colors['idle'];
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle;"></span>`;
}

function renderHistoryHtml(entries: JobHistoryEntry[]): string {
  const applied = entries.filter((e) => e.type === 'applied');
  const dismissed = entries.filter((e) => e.type === 'dismissed');

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return iso; }
  };

  const tableRows = (rows: JobHistoryEntry[], type: 'applied' | 'dismissed') => {
    if (!rows.length) {
      return `<tr><td colspan="6" style="text-align:center;padding:32px;color:#6b7280;">
        No ${type} jobs yet.${type === 'applied' ? ' Use the Applied button on a job card to track it here.' : ''}
      </td></tr>`;
    }
    return rows.map((e, i) => {
      const bg = type === 'applied' ? '#f0fdf4' : '#fafafa';
      const badge = type === 'applied'
        ? `<span style="padding:2px 8px;border-radius:99px;background:#dcfce7;color:#15803d;font-size:11px;font-weight:700;">APPLIED</span>`
        : `<span style="padding:2px 8px;border-radius:99px;background:#f3f4f6;color:#6b7280;font-size:11px;font-weight:700;">DISMISSED</span>`;
      const sc = e.score;
      const scColor = sc >= 80 ? '#15803d' : sc >= 60 ? '#d97706' : '#6b7280';
      const scBg = sc >= 80 ? '#dcfce7' : sc >= 60 ? '#fef3c7' : '#f3f4f6';
      return `
        <tr style="background:${i % 2 === 0 ? 'white' : bg};">
          <td style="padding:10px 14px;font-size:13px;color:#6b7280;">${fmtDate(e.date)}</td>
          <td style="padding:10px 14px;">
            <div style="font-weight:600;font-size:14px;">${escapeHtml(e.title)}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px;">${escapeHtml(e.source)}</div>
          </td>
          <td style="padding:10px 14px;font-weight:500;font-size:14px;">${escapeHtml(e.company)}</td>
          <td style="padding:10px 14px;">
            <span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;font-weight:700;color:${scColor};background:${scBg};">${sc}%</span>
          </td>
          <td style="padding:10px 14px;">${badge}</td>
          <td style="padding:10px 14px;">
            <a href="${escapeHtml(e.url)}" target="_blank" rel="noreferrer"
               style="font-size:12px;color:#2563eb;text-decoration:none;">View →</a>
          </td>
        </tr>`;
    }).join('');
  };

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Application History — Uman Mushtaq</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             margin: 0; padding: 24px 20px; background: #f1f5f9; color: #111827; min-height: 100vh; }
      .page { max-width: 1100px; margin: 0 auto; }
      h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; }
      .subtitle { color: #6b7280; font-size: 14px; margin: 0 0 20px; }
      .card { background: white; border-radius: 14px; padding: 24px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04); margin-bottom: 20px; }
      .nav { margin-bottom: 20px; }
      .nav a { color: #2563eb; text-decoration: none; font-size: 14px; }
      .tab-bar { display:flex; gap:6px; margin-bottom:20px; }
      .tab-btn { padding:9px 20px; border-radius:8px; font-size:14px; font-weight:600;
                 border:0; cursor:pointer; transition:background .15s,color .15s; }
      .tab-btn.active-applied  { background:#2563eb; color:white; }
      .tab-btn.active-dismissed{ background:#6b7280; color:white; }
      .tab-btn.inactive { background:#f3f4f6; color:#374151; }
      .tab-btn.inactive:hover  { background:#e5e7eb; }
      table { width: 100%; border-collapse: collapse; }
      thead th { background:#f8fafc; padding:10px 14px; text-align:left;
                 font-size:11px; font-weight:700; color:#6b7280; text-transform:uppercase;
                 letter-spacing:.05em; border-bottom:1px solid #e5e7eb; }
      tbody tr:hover { background:#f8fafc !important; }
      tbody td { border-bottom:1px solid #f3f4f6; vertical-align:middle; }
      tbody tr:last-child td { border-bottom:0; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="nav"><a href="/">← Back to Dashboard</a></div>
      <h1>Application History</h1>
      <p class="subtitle">${applied.length} applied · ${dismissed.length} dismissed</p>

      <div class="tab-bar">
        <button class="tab-btn" id="btn-applied" onclick="switchTab('applied')">
          Applied (${applied.length})
        </button>
        <button class="tab-btn" id="btn-dismissed" onclick="switchTab('dismissed')">
          Dismissed (${dismissed.length})
        </button>
      </div>

      <div class="card" id="section-applied">
        <table>
          <thead><tr>
            <th>Date</th><th>Job</th><th>Company</th><th>Score</th><th>Status</th><th>Link</th>
          </tr></thead>
          <tbody>${tableRows(applied, 'applied')}</tbody>
        </table>
      </div>

      <div class="card" id="section-dismissed" style="display:none;">
        <table>
          <thead><tr>
            <th>Date</th><th>Job</th><th>Company</th><th>Score</th><th>Status</th><th>Link</th>
          </tr></thead>
          <tbody>${tableRows(dismissed, 'dismissed')}</tbody>
        </table>
      </div>
    </div>
    <script>
      function switchTab(tab) {
        var isApplied = tab === "applied";
        document.getElementById("section-applied").style.display  = isApplied ? "" : "none";
        document.getElementById("section-dismissed").style.display = isApplied ? "none" : "";
        document.getElementById("btn-applied").className   = "tab-btn " + (isApplied ? "active-applied"   : "inactive");
        document.getElementById("btn-dismissed").className = "tab-btn " + (isApplied ? "inactive" : "active-dismissed");
        history.replaceState(null, "", "?tab=" + tab);
      }
      var initialTab = new URLSearchParams(window.location.search).get("tab");
      switchTab(initialTab === "dismissed" ? "dismissed" : "applied");
    </script>
  </body>
</html>`;
}

function renderCvHtml(
  forJobTitle: string,
  forCompany: string,
  atsMissingKeywords: string[],
  atsSuggestions: string[],
): string {
  const kwTags = atsMissingKeywords
    .map((k) => `<span class="kw-tag">${escapeHtml(k)}</span>`)
    .join(' ');

  const atsPanel = atsMissingKeywords.length > 0
    ? `<div class="no-print ats-panel">
        <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">
          ATS keywords this role scans for — consider weaving these in where they naturally fit
        </div>
        <div style="margin-bottom:${atsSuggestions.length > 0 ? '8px' : '0'};">${kwTags}</div>
        ${atsSuggestions.length > 0
          ? `<ul style="margin:0;padding:0 0 0 16px;font-size:12px;color:#374151;line-height:1.6;">${atsSuggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
          : ''}
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CV — Uman Mushtaq</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1a1a1a;
      background: #cbd5e1;
    }

    /* ── Toolbar (screen only) ─────────────────────────────── */
    .toolbar {
      position: sticky; top: 0; z-index: 10;
      background: #1e293b;
      padding: 10px 24px;
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .toolbar a { color: #94a3b8; text-decoration: none; font-size: 13px; }
    .toolbar a:hover { color: white; }
    .toolbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .toolbar-job { font-size: 13px; color: #94a3b8; }
    .toolbar-job b { color: #e2e8f0; }
    .tbtn {
      padding: 7px 18px; border-radius: 6px; font-size: 13px; font-weight: 600;
      border: 0; cursor: pointer; font-family: inherit;
    }
    .tbtn-pdf  { background: #2563eb; color: white; }
    .tbtn-copy { background: #334155; color: #e2e8f0; border: 1px solid #475569; }
    .tbtn-tip  { background: transparent; color: #64748b; font-size: 12px; border: 1px dashed #475569; }

    /* ── ATS panel (screen only) ───────────────────────────── */
    .ats-panel {
      background: #fffbeb;
      border-bottom: 2px solid #fde68a;
      padding: 12px 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .kw-tag {
      display: inline-block; margin: 2px;
      padding: 2px 9px;
      background: #fef3c7; border: 1px solid #fde68a;
      border-radius: 99px; font-size: 12px; font-weight: 600; color: #92400e;
    }
    .print-tip {
      background: #f1f5f9;
      border-bottom: 1px solid #e2e8f0;
      padding: 7px 24px;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px; color: #64748b;
    }

    /* ── A4 page ───────────────────────────────────────────── */
    .cv-page {
      max-width: 794px;
      margin: 28px auto 48px;
      background: white;
      padding: 54px 64px 60px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    }

    /* Header */
    .cv-name {
      text-align: center; font-size: 30px; font-weight: bold;
      letter-spacing: 0.02em; margin-bottom: 3px;
    }
    .cv-contact {
      text-align: center; font-size: 12px; color: #374151;
      display: flex; justify-content: center; flex-wrap: wrap;
      gap: 2px 14px; margin: 6px 0 0;
    }
    .cv-contact a { color: #374151; text-decoration: none; }

    /* Dividers */
    .divider-bold { border: none; border-top: 1.5px solid #1a1a1a; margin: 14px 0; }
    .divider-light { border: none; border-top: 1px solid #d1d5db; margin: 12px 0; }

    /* Section rows */
    .cv-section {
      display: grid;
      grid-template-columns: 100px 1fr;
      gap: 0 22px;
      align-items: start;
    }
    .cv-label {
      font-size: 11.5px; color: #6b7280; padding-top: 2px;
    }
    .cv-body { }

    /* Experience */
    .job { margin-bottom: 18px; }
    .job:last-child { margin-bottom: 0; }
    .job-top {
      display: flex; justify-content: space-between;
      align-items: baseline; margin-bottom: 1px;
    }
    .job-co { font-weight: bold; font-size: 14px; }
    .job-loc { font-size: 12px; color: #4b5563; }
    .job-title-row {
      display: flex; justify-content: space-between;
      align-items: baseline; margin-bottom: 5px;
    }
    .job-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #374151; }
    .job-dates { font-size: 12px; color: #4b5563; }
    .job-bullets { margin: 0; padding: 0 0 0 14px; }
    .job-bullets li { margin-bottom: 4px; font-size: 12.5px; line-height: 1.55; }

    /* Projects */
    .proj { margin-bottom: 14px; }
    .proj:last-child { margin-bottom: 0; }
    .proj-top {
      display: flex; justify-content: space-between;
      align-items: baseline; margin-bottom: 3px;
    }
    .proj-name { font-weight: bold; font-size: 13px; }
    .proj-dates { font-size: 12px; color: #4b5563; white-space: nowrap; margin-left: 12px; }
    .proj-desc { font-size: 12.5px; line-height: 1.55; }

    /* Education */
    .edu { margin-bottom: 12px; }
    .edu:last-child { margin-bottom: 0; }
    .edu-top {
      display: flex; justify-content: space-between;
      align-items: baseline;
    }
    .edu-school { font-weight: bold; font-size: 13px; }
    .edu-type { font-size: 12px; color: #4b5563; }
    .edu-deg-row {
      display: flex; justify-content: space-between;
      align-items: baseline;
    }
    .edu-deg { font-size: 12.5px; }
    .edu-dates { font-size: 12px; color: #4b5563; }

    /* ── Print ─────────────────────────────────────────────── */
    @media print {
      @page { size: A4; margin: 0; }
      body { background: white; padding: 1.7cm 2cm 1.5cm; font-size: 12px; }
      .no-print, .toolbar, .ats-panel, .print-tip { display: none !important; }
      .cv-page { max-width: none; margin: 0; padding: 0; box-shadow: none; }
      .divider-bold { border-top-width: 1.2px; margin: 11px 0; }
      .divider-light { margin: 10px 0; }
    }
  </style>
</head>
<body>

  <div class="no-print toolbar">
    <a href="/">← Dashboard</a>
    <div class="toolbar-right">
      <span class="toolbar-job">CV for <b>${escapeHtml(forJobTitle)}</b> at <b>${escapeHtml(forCompany)}</b></span>
      <button class="tbtn tbtn-copy" onclick="copyAll(event)">Copy text</button>
      <button class="tbtn tbtn-pdf" onclick="window.print()">Save as PDF</button>
    </div>
  </div>

  ${atsPanel}

  <div class="no-print print-tip">
    To hide the URL and date when printing: in Chrome open <b>More settings</b> and uncheck <b>Headers and footers</b>
  </div>

  <div class="cv-page" id="cv-doc">

    <!-- ── Header ──────────────────────────────────────────── -->
    <div class="cv-name">Uman Mushtaq</div>
    <div class="cv-contact">
      <span><a href="mailto:umanmushtaq72@gmail.com">umanmushtaq72@gmail.com</a></span>
      <span>+33 6 51 99 51 39</span>
      <span>Paris, Île-de-France, France</span>
      <span><a href="https://github.com/umanmushtaq" target="_blank" rel="noreferrer">github.com/umanmushtaq</a></span>
      <span><a href="https://linkedin.com/in/umanmushtaq" target="_blank" rel="noreferrer">linkedin.com/in/umanmushtaq</a></span>
    </div>

    <hr class="divider-bold">

    <!-- ── Summary ─────────────────────────────────────────── -->
    <div class="cv-section">
      <div class="cv-label">Summary</div>
      <div class="cv-body">
        Node.js / NestJS Engineer with 4+ years building production-grade microservices in fintech, crypto, and SaaS
        environments. Specialised in scalable backend systems and event-driven architecture (RabbitMQ, Kafka), with
        strong experience in TypeScript, PostgreSQL, Docker, AWS, and CI/CD pipelines. Currently in France on a
        job-search residence permit. Eligible for a fast changement de statut to an employee work permit once a
        contract is signed. Already legally resident, no overseas visa process required.
      </div>
    </div>

    <hr class="divider-light">

    <!-- ── Skills ──────────────────────────────────────────── -->
    <div class="cv-section">
      <div class="cv-label">Skills</div>
      <div class="cv-body">
        <div style="margin-bottom:5px;">
          <strong>Core (Expert):</strong>
          TypeScript, JavaScript, Node.js, NestJS, Express.js, PostgreSQL, Docker, GitHub Actions,
          CI/CD, Microservices, Event-Driven Architecture, Clean Architecture, Domain-Driven Design,
          REST APIs, JWT, OAuth2, Git, Nx Monorepo, TypeORM
        </div>
        <div>
          <strong>Also worked with:</strong>
          React, MongoDB, Redis, RabbitMQ, Kafka, AWS, Sequelize, Mongoose, Prisma, Agile, Scrum
        </div>
      </div>
    </div>

    <hr class="divider-light">

    <!-- ── Experience ──────────────────────────────────────── -->
    <div class="cv-section">
      <div class="cv-label">Experience</div>
      <div class="cv-body">

        <div class="job">
          <div class="job-top">
            <span class="job-co">OptimusFox</span>
            <span class="job-loc">Lahore, Pakistan</span>
          </div>
          <div class="job-title-row">
            <span class="job-title">Software Engineer</span>
            <span class="job-dates">Oct 2021 – Jul 2024</span>
          </div>
          <ul class="job-bullets">
            <li>Built and delivered 4 production microservices across fintech, crypto, and SaaS products using NestJS,
                TypeScript, and Express.js, covering payment flows, wallet management, and trading platform backends.</li>
            <li>Integrated 5 third-party services including Stripe and PayPal for payment processing, Auth0 and Firebase
                for authentication, and Twilio and SendGrid for notifications across multiple backend systems.</li>
            <li>Resolved critical data integrity failures by redesigning PostgreSQL and MongoDB schemas across 3 services,
                eliminating recurring production bugs and improving query reliability.</li>
            <li>Built GitHub Actions CI/CD pipelines from scratch across 4 services, reducing manual deployment effort
                by approximately 60% and standardising release workflows for a team of 10 engineers.</li>
            <li>Dockerized 4 backend services with multi-stage builds and environment-specific configurations, ensuring
                consistent deployments across development and production.</li>
            <li>Collaborated with a cross-functional team of 10 engineers to ship features across fintech payment
                platforms and crypto trading systems within 2-week sprint cycles.</li>
          </ul>
        </div>

        <div class="job">
          <div class="job-top">
            <span class="job-co">Teams.pk</span>
            <span class="job-loc">Lahore, Pakistan</span>
          </div>
          <div class="job-title-row">
            <span class="job-title">Node.js Developer</span>
            <span class="job-dates">Jun 2020 – Sep 2021</span>
          </div>
          <ul class="job-bullets">
            <li>Built and maintained REST APIs powering core workflows of a B2B SaaS platform using Node.js, TypeScript,
                and Express.js, supporting approximately 50 business clients.</li>
            <li>Structured backend codebases from early-stage features through to stable production, establishing clean
                architecture patterns adopted across the team.</li>
            <li>Debugged and resolved performance bottlenecks across 3 core API modules, improving response times
                across the platform.</li>
          </ul>
        </div>

      </div>
    </div>

    <hr class="divider-light">

    <!-- ── Projects ────────────────────────────────────────── -->
    <div class="cv-section">
      <div class="cv-label">Projects</div>
      <div class="cv-body">

        <div class="proj">
          <div class="proj-top">
            <span class="proj-name">NexusPay – Event-Driven Fintech Transaction Platform</span>
            <span class="proj-dates">Apr 2026 – Present</span>
          </div>
          <p class="proj-desc">Event-driven fintech platform built across 7 independent NestJS microservices in an
          Nx monorepo, covering payments, wallets, transfers, notifications, and analytics. Each service owns a
          dedicated PostgreSQL database. RabbitMQ handles Saga-based distributed transactions and Kafka manages
          real-time event streaming. Applies Clean and Hexagonal Architecture with Domain-Driven Design for loose
          coupling and independent scalability. Redis used for caching, rate limiting, and distributed locks.
          Includes JWT and refresh token authentication, full KYC submission and approval workflow with event
          publishing, and 85%+ test coverage across unit, integration, and e2e tests. Infrastructure fully
          Dockerized with GitHub Actions CI/CD pipelines.</p>
        </div>

        <div class="proj">
          <div class="proj-top">
            <span class="proj-name">Aktoo</span>
            <span class="proj-dates">Jan 2024 – Jul 2024</span>
          </div>
          <p class="proj-desc">Training platform for actors built with Node.js, TypeScript, Express.js, and
          PostgreSQL. Designed and implemented structured content delivery APIs supporting multiple content types
          across drama, crime, medical, and comedy genres, with user progress tracking and role-based access
          control.</p>
        </div>

        <div class="proj">
          <div class="proj-top">
            <span class="proj-name">Swiss Block</span>
            <span class="proj-dates">Dec 2022 – May 2023</span>
          </div>
          <p class="proj-desc">Cryptocurrency exchange platform supporting real-time BTC and ETH trading. Built
          secure REST API backend with Node.js, TypeScript, Express.js, and PostgreSQL, integrating 3 third-party
          market data APIs for live price feeds, wallet management, and order execution.</p>
        </div>

        <div class="proj">
          <div class="proj-top">
            <span class="proj-name">Dinisium</span>
            <span class="proj-dates">Mar 2022 – Jul 2023</span>
          </div>
          <p class="proj-desc">White-label marketplace for asset-backed cryptocurrency tokens with role-based
          interfaces for super admins, admins, and investors. Built the backend with Node.js, Express.js, and
          PostgreSQL and integrated the Quorum blockchain mainnet to record all transactions for auditability
          and transparency.</p>
        </div>

      </div>
    </div>

    <hr class="divider-light">

    <!-- ── Education ───────────────────────────────────────── -->
    <div class="cv-section">
      <div class="cv-label">Education</div>
      <div class="cv-body">
        <div class="edu">
          <div class="edu-top">
            <span class="edu-school">Paris School of Business</span>
            <span class="edu-type">Master</span>
          </div>
          <div class="edu-deg-row">
            <span class="edu-deg">Business Administration</span>
            <span class="edu-dates">Oct 2024 – Jul 2025</span>
          </div>
        </div>
        <div class="edu">
          <div class="edu-top">
            <span class="edu-school">University of Central Punjab</span>
            <span class="edu-type">Bachelor</span>
          </div>
          <div class="edu-deg-row">
            <span class="edu-deg">Computer Science</span>
            <span class="edu-dates">Oct 2015 – Aug 2019</span>
          </div>
        </div>
      </div>
    </div>

    <hr class="divider-light">

    <!-- ── Languages ───────────────────────────────────────── -->
    <div class="cv-section">
      <div class="cv-label">Languages</div>
      <div class="cv-body">
        English (Fluent) &nbsp;&middot;&nbsp; French (A1, improving)
      </div>
    </div>

  </div><!-- /cv-page -->

  <script>
    function copyAll(e) {
      var el = document.getElementById('cv-doc');
      if (!el) return;
      var btn = e.target;
      navigator.clipboard.writeText(el.innerText || el.textContent || '').then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy text'; }, 2000);
      }).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = el.innerText || el.textContent || '';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy text'; }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

function renderPlatformStatusHtml(health: PlatformHealth | null): string {
  const fmtDate = (iso: string | null) => {
    if (!iso) return 'never';
    try {
      return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  const STATUS_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
    ok:            { label: 'Working',       color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' },
    empty:         { label: 'No results',    color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
    blocked:       { label: 'Blocked',       color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
    proxy_offline: { label: 'Proxy offline', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
    error:         { label: 'Crashed',       color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
  };

  if (!health) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Platform Status</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px 20px;background:#f1f5f9;color:#111827;}
      .wrap{max-width:760px;margin:0 auto;}a{color:#2563eb;}
      .card{background:white;border-radius:14px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.06);}</style></head>
      <body><div class="wrap"><p><a href="/">← Back to Dashboard</a></p>
      <div class="card"><h1>Platform Status</h1>
      <p style="color:#6b7280;">No health data recorded yet. It is captured automatically on every scan —
      run the bot once (<b>Run now</b> on the dashboard) and refresh this page.</p></div></div></body></html>`;
  }

  const p = health.proxy;
  const proxyMeta = !p.configured
    ? { label: 'Not configured', color: '#b45309', bg: '#fffbeb', border: '#fde68a' }
    : p.online
      ? { label: 'Online', color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' }
      : { label: 'OFFLINE', color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' };

  const proxyCard = `
    <div class="card" style="border-left:4px solid ${proxyMeta.color};">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div>
          <h2 style="margin:0 0 4px;">Home proxy (your residential IP)</h2>
          <div style="font-size:13px;color:#6b7280;">${p.url ? escapeHtml(p.url) : 'no URL set'} · checked ${fmtDate(p.checkedAt)}</div>
        </div>
        <span style="padding:5px 14px;border-radius:99px;font-size:14px;font-weight:700;color:${proxyMeta.color};background:${proxyMeta.bg};border:1px solid ${proxyMeta.border};">${proxyMeta.label}</span>
      </div>
      ${p.error ? `<div style="margin-top:12px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#991b1b;">${escapeHtml(p.error)}</div>` : ''}
      ${!p.configured ? `<div style="margin-top:12px;padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:13px;color:#1d4ed8;line-height:1.6;">
        <b>This is why APEC / Indeed / RemoteOK return nothing.</b> Those sites block cloud-server IPs, so the bot must route through your laptop's residential IP.
        Set <code>JOB_PROXY_URL</code> and <code>JOB_PROXY_SECRET</code> in Render's environment, and keep the proxy + cloudflared running on your laptop.</div>` : ''}
    </div>`;

  // Country tagging — determines which grouped section each source belongs to
  const SOURCE_COUNTRY: Record<string, string> = {
    'apec.fr': 'FR',
    'welcometothejungle.com': 'FR',
    'francetravail.fr': 'FR',
    'adzuna.com': 'FR',
    'arbeitnow.com': 'DE',
    'berlinstartupjobs.com': 'DE',
    'bundesagentur.de': 'DE',
    'arbeitsagentur.de': 'DE',
    'nofluffjobs.com': 'PL',
    'justjoin.it': 'PL',
    'stepstone.be': 'BE',
    'jobat.be': 'BE',
    'indeed.com': 'INTL',
    'greenhouse.io': 'INTL',
    'jobs.lever.co': 'INTL',
    'jobs.ashbyhq.com': 'INTL',
    'eu.talent.io': 'INTL',
    'jobicy.com': 'REMOTE',
    'weworkremotely.com': 'REMOTE',
    'remotive.com': 'REMOTE',
    'remoteok.com': 'REMOTE',
    'news.ycombinator.com': 'REMOTE',
  };

  const GROUPS: Array<{ key: string; flag: string; label: string; bg: string; border: string; runEndpoint?: string }> = [
    { key: 'FR',     flag: '🇫🇷', label: 'France',                  bg: '#fffbeb', border: '#fde68a', runEndpoint: '/run/apec' },
    { key: 'DE',     flag: '🇩🇪', label: 'Germany',                 bg: '#f0f9ff', border: '#bae6fd' },
    { key: 'BE',     flag: '🇧🇪', label: 'Belgium',                  bg: '#f5f3ff', border: '#ddd6fe' },
    { key: 'NL',     flag: '🇳🇱', label: 'Netherlands',              bg: '#f0fdf4', border: '#bbf7d0' },
    { key: 'PL',     flag: '🇵🇱', label: 'Poland',                   bg: '#fef2f2', border: '#fecaca' },
    { key: 'INTL',   flag: '🌐', label: 'International / Multi-country', bg: '#fafaf9', border: '#e7e5e4' },
    { key: 'REMOTE', flag: '🌍', label: 'Remote & Job Boards',       bg: '#f8fafc', border: '#e2e8f0', runEndpoint: '/run/indeed' },
  ];

  const sourceByName = new Map(health.sources.map((s) => [s.source, s]));

  // Per-group job counts for summary bar
  const countByGroup: Record<string, number> = {};
  for (const s of health.sources) {
    const grp = SOURCE_COUNTRY[s.source] ?? 'INTL';
    countByGroup[grp] = (countByGroup[grp] ?? 0) + s.jobsFound;
  }

  // Sources known to be blocked by Cloudflare — needs a proxy fix, not a code fix.
  const CLOUDFLARE_BLOCKED = new Set(['indeed.com', 'eu.talent.io']);

  const makeRow = (s: (typeof health.sources)[number]) => {
    const isCloudflareBlocked = CLOUDFLARE_BLOCKED.has(s.source);
    const m = isCloudflareBlocked
      ? { label: 'Blocked (Cloudflare)', color: '#b45309', bg: '#fffbeb', border: '#fde68a' }
      : STATUS_META[s.status] ?? STATUS_META.error;
    const proxyTag = s.usesProxy
      ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:600;background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;">via proxy</span>`
      : '';
    const failTag = s.consecutiveFailures > 1
      ? `<span style="display:inline-block;margin-left:6px;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:700;background:#fef2f2;color:#b91c1c;">×${s.consecutiveFailures}</span>`
      : '';
    return `
      <tr style="background:${m.bg};">
        <td style="padding:11px 14px;font-weight:600;font-size:14px;">${escapeHtml(s.source)}${proxyTag}${failTag}</td>
        <td style="padding:11px 14px;"><span style="padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;color:${m.color};background:white;border:1px solid ${m.border};">${m.label}</span></td>
        <td style="padding:11px 14px;text-align:center;font-weight:600;font-size:14px;color:${s.jobsFound > 0 ? '#15803d' : '#9ca3af'};">${s.jobsFound}</td>
        <td style="padding:11px 14px;font-size:13px;color:#6b7280;">${(s.durationMs / 1000).toFixed(1)}s</td>
        <td style="padding:11px 14px;font-size:12px;color:#6b7280;">${fmtDate(s.lastSuccessAt)}</td>
        <td style="padding:11px 14px;font-size:12px;color:#b91c1c;max-width:280px;">${s.error ? escapeHtml(s.error) : ''}</td>
      </tr>`;
  };

  const TABLE_HEAD = `<thead><tr>
    <th>Source</th><th>Status</th><th style="text-align:center;">Jobs</th><th>Duration</th><th>Last success</th><th>Problem</th>
  </tr></thead>`;

  const groupedSections = GROUPS.map(({ key, flag, label, bg, border, runEndpoint }) => {
    // Sources that belong to this group and appear in health data
    const groupSources = health.sources.filter((s) => (SOURCE_COUNTRY[s.source] ?? 'INTL') === key);

    const bodyRows = groupSources.map((s) => makeRow(s)).join('');
    const comingSoon = (key === 'BE' || key === 'NL')
      ? `<tr><td colspan="6" style="padding:16px 14px;font-size:13px;color:#9ca3af;font-style:italic;">No scrapers yet — coming soon</td></tr>`
      : '';
    const totalJobs = groupSources.reduce((n, s) => n + s.jobsFound, 0);

    const runBtn = runEndpoint
      ? `<form method="post" action="${runEndpoint}" style="display:inline;">
           <button type="submit" style="padding:4px 12px;font-size:12px;font-weight:600;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;">▶ Run</button>
         </form>`
      : '';

    return `
      <div class="card" style="border-top:3px solid ${border};background:${bg};">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
          <h2 style="margin:0;font-size:17px;">${flag} ${escapeHtml(label)}</h2>
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:13px;color:#6b7280;">${totalJobs} job${totalJobs !== 1 ? 's' : ''} found</span>
            ${runBtn}
          </div>
        </div>
        <div class="table-wrap">
          <table>${TABLE_HEAD}<tbody>${bodyRows}${comingSoon}</tbody></table>
        </div>
      </div>`;
  }).join('');

  const failing = health.sources.filter((s) => s.status === 'error' || s.status === 'blocked' || s.status === 'proxy_offline').length;
  const okCount = health.sources.filter((s) => s.status === 'ok').length;

  const summaryBar = [
    { key: 'FR', flag: '🇫🇷', label: 'FR' },
    { key: 'DE', flag: '🇩🇪', label: 'DE' },
    { key: 'BE', flag: '🇧🇪', label: 'BE' },
    { key: 'NL', flag: '🇳🇱', label: 'NL' },
    { key: 'PL', flag: '🇵🇱', label: 'PL' },
    { key: 'INTL', flag: '🌐', label: 'INTL' },
    { key: 'REMOTE', flag: '🌍', label: 'Remote' },
  ].map(({ key, flag, label }) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 12px;background:white;border:1px solid #e5e7eb;border-radius:99px;font-size:13px;font-weight:600;color:#374151;">
      ${flag} ${label}: <strong style="color:#2563eb;">${countByGroup[key] ?? 0}</strong>
    </span>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Platform Status — Job Search Bot</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
             margin: 0; padding: 24px 20px; background: #f1f5f9; color: #111827; min-height: 100vh; }
      .page { max-width: 1100px; margin: 0 auto; }
      h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; }
      h2 { margin: 0; font-size: 16px; font-weight: 600; }
      .subtitle { color: #6b7280; font-size: 14px; margin: 0 0 20px; }
      .nav { margin-bottom: 20px; } .nav a { color: #2563eb; text-decoration: none; font-size: 14px; }
      .card { background: white; border-radius: 14px; padding: 22px 24px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04); margin-bottom: 18px; }
      table { width: 100%; border-collapse: collapse; }
      thead th { background:#f8fafc; padding:10px 14px; text-align:left; font-size:11px; font-weight:700;
                 color:#6b7280; text-transform:uppercase; letter-spacing:.05em; border-bottom:2px solid #e5e7eb; }
      thead th:nth-child(3){ text-align:center; }
      tbody td { border-bottom:1px solid #f3f4f6; vertical-align:middle; }
      tbody tr:last-child td { border-bottom:0; }
      .table-wrap { overflow-x:auto; border-radius:10px; border:1px solid #e5e7eb; }
      code { background:#f1f5f9; padding:1px 5px; border-radius:4px; font-size:12px; }
      .pills span { display:inline-block; padding:4px 12px; border-radius:99px; font-size:13px; font-weight:600; margin-right:8px; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="nav"><a href="/">← Back to Dashboard</a></div>
      <h1>Platform Status</h1>
      <p class="subtitle">Per-source health, recorded automatically every scan · updated ${fmtDate(health.updatedAt)}</p>

      <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;">
        <form method="post" action="/run-now">
          <button type="submit" style="padding:8px 18px;font-size:14px;font-weight:600;background:#2563eb;color:white;border:none;border-radius:8px;cursor:pointer;">▶ Run all sources</button>
        </form>
        <form method="post" action="/run/apec">
          <button type="submit" style="padding:8px 18px;font-size:14px;font-weight:600;background:#0e7490;color:white;border:none;border-radius:8px;cursor:pointer;">▶ Run APEC</button>
        </form>
        <form method="post" action="/run/indeed">
          <button type="submit" style="padding:8px 18px;font-size:14px;font-weight:600;background:#0e7490;color:white;border:none;border-radius:8px;cursor:pointer;">▶ Run Indeed</button>
        </form>
      </div>

      ${proxyCard}

      <div class="card" style="padding:16px 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
          <div style="font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Jobs found by country</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:13px;color:#6b7280;">${health.sources.length} sources · ${okCount} working${failing > 0 ? ` · <span style="color:#b91c1c;">${failing} need attention</span>` : ''}</span>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">${summaryBar}</div>
        <p style="font-size:12px;color:#9ca3af;margin:12px 0 0;line-height:1.6;">
          <b>Crashed</b> = source threw an error. <b>Blocked</b> = site rejects cloud IP (needs home proxy).
          <b>Proxy offline</b> = proxy-routed source couldn't reach your laptop. The <b>×N</b> badge counts consecutive failures.
        </p>
      </div>

      ${groupedSections}
    </div>
  </body>
</html>`;
}

function escapeJs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

function escapeBr(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function renderHtml(state: JobSearchState, indeedStatus?: IndeedRunData | null, dashboardJobs?: DashboardJobEntry[], apecStatus?: ApecPlaywrightStatus | null, apecRunStatus?: ApecRunStatus | null): string {
  // Use persistent dashboard jobs if available, fall back to state.latestMatches
  const now = Date.now();
  const displayMatches: Array<{ match: MatchResult; foundAt?: number }> =
    dashboardJobs && dashboardJobs.length > 0
      ? dashboardJobs.map((j) => ({ match: j.match as MatchResult, foundAt: j.foundAt }))
      : state.latestMatches.map((m) => ({ match: m }));

  const rows =
    displayMatches.length > 0
      ? displayMatches
          .map(({ match, foundAt }, idx) => {
            const url = escapeHtml(match.job.canonicalUrl);
            const sc = match.score;
            const isHN = match.job.source === 'news.ycombinator.com';
            const hasEmail = !!(match.hiringEmail);
            const hasCoverLetter = !!(match.coverLetter && match.coverLetter.length > 10);
            const detId = `det-${idx}`;
            const cvHash = hashJobUrl(match.job.canonicalUrl);
            const jobId = cvHash;
            const isAging = foundAt != null && (now - foundAt) > 48 * 60 * 60 * 1000;

            // Table row: compact summary
            const salaryDisplay = match.salaryLabel !== 'salary not listed'
              ? escapeHtml(match.salaryLabel)
              : match.suggestedSalary
                ? `<span style="color:#9ca3af;font-size:12px;">not listed</span><div style="font-size:12px;color:#2563eb;margin-top:2px;">Est. ${escapeHtml(match.suggestedSalary)}</div>`
                : `<span style="color:#9ca3af;font-size:12px;">not listed</span>`;

            const visaBadge = match.visaFriendly === true
              ? `<span style="display:inline-block;margin-top:4px;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:600;background:#d1fae5;color:#065f46;">visa ok</span>`
              : match.visaFriendly === false
                ? `<span style="display:inline-block;margin-top:4px;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:600;background:#fee2e2;color:#991b1b;">no visa</span>`
                : '';

            const hnBadge = isHN
              ? `<span style="display:inline-block;margin-top:3px;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:600;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;">HN</span>`
              : '';

            const emailBadge = hasEmail
              ? `<span style="display:inline-block;margin-top:3px;padding:1px 7px;border-radius:99px;font-size:10px;font-weight:600;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;">email</span>`
              : '';

            const detBtnLabel = hasEmail ? 'Email + Analysis' : 'Full Analysis';

            // Apply button: for HN/email jobs open mail client, else open URL
            const applyBtn = hasEmail
              ? `<button type="button" onclick="openEmail(${idx})" style="display:block;width:100%;text-align:center;padding:6px 12px;background:#1d4ed8;color:white;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">Send Email</button>`
              : `<a href="${escapeHtml(match.job.applyUrl)}" target="_blank" rel="noreferrer" style="display:block;text-align:center;padding:6px 12px;background:#2563eb;color:white;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;">${isHN ? 'View Post' : 'Apply'}</a>`;

            // ─── Details panel ────────────────────────────────────────────────
            const bd = match.scoreBreakdown;
            const bdSection = bd
              ? `<div style="font-size:12px;color:#374151;margin-top:6px;">
                  ${[
                    `Mandatory <b>+${bd.mandatory}</b>`,
                    `Keywords <b>+${bd.keywords}</b>`,
                    `Location <b>+${bd.location}</b>`,
                    bd.startup ? `Startup <b>+${bd.startup}</b>` : '',
                    bd.preference != null && bd.preference !== 0 ? `Preference <b>${bd.preference > 0 ? '+' : ''}${bd.preference}</b>` : '',
                  ].filter(Boolean).join(' &nbsp;·&nbsp; ')}
                </div>`
              : '';

            const reasonsAll = match.reasons.length > 0
              ? `<ul style="margin:6px 0 0;padding:0 0 0 16px;font-size:12px;color:#374151;">${match.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
              : '';

            const relevanceIssuesHtml = (match.relevanceIssues ?? []).length > 0
              ? `<div style="margin-top:4px;font-size:12px;color:#9ca3af;">${(match.relevanceIssues ?? []).map((i) => `• ${escapeHtml(i)}`).join('<br>')}</div>`
              : '';

            const fraudBg = (match.fraudScore ?? 0) >= 60 ? '#fef2f2' : '#f0fdf4';
            const fraudColor = (match.fraudScore ?? 0) >= 60 ? '#b91c1c' : '#15803d';
            const fraudHtml = match.fraudScore != null
              ? `<div style="font-size:12px;margin-top:4px;">Fraud check: <span style="font-weight:700;color:${fraudColor};">${match.fraudScore}/100</span>${(match.fraudReasons ?? []).length ? ` — ${escapeHtml((match.fraudReasons ?? [])[0])}` : ''}</div>`
              : '';

            const companyHtml = match.companyQualityScore != null
              ? `<div style="font-size:12px;margin-top:4px;">Company quality: <span style="font-weight:700;">${match.companyQualityScore}/100</span>${(match.companyRedFlags ?? []).length ? ` — <span style="color:#b45309;">${escapeHtml((match.companyRedFlags ?? []).join(', '))}</span>` : ''}</div>`
              : '';

            const visaNoteHtml = match.visaNote
              ? `<div style="font-size:12px;margin-top:4px;color:#374151;">Visa: ${escapeHtml(match.visaNote)}</div>`
              : '';

            const visaRiskHtml = match.visaRisk
              ? `<div style="margin-top:6px;padding:8px 10px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;font-size:12px;color:#92400e;"><b>Salary risk:</b> ${escapeHtml(match.visaRisk)}</div>`
              : '';

            // Salary guidance section
            const listedSalary = match.salaryLabel !== 'salary not listed'
              ? `<div style="font-size:13px;"><b>Listed:</b> ${escapeHtml(match.salaryLabel)}</div>`
              : `<div style="font-size:13px;color:#6b7280;">Listed: not stated</div>`;

            const estimatedSalary = match.suggestedSalary
              ? `<div style="font-size:13px;margin-top:4px;"><b>AI estimate:</b> ${escapeHtml(match.suggestedSalary)}</div>`
              : '';

            const salaryTarget = `<div style="font-size:12px;margin-top:6px;padding:8px 10px;background:#eff6ff;border-radius:6px;border:1px solid #bfdbfe;">
              <b>Talent permit minimum:</b> €3,299/month (€39,582/yr)<br>
              Negotiate to at least <b>€3,500/month</b> if salary is not listed or below threshold.
            </div>`;

            // ATS keywords section
            const atsKeywords = (match.atsMissingKeywords ?? []);
            const atsSuggestions = (match.atsPlacementSuggestions ?? []);
            const atsSection = atsKeywords.length > 0
              ? `<div>
                  <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Missing from your CV:</div>
                  <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;">
                    ${atsKeywords.map((k) => `<span style="padding:2px 8px;background:#fef3c7;border:1px solid #fde68a;border-radius:99px;font-size:12px;font-weight:600;color:#92400e;">${escapeHtml(k)}</span>`).join('')}
                  </div>
                  ${atsSuggestions.length ? `<ul style="margin:0;padding:0 0 0 16px;font-size:12px;color:#374151;">${atsSuggestions.map((s) => `<li style="margin-bottom:3px;">${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
                </div>`
              : `<div style="font-size:12px;color:#6b7280;">No missing keywords — your CV covers the requirements.</div>`;

            // HN post link — always shown for HN jobs, independent of email
            const hnCommentUrl = isHN
              ? `https://news.ycombinator.com/item?id=${escapeHtml(match.job.commentId ?? '48357725')}`
              : '';
            const hnPostSection = isHN
              ? `<div style="grid-column:1/-1;background:#fff7ed;border-radius:8px;padding:12px 16px;border:1px solid #fed7aa;display:flex;align-items:center;gap:12px;">
                  <span style="font-size:13px;font-weight:700;color:#92400e;">HN Post</span>
                  <a href="${hnCommentUrl}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:5px 14px;font-size:12px;border:1px solid #fed7aa;border-radius:6px;background:white;color:#c2410c;font-weight:600;text-decoration:none;">&#128279; View Post</a>
                  ${match.job.commentId ? '' : '<span style="font-size:11px;color:#b45309;">(comment ID missing — linking to thread)</span>'}
                </div>`
              : '';

            // Email section (any job with a hiring email)
            const emailSection = hasEmail
              ? `<div style="grid-column:1/-1;background:white;border-radius:8px;padding:16px;border:2px solid #2563eb;">
                  <div style="font-size:13px;font-weight:700;color:#1d4ed8;margin-bottom:10px;">Ready-to-send email</div>
                  <div style="font-size:13px;margin-bottom:6px;"><b>To:</b> <a href="mailto:${escapeHtml(match.hiringEmail ?? '')}" style="color:#2563eb;">${escapeHtml(match.hiringEmail ?? '')}</a>
                    <button onclick="copyTxt(${idx},'email')" style="margin-left:8px;padding:2px 8px;font-size:11px;border:1px solid #bfdbfe;border-radius:4px;background:#eff6ff;color:#1d4ed8;cursor:pointer;">Copy</button>
                  </div>
                  <div style="font-size:13px;margin-bottom:6px;"><b>Subject:</b> ${escapeHtml(match.emailSubject ?? `Application: ${match.job.title} — ${match.job.company}`)}
                    <button onclick="copyTxt(${idx},'subject')" style="margin-left:8px;padding:2px 8px;font-size:11px;border:1px solid #bfdbfe;border-radius:4px;background:#eff6ff;color:#1d4ed8;cursor:pointer;">Copy</button>
                  </div>
                  <div style="font-size:12px;font-weight:700;color:#374151;margin:10px 0 4px;">Email body:</div>
                  <div id="eb-${idx}" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:12px;font-size:13px;color:#374151;line-height:1.6;white-space:pre-wrap;">${match.emailBody ? escapeBr(match.emailBody) : '<span style="color:#dc2626;font-style:italic;">Email generation failed. Please try again.</span>'}</div>
                  <div style="margin-top:8px;display:flex;gap:8px;">
                    <button onclick="copyTxt(${idx},'body')" style="padding:5px 14px;font-size:12px;border:1px solid #bfdbfe;border-radius:6px;background:#eff6ff;color:#1d4ed8;cursor:pointer;font-weight:600;">Copy Body</button>
                    <button onclick="openEmail(${idx})" style="padding:5px 14px;font-size:12px;border:0;border-radius:6px;background:#2563eb;color:white;cursor:pointer;font-weight:600;">Open in Mail App</button>
                  </div>
                  <span id="eb-${idx}-email" style="display:none;">${escapeHtml(match.hiringEmail ?? '')}</span>
                  <span id="eb-${idx}-subject" style="display:none;">${escapeHtml(match.emailSubject ?? `Application: ${match.job.title} — ${match.job.company}`)}</span>
                  <span id="eb-${idx}-rawbody" style="display:none;">${escapeHtml(match.emailBody ?? '')}</span>
                </div>`
              : '';

            // Cover letter section
            const coverLetterSection = hasCoverLetter
              ? `<div style="grid-column:1/-1;background:white;border-radius:8px;padding:16px;border:1px solid #e5e7eb;">
                  <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:10px;">Cover Letter</div>
                  <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:6px;padding:14px;font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap;">${escapeBr(match.coverLetter)}</div>
                  <button onclick="copyTxt(${idx},'cl')" style="margin-top:8px;padding:5px 14px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;background:#f3f4f6;color:#374151;cursor:pointer;font-weight:600;">Copy Cover Letter</button>
                  <span id="eb-${idx}-cl" style="display:none;">${escapeHtml(match.coverLetter)}</span>
                </div>`
              : '';

            const detailsRow = `<tr id="${detId}" style="display:none;">
              <td colspan="8" style="padding:0 10px 20px;">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;padding:16px;background:#f8fafc;border-radius:10px;border:1px solid #e5e7eb;">

                  <div style="background:white;border-radius:8px;padding:14px;border:1px solid #e5e7eb;">
                    <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:4px;">Match Score — ${sc}%</div>
                    ${bdSection}
                    ${reasonsAll}
                  </div>

                  <div style="background:white;border-radius:8px;padding:14px;border:1px solid #e5e7eb;">
                    <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:4px;">AI Assessment</div>
                    ${match.relevanceScore != null ? `<div style="font-size:13px;"><b>Relevance:</b> ${match.relevanceScore}/100${relevanceIssuesHtml}</div>` : ''}
                    ${fraudHtml}
                    ${companyHtml}
                    ${visaNoteHtml}
                    ${visaRiskHtml}
                  </div>

                  <div style="background:white;border-radius:8px;padding:14px;border:1px solid #e5e7eb;">
                    <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Salary</div>
                    ${listedSalary}
                    ${estimatedSalary}
                    ${salaryTarget}
                  </div>

                  <div style="background:white;border-radius:8px;padding:14px;border:1px solid #e5e7eb;">
                    <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">CV Keywords (ATS)</div>
                    ${atsSection}
                  </div>

                  ${hnPostSection}
                  ${emailSection}
                  ${coverLetterSection}
                </div>
              </td>
            </tr>`;

            const agingBorder = isAging ? 'border-left:3px solid #f59e0b;' : '';
            const agingTag = isAging ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:99px;font-size:10px;font-weight:600;background:#fef3c7;color:#92400e;">48h+</span>` : '';

            return `
              <tr style="${agingBorder}">
                <td>
                  <div style="font-weight:600;font-size:14px;line-height:1.4;">${escapeHtml(match.job.title)}${agingTag}</div>
                  <div style="font-size:12px;color:#6b7280;margin-top:2px;">${escapeHtml(match.job.source ?? '')}&nbsp;${hnBadge}${emailBadge}</div>
                </td>
                <td style="font-weight:500;">${escapeHtml(match.job.company)}</td>
                <td style="color:#374151;font-size:13px;">${escapeHtml(match.job.locationLabel)}${visaBadge}</td>
                <td>${workModeBadge(match.job.workMode)}</td>
                <td style="font-size:13px;white-space:nowrap;">${salaryDisplay}</td>
                <td>
                  <span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;font-weight:700;color:${scoreColor(sc)};background:${scoreBg(sc)};">${sc}%</span>
                  ${match.relevanceScore != null ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;">AI: ${match.relevanceScore}/100</div>` : ''}
                </td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:6px;min-width:120px;">
                    ${applyBtn}
                    <form method="post" action="/jobs/${jobId}/applied">
                      <input type="hidden" name="title" value="${escapeHtml(match.job.title)}" />
                      <input type="hidden" name="company" value="${escapeHtml(match.job.company)}" />
                      <input type="hidden" name="score" value="${sc}" />
                      <input type="hidden" name="source" value="${escapeHtml(match.job.source ?? '')}" />
                      <button type="submit" style="width:100%;padding:6px 12px;background:#15803d;color:white;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">Applied</button>
                    </form>
                    <form method="post" action="/jobs/${jobId}/dismiss">
                      <button type="submit" style="width:100%;padding:6px 12px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">Dismiss</button>
                    </form>
                    <button type="button" onclick="toggleDet('${detId}')" style="width:100%;padding:6px 12px;background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">${detBtnLabel}</button>
                    <a href="/jobs/tailored-cv?hash=${cvHash}" target="_blank" style="display:block;text-align:center;padding:6px 12px;background:#faf5ff;color:#6d28d9;border:1px solid #ddd6fe;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;">Tailored CV</a>
                    <a href="/jobs/answer-questions?hash=${cvHash}" style="display:block;text-align:center;padding:6px 12px;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;">Answer Questions</a>
                  </div>
                </td>
              </tr>
              ${detailsRow}
            `;
          })
          .join('\n')
      : `<tr><td colspan="7" style="text-align:center;padding:40px;color:#6b7280;">
           No current matches. The bot will check again at the next scheduled run.
         </td></tr>`;

  const statusLabel = state.lastRunStatus === 'running' ? 'Running…'
    : state.lastRunStatus === 'gemini_waiting'
      ? `Waiting for Gemini (retry ${state.geminiRetry?.count ?? '?'}/${state.geminiRetry?.max ?? 12})`
      : state.lastRunStatus;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Job Search: Uman Mushtaq</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin: 0;
        padding: 24px 20px;
        background: #f1f5f9;
        color: #111827;
        min-height: 100vh;
      }
      .page { max-width: 1280px; margin: 0 auto; }
      h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; }
      h2 { margin: 0 0 16px; font-size: 17px; font-weight: 600; color: #111827; }
      .subtitle { color: #6b7280; font-size: 14px; margin: 0 0 20px; }
      .card {
        background: white;
        border-radius: 14px;
        padding: 24px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04);
        margin-bottom: 20px;
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px 20px;
        margin: 16px 0 20px;
      }
      .meta-item label { display:block; font-size:11px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px; }
      .meta-item span { font-size:14px; color:#111827; font-weight:500; }
      .sources-row { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
      .source-chip {
        display:inline-block; padding:3px 9px; border-radius:99px;
        font-size:11px; font-weight:500;
        background:#f0fdf4; color:#15803d; border:1px solid #bbf7d0;
      }
      .blocked-chip {
        background:#fef2f2; color:#b91c1c; border:1px solid #fecaca;
      }
      .actions-row { display:flex; align-items:center; gap:10px; margin-top:20px; flex-wrap:wrap; }
      .btn {
        display:inline-flex; align-items:center; gap:6px;
        padding:9px 18px; border-radius:8px; font-size:14px; font-weight:600;
        border:0; cursor:pointer; text-decoration:none; line-height:1;
      }
      .btn-primary { background:#2563eb; color:white; }
      .btn-primary:hover { background:#1d4ed8; }
      .error-box {
        background:#fef2f2; border:1px solid #fecaca; border-radius:8px;
        padding:12px 16px; font-size:13px; color:#991b1b; margin:16px 0 0;
      }
      table { width:100%; border-collapse:collapse; }
      thead th {
        background:#f8fafc; padding:11px 14px; text-align:left;
        font-size:11px; font-weight:700; color:#6b7280; text-transform:uppercase;
        letter-spacing:.06em; border-bottom:2px solid #e5e7eb; white-space:nowrap;
      }
      tbody tr { transition:background .1s; }
      tbody tr:hover { background:#f8fafc; }
      tbody td { padding:14px 14px; border-bottom:1px solid #f3f4f6; vertical-align:middle; }
      tbody tr:last-child td { border-bottom:0; }
      .table-wrap { overflow-x:auto; border-radius:10px; border:1px solid #e5e7eb; }
      a { color:#2563eb; }
      @media (max-width: 700px) {
        body { padding: 12px; }
        .card { padding: 16px; }
      }
    </style>
  </head>
  <body>
    <div class="page">

      <div class="card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <div>
            <h1>Job Search Bot</h1>
            <p class="subtitle">Uman Mushtaq, Node.js / NestJS Backend Engineer, Paris &nbsp;·&nbsp; <a href="/history" style="color:#2563eb;text-decoration:none;">Application History →</a> &nbsp;·&nbsp; <a href="/jobs/answer-questions" style="color:#2563eb;text-decoration:none;">Answer Questions →</a> &nbsp;·&nbsp; <a href="/platform-status" style="color:#2563eb;text-decoration:none;">Platform Status →</a> &nbsp;·&nbsp; <a href="/admin" style="color:#2563eb;text-decoration:none;">Admin →</a></p>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;padding:8px 14px;border-radius:8px;background:#f8fafc;border:1px solid #e5e7eb;">
            <div style="display:flex;align-items:center;gap:8px;">
              ${statusDot(state.lastRunStatus)}
              <span style="font-size:13px;font-weight:600;color:#374151;">${escapeHtml(statusLabel)}</span>
            </div>
            ${state.lastRunStatus === 'gemini_waiting' && state.geminiRetry
              ? `<span style="font-size:11px;color:#7c3aed;">Next retry: ${state.geminiRetry.nextAt.slice(11, 16)} UTC &nbsp;·&nbsp; will try up to ${state.geminiRetry.max} times</span>`
              : ''}
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-item">
            <label>Last run</label>
            <span class="ts" data-utc="${escapeHtml(state.lastRunAt ?? '')}">${escapeHtml(state.lastRunAt ?? 'n/a')}</span>
          </div>
          <div class="meta-item">
            <label>Last success</label>
            <span class="ts" data-utc="${escapeHtml(state.lastSuccessAt ?? '')}">${escapeHtml(state.lastSuccessAt ?? 'n/a')}</span>
          </div>
          <div class="meta-item">
            <label>Next run</label>
            <span class="ts" data-utc="${escapeHtml(state.nextRunAt ?? '')}">${escapeHtml(state.nextRunAt ?? 'n/a')}</span>
          </div>
          <div class="meta-item">
            <label>Interval</label>
            <span>${state.intervalMinutes} min</span>
          </div>
          <div class="meta-item">
            <label>Current matches</label>
            <span style="font-size:18px;font-weight:700;color:#2563eb;">${state.stats.matchCount}</span>
          </div>
          <div class="meta-item">
            <label>Fresh jobs scanned</label>
            <span>${state.stats.freshJobsCount ?? 'n/a'}</span>
          </div>
        </div>

        ${state.lastError ? `<div class="error-box"><strong>Last error:</strong> ${escapeHtml(state.lastError)}</div>` : ''}

        ${state.lastRunDiagnostic ? renderDiagnosticHtml(state.lastRunDiagnostic) : ''}

        <div style="margin-top:16px;">
          <div style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">
            Active sources (${state.activeSources.filter((s) => s !== 'indeed.com').length})
          </div>
          <div class="sources-row">
            ${state.activeSources.filter((s) => s !== 'indeed.com').map((s) => `<span class="source-chip">${escapeHtml(s)}</span>`).join('')}
          </div>
          ${state.blockedSources.length ? `
          <div style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 8px;">
            No public API
          </div>
          <div class="sources-row">
            ${state.blockedSources.map((s) => `<span class="source-chip blocked-chip">${escapeHtml(s)}</span>`).join('')}
          </div>` : ''}

          <div style="margin-top:14px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
            <div style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">
              Indeed (separate timer)${indeedStatus?.via === 'scraperapi' ? ' <span style="font-size:11px;font-weight:600;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:4px;padding:1px 6px;vertical-align:middle;text-transform:none;letter-spacing:0;">via ScraperAPI proxy</span>' : indeedStatus?.via === 'direct' ? ' <span style="font-size:11px;font-weight:600;background:#fef9c3;color:#854d0e;border:1px solid #fde68a;border-radius:4px;padding:1px 6px;vertical-align:middle;text-transform:none;letter-spacing:0;">direct (no proxy)</span>' : ''}
            </div>
            <table style="font-size:13px;color:#374151;border-collapse:collapse;width:100%;">
              <tr>
                <td style="padding:3px 0;color:#6b7280;width:160px;">Last run</td>
                <td style="padding:3px 0;">${indeedStatus ? escapeHtml(new Date(indeedStatus.timestamp).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })) : 'never'}</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Next run</td>
                <td style="padding:3px 0;">${indeedStatus ? escapeHtml(new Date(indeedStatus.nextRunAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })) : 'pending first run'}</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Timer</td>
                <td style="padding:3px 0;">24 hours</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Jobs found (last run)</td>
                <td style="padding:3px 0;">${indeedStatus ? String(indeedStatus.jobsFound) : '—'}</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Status</td>
                <td style="padding:3px 0;">${indeedStatus
                  ? `<span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;${
                      indeedStatus.status === 'success' ? 'background:#dcfce7;color:#166534;'
                      : indeedStatus.status === 'failed' ? 'background:#fee2e2;color:#991b1b;'
                      : 'background:#fef9c3;color:#854d0e;'
                    }">${escapeHtml(indeedStatus.status)}</span>`
                  : '<span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#fef9c3;color:#854d0e;">pending</span>'
                }</td>
              </tr>
            </table>
          </div>
        </div>

          <!-- APEC status panel -->
          <div style="margin-top:14px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
            <div style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px;">
              APEC (separate timer)${apecRunStatus?.playwrightEnabled ? ' <span style="font-size:11px;font-weight:600;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:4px;padding:1px 6px;vertical-align:middle;text-transform:none;letter-spacing:0;">Playwright stealth</span>' : ' <span style="font-size:11px;font-weight:600;background:#fef9c3;color:#854d0e;border:1px solid #fde68a;border-radius:4px;padding:1px 6px;vertical-align:middle;text-transform:none;letter-spacing:0;">RSS / API fallback</span>'}
            </div>
            <table style="font-size:13px;color:#374151;border-collapse:collapse;width:100%;">
              <tr>
                <td style="padding:3px 0;color:#6b7280;width:160px;">Last run</td>
                <td style="padding:3px 0;">${apecRunStatus ? escapeHtml(new Date(apecRunStatus.lastRun).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })) : 'never'}</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Next run</td>
                <td style="padding:3px 0;">${apecRunStatus ? escapeHtml(new Date(apecRunStatus.nextRun).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })) : 'pending first run'}</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Timer</td>
                <td style="padding:3px 0;">6 hours</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Jobs found (last run)</td>
                <td style="padding:3px 0;">${apecRunStatus ? String(apecRunStatus.jobsFound) : '—'}</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Playwright</td>
                <td style="padding:3px 0;">${apecRunStatus
                  ? apecRunStatus.playwrightEnabled
                    ? '<span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#eff6ff;color:#1d4ed8;">enabled</span>'
                    : '<span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#fef9c3;color:#854d0e;">disabled</span>'
                  : '—'
                }</td>
              </tr>
              <tr>
                <td style="padding:3px 0;color:#6b7280;">Status</td>
                <td style="padding:3px 0;">${apecRunStatus
                  ? `<span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;${
                      apecRunStatus.status === 'success' ? 'background:#dcfce7;color:#166534;'
                      : apecRunStatus.status === 'blocked' ? 'background:#fee2e2;color:#991b1b;'
                      : 'background:#f1f5f9;color:#64748b;'
                    }">${escapeHtml(apecRunStatus.status)}</span>`
                  : '<span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#f1f5f9;color:#64748b;">never run</span>'
                }</td>
              </tr>
            </table>
          </div>

        <div class="actions-row" style="display:flex;gap:10px;flex-wrap:wrap;">
          <form method="post" action="/run-now">
            <button class="btn btn-primary" type="submit">▶ Run all sources</button>
          </form>
          <form method="post" action="/run/apec">
            <button type="submit" style="padding:8px 18px;font-size:14px;font-weight:600;background:#0e7490;color:white;border:none;border-radius:8px;cursor:pointer;">▶ Run APEC</button>
          </form>
          <form method="post" action="/run/indeed">
            <button type="submit" style="padding:8px 18px;font-size:14px;font-weight:600;background:#0e7490;color:white;border:none;border-radius:8px;cursor:pointer;">▶ Run Indeed</button>
          </form>
        </div>
      </div>

      <div class="card" id="health-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
          <h2 style="margin:0;">System status</h2>
          <button onclick="loadHealth()" id="health-refresh-btn"
            style="padding:6px 14px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;color:#374151;">
            Refresh
          </button>
        </div>
        <div id="health-status" style="color:#9ca3af;font-size:13px;">Loading…</div>
      </div>

      <div class="card" id="gemini-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
          <h2 style="margin:0;">Gemini API keys</h2>
          <div style="display:flex;gap:8px;">
            <button onclick="loadKeyStatus(false)" id="key-refresh-btn"
              style="padding:6px 14px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;color:#374151;">
              Refresh
            </button>
            <button onclick="loadKeyStatus(true)" id="key-live-btn"
              title="Makes one real Gemini API call per key to verify status"
              style="padding:6px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;color:#2563eb;">
              Test live
            </button>
          </div>
        </div>
        <div id="key-status" style="color:#9ca3af;font-size:13px;">Loading key status…</div>
      </div>

      <div class="card" id="matches-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;gap:8px;">
            <button id="tab-matches-btn" onclick="switchDashTab('matches')"
              style="padding:8px 18px;border-radius:8px;font-size:14px;font-weight:600;border:0;cursor:pointer;background:#2563eb;color:white;">
              Matches <span id="tab-matches-count" style="font-weight:400;opacity:0.8;">(${displayMatches.length})</span>
            </button>
            <button id="tab-applied-btn" onclick="switchDashTab('applied')"
              style="padding:8px 18px;border-radius:8px;font-size:14px;font-weight:600;border:0;cursor:pointer;background:#f3f4f6;color:#374151;">
              Applied <span id="tab-applied-count" style="font-weight:400;opacity:0.8;"></span>
            </button>
          </div>
        </div>

        <div id="tab-matches-panel">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Company</th>
                  <th>Location</th>
                  <th>Mode</th>
                  <th>Salary</th>
                  <th>Score</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        </div>

        <div id="tab-applied-panel" style="display:none;">
          <div id="applied-loading" style="color:#9ca3af;font-size:13px;padding:20px 0;">Loading…</div>
          <div id="applied-table-wrap" class="table-wrap" style="display:none;">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Company</th>
                  <th>Location</th>
                  <th>Score</th>
                  <th>Applied date</th>
                  <th>Days since</th>
                  <th>Follow-up</th>
                </tr>
              </thead>
              <tbody id="applied-tbody"></tbody>
            </table>
          </div>
          <div id="applied-empty" style="display:none;text-align:center;padding:40px;color:#6b7280;">
            No applied jobs in the last 10 days.
          </div>
        </div>
      </div>

    </div>
    <script>
      document.querySelectorAll('.ts[data-utc]').forEach(function(el) {
        var utc = el.getAttribute('data-utc');
        if (!utc) return;
        var d = new Date(utc);
        if (isNaN(d.getTime())) return;
        el.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      });

      var STATUS_STYLE = {
        ok:               { dot: '#16a34a', label: 'Working',           bg: '#f0fdf4', text: '#15803d' },
        quota_exhausted:  { dot: '#d97706', label: 'Quota exhausted',   bg: '#fffbeb', text: '#b45309' },
        untested:         { dot: '#9ca3af', label: 'Not tested yet',    bg: '#f9fafb', text: '#6b7280' },
        // live-test statuses (from /debug/keys)
        invalid_key:      { dot: '#dc2626', label: 'Invalid key',       bg: '#fef2f2', text: '#b91c1c' },
        invalid_format:   { dot: '#dc2626', label: 'Wrong format',      bg: '#fef2f2', text: '#b91c1c' },
        permission_denied:{ dot: '#7c3aed', label: 'API not enabled',   bg: '#f5f3ff', text: '#5b21b6' },
        unknown:          { dot: '#9ca3af', label: 'Unknown',           bg: '#f9fafb', text: '#6b7280' },
      };

      function dot(color) {
        return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + color + ';margin-right:6px;vertical-align:middle;flex-shrink:0;"></span>';
      }

      function renderLiteStatus(data) {
        if (data.error) {
          return '<span style="color:#b91c1c;">' + data.error + '</span>';
        }

        var keys = data.keys || [];
        var working = data.working || 0;
        var total = data.totalKeys || 0;
        var exhausted = data.quotaExhausted || 0;
        var untested = data.untested || 0;
        var redisCalls = data.redisDailyCallCount || 0;
        var memCalls = data.dailyCallCount || 0;
        var callDay = data.dailyCallPacificDay || '';

        var summaryColor = working > 0 ? '#15803d' : exhausted === total ? '#b91c1c' : '#b45309';
        var summaryText = working + '/' + total + ' keys working';
        if (exhausted > 0) summaryText += ' · ' + exhausted + ' quota-exhausted';
        if (untested > 0) summaryText += ' · ' + untested + ' not tested this session';

        var html = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap;">';
        html += '<span style="font-weight:600;font-size:14px;color:' + summaryColor + ';">' + summaryText + '</span>';
        html += '</div>';

        // Daily call counter
        var callsLabel = redisCalls > 0 ? redisCalls : memCalls;
        var callsNote = redisCalls > 0 ? 'Redis-persisted' : 'in-memory since last restart';
        var callsColor = callsLabel > 1200 ? '#b91c1c' : callsLabel > 800 ? '#b45309' : '#374151';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;background:#f0f9ff;border:1px solid #bae6fd;margin-bottom:12px;font-size:13px;">';
        html += '<span style="font-weight:600;color:#0369a1;">API calls today</span>';
        html += '<span style="font-weight:700;font-size:15px;color:' + callsColor + ';">' + callsLabel + '</span>';
        html += '<span style="color:#6b7280;font-size:12px;">/ 1,500 per account (' + callsNote + (callDay ? ', Pacific day ' + callDay : '') + ')</span>';
        html += '</div>';

        if (data.allKeysDown) {
          html += '<div style="padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px;color:#b45309;margin-bottom:12px;">';
          html += '<strong>All keys quota-exhausted.</strong> Bot is paused. Quota resets at midnight Pacific time';
          if (data.allKeysDownPacificDay) html += ' (went down on Pacific day ' + data.allKeysDownPacificDay + ')';
          html += '. No action needed — will resume automatically.';
          html += '</div>';
        }

        html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">';
        keys.forEach(function(k) {
          var s = STATUS_STYLE[k.status] || STATUS_STYLE.unknown;
          html += '<div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:' + s.bg + ';border-radius:8px;font-size:13px;flex-wrap:wrap;">';
          html += '<span style="display:flex;align-items:center;min-width:160px;font-weight:500;color:#374151;">' + dot(s.dot) + k.source + '</span>';
          html += '<code style="color:#6b7280;font-size:12px;">' + k.keyPreview + '</code>';
          html += '<span style="margin-left:auto;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600;color:' + s.text + ';background:white;border:1px solid ' + s.dot + '40;">' + s.label + '</span>';
          html += '</div>';
        });
        html += '</div>';

        html += '<div style="font-size:12px;color:#9ca3af;margin-bottom:10px;">Status comes from the bot own enrichment runs. "Not tested yet" means the bot has not needed that key this session.</div>';

        return html;
      }

      function renderLiveStatus(data) {
        if (data.error) {
          return '<span style="color:#b91c1c;">' + data.error + '</span>';
        }

        var keys = data.keys || [];
        var working = data.working || 0;
        var total = data.totalKeys || 0;
        var exhausted = data.quotaExhausted || 0;
        var invalid = data.invalid || 0;

        var summaryColor = working === total ? '#15803d' : working > 0 ? '#b45309' : '#b91c1c';
        var summaryText = 'Live test: ' + working + '/' + total + ' keys working';
        if (exhausted > 0) summaryText += ' · ' + exhausted + ' quota-exhausted';
        if (invalid > 0) summaryText += ' · ' + invalid + ' invalid';

        var testedAt = data.testedAt ? new Date(data.testedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

        var html = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">';
        html += '<span style="font-weight:600;font-size:14px;color:' + summaryColor + ';">' + summaryText + '</span>';
        if (testedAt) html += '<span style="font-size:12px;color:#9ca3af;">Tested ' + testedAt + '</span>';
        html += '</div>';

        html += '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">';
        keys.forEach(function(k) {
          var s = STATUS_STYLE[k.status] || STATUS_STYLE.unknown;
          html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:' + s.bg + ';border-radius:8px;font-size:13px;flex-wrap:wrap;">';
          html += '<span style="display:flex;align-items:center;min-width:150px;font-weight:500;color:#374151;">' + dot(s.dot) + k.source + '</span>';
          html += '<code style="color:#6b7280;font-size:12px;">' + k.key + '</code>';
          html += '<span style="margin-left:auto;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600;color:' + s.text + ';background:white;border:1px solid ' + s.dot + '40;">' + s.label + (k.model ? ' · ' + k.model : '') + '</span>';
          if (k.error) html += '<span style="width:100%;font-size:12px;color:' + s.text + ';padding-left:22px;">' + k.error + '</span>';
          if (k.rawError) html += '<code style="width:100%;font-size:11px;color:#6b7280;padding-left:22px;word-break:break-all;">Raw: ' + k.rawError + '</code>';
          html += '</div>';
        });
        html += '</div>';

        var advice = data.advice || [];
        if (advice.length) {
          html += '<div style="background:#f8fafc;border-radius:8px;padding:12px 14px;font-size:13px;color:#374151;line-height:1.6;">';
          advice.forEach(function(line) {
            html += '<p style="margin:0 0 6px;">' + line + '</p>';
          });
          html += '</div>';
        }

        return html;
      }

      function loadKeyStatus(live) {
        var el = document.getElementById('key-status');
        var btn = document.getElementById('key-refresh-btn');
        var liveBtn = document.getElementById('key-live-btn');
        if (live) {
          el.textContent = 'Testing all keys live (1 real API call per key)…';
          if (liveBtn) liveBtn.disabled = true;
          fetch('/debug/keys?force=true')
            .then(function(r) { return r.json(); })
            .then(function(data) { el.innerHTML = renderLiveStatus(data); })
            .catch(function() { el.textContent = 'Could not reach /debug/keys.'; })
            .finally(function() { if (liveBtn) liveBtn.disabled = false; });
        } else {
          el.textContent = 'Loading key status…';
          if (btn) btn.disabled = true;
          fetch('/api/gemini-status')
            .then(function(r) { return r.json(); })
            .then(function(data) { el.innerHTML = renderLiteStatus(data); })
            .catch(function() { el.textContent = 'Could not load key status.'; })
            .finally(function() { if (btn) btn.disabled = false; });
        }
      }

      loadKeyStatus(false);

      function toggleDet(id) {
        var row = document.getElementById(id);
        if (!row) return;
        row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
      }

      function copyTxt(idx, part) {
        var el;
        if (part === 'body') el = document.getElementById('eb-' + idx + '-rawbody');
        else if (part === 'subject') el = document.getElementById('eb-' + idx + '-subject');
        else if (part === 'email') el = document.getElementById('eb-' + idx + '-email');
        else if (part === 'cl') el = document.getElementById('eb-' + idx + '-cl');
        if (!el) return;
        var txt = el.textContent || '';
        navigator.clipboard.writeText(txt).catch(function() {
          var ta = document.createElement('textarea');
          ta.value = txt;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
      }

      function openEmail(idx) {
        var eEl = document.getElementById('eb-' + idx + '-email');
        var sEl = document.getElementById('eb-' + idx + '-subject');
        var bEl = document.getElementById('eb-' + idx + '-rawbody');
        if (!eEl) return;
        var email = eEl.textContent || '';
        var subject = encodeURIComponent(sEl ? (sEl.textContent || '') : '');
        var body = encodeURIComponent(bEl ? (bEl.textContent || '') : '');
        window.location.href = 'mailto:' + email + '?subject=' + subject + '&body=' + body;
      }

      function fmtDate(iso) {
        if (!iso) return 'n/a';
        var d = new Date(iso);
        return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      }

      function systemDot(ok) {
        return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (ok ? '#16a34a' : '#dc2626') + ';margin-right:5px;vertical-align:middle;"></span>';
      }

      function renderHealth(data) {
        if (data.error) return '<span style="color:#b91c1c;">' + data.error + '</span>';

        var statusColors = { success: '#15803d', error: '#b91c1c', running: '#d97706', idle: '#6b7280' };
        var statusBgs    = { success: '#f0fdf4', error: '#fef2f2', running: '#fffbeb', idle: '#f9fafb' };
        var sc = statusColors[data.status] || '#6b7280';
        var sb = statusBgs[data.status]   || '#f9fafb';
        var redisOk = data.redis === 'connected';
        var tgOk    = data.telegram === 'configured';
        var schOk   = data.scheduler === 'enabled';

        var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px 20px;margin-bottom:14px;">';

        html += '<div><div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Bot status</div>';
        html += '<span style="padding:3px 10px;border-radius:99px;font-size:13px;font-weight:700;color:' + sc + ';background:' + sb + ';">' + (data.status || 'unknown') + '</span></div>';

        html += '<div><div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Last run</div>';
        html += '<span style="font-size:13px;font-weight:500;">' + fmtDate(data.lastRunAt) + '</span></div>';

        html += '<div><div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Last success</div>';
        html += '<span style="font-size:13px;font-weight:500;">' + fmtDate(data.lastSuccessAt) + '</span></div>';

        html += '<div><div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Next run</div>';
        html += '<span style="font-size:13px;font-weight:500;">' + fmtDate(data.nextRunAt) + '</span></div>';

        html += '<div><div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Matches</div>';
        html += '<span style="font-size:18px;font-weight:700;color:#2563eb;">' + (data.matches || 0) + '</span></div>';

        html += '<div><div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;">Fresh scanned</div>';
        html += '<span style="font-size:13px;font-weight:500;">' + (data.freshScanned ?? 'n/a') + '</span></div>';

        html += '</div>';

        html += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;padding:10px 14px;background:#f8fafc;border-radius:8px;border:1px solid #e5e7eb;margin-bottom:10px;">';
        html += '<span>' + systemDot(redisOk) + 'Redis: <strong>' + (data.redis || 'unknown') + '</strong></span>';
        html += '<span>' + systemDot(tgOk)    + 'Telegram: <strong>' + (data.telegram || 'unknown') + '</strong></span>';
        html += '<span>' + systemDot(schOk)   + 'Scheduler: <strong>' + (data.scheduler || 'unknown') + '</strong></span>';
        html += '<span style="margin-left:auto;color:#9ca3af;font-size:12px;">Interval: ' + (data.intervalMinutes || '?') + ' min</span>';
        html += '</div>';

        var uc = data.urlCounts || {};
        html += '<div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:#6b7280;padding:8px 14px;background:#f8fafc;border-radius:8px;border:1px solid #e5e7eb;">';
        html += '<span>Seen URLs: <strong style="color:#374151;">' + (uc.seen || 0) + '</strong></span>';
        html += '<span>Sent to Telegram: <strong style="color:#374151;">' + (uc.sent || 0) + '</strong></span>';
        html += '<span>Applied: <strong style="color:#15803d;">' + (uc.applied || 0) + '</strong></span>';
        html += '<span>Dismissed: <strong style="color:#6b7280;">' + (uc.dismissed || 0) + '</strong></span>';
        html += '</div>';

        if (data.error) {
          html += '<div style="margin-top:10px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#991b1b;"><strong>Error:</strong> ' + data.error + '</div>';
        }

        return html;
      }

      function loadHealth() {
        var el = document.getElementById('health-status');
        var btn = document.getElementById('health-refresh-btn');
        if (btn) btn.disabled = true;
        fetch('/health')
          .then(function(r) { return r.json(); })
          .then(function(data) { el.innerHTML = renderHealth(data); })
          .catch(function() { el.textContent = 'Could not load health status.'; })
          .finally(function() { if (btn) btn.disabled = false; });
      }

      loadHealth();
      setInterval(loadHealth, 300000); // 5 min — /health is cached 60s server-side; polling faster wastes Redis calls

      // ── Applied jobs tab ────────────────────────────────────────────
      var _appliedLoaded = false;

      function switchDashTab(tab) {
        var isMatches = tab === 'matches';
        document.getElementById('tab-matches-panel').style.display = isMatches ? '' : 'none';
        document.getElementById('tab-applied-panel').style.display = isMatches ? 'none' : '';
        document.getElementById('tab-matches-btn').style.cssText = 'padding:8px 18px;border-radius:8px;font-size:14px;font-weight:600;border:0;cursor:pointer;background:' + (isMatches ? '#2563eb;color:white' : '#f3f4f6;color:#374151') + ';';
        document.getElementById('tab-applied-btn').style.cssText  = 'padding:8px 18px;border-radius:8px;font-size:14px;font-weight:600;border:0;cursor:pointer;background:' + (isMatches ? '#f3f4f6;color:#374151' : '#15803d;color:white') + ';';
        if (!isMatches && !_appliedLoaded) loadAppliedJobs();
      }

      function workModeBadge(mode) {
        if (mode === 'remote')  return '<span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:#d1fae5;color:#065f46;">remote</span>';
        if (mode === 'hybrid')  return '<span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:#fef3c7;color:#92400e;">hybrid</span>';
        return '<span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:#f3f4f6;color:#374151;">on-site</span>';
      }

      function daysBadge(days) {
        if (days > 10) return '<span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;background:#fee2e2;color:#991b1b;">Overdue</span>';
        if (days > 7)  return '<span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;background:#fef3c7;color:#92400e;">Follow up</span>';
        return '<span style="padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:#f3f4f6;color:#6b7280;">Waiting</span>';
      }

      function loadAppliedJobs() {
        _appliedLoaded = true;
        var loading = document.getElementById('applied-loading');
        var tableWrap = document.getElementById('applied-table-wrap');
        var empty = document.getElementById('applied-empty');
        var tbody = document.getElementById('applied-tbody');
        if (loading) loading.style.display = '';
        if (tableWrap) tableWrap.style.display = 'none';
        if (empty) empty.style.display = 'none';

        fetch('/api/applied')
          .then(function(r) { return r.json(); })
          .then(function(jobs) {
            if (loading) loading.style.display = 'none';
            var countEl = document.getElementById('tab-applied-count');
            if (countEl) countEl.textContent = '(' + jobs.length + ')';
            if (!jobs.length) { if (empty) empty.style.display = ''; return; }
            var now = Date.now();
            var html = '';
            jobs.forEach(function(j) {
              var days = Math.floor((now - j.appliedAt) / 86400000);
              var appliedDate = new Date(j.appliedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              html += '<tr>' +
                '<td style="font-weight:600;font-size:14px;">' + escHtml(j.title) + '</td>' +
                '<td>' + escHtml(j.company) + '</td>' +
                '<td style="font-size:13px;color:#374151;">' + escHtml(j.locationLabel || '') + (j.countryCode ? ' (' + escHtml(j.countryCode) + ')' : '') + '</td>' +
                '<td><span style="padding:3px 10px;border-radius:99px;font-size:13px;font-weight:700;background:#eff6ff;color:#1d4ed8;">' + j.score + '%</span></td>' +
                '<td style="font-size:13px;white-space:nowrap;">' + appliedDate + '</td>' +
                '<td style="font-size:13px;">' + days + ' day' + (days === 1 ? '' : 's') + '</td>' +
                '<td>' + daysBadge(days) + '</td>' +
                '</tr>';
            });
            if (tbody) tbody.innerHTML = html;
            if (tableWrap) tableWrap.style.display = '';
          })
          .catch(function() {
            if (loading) loading.textContent = 'Could not load applied jobs.';
          });
      }

      function escHtml(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
    </script>
  </body>
</html>`;
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function signAdminToken(ts: number): string {
  const secret = process.env.ADMIN_PASSWORD ?? '';
  const payload = String(ts);
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token: string): boolean {
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const tsStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > 24 * 60 * 60 * 1000) return false;
  const secret = process.env.ADMIN_PASSWORD ?? '';
  const expected = createHmac('sha256', secret).update(tsStr).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function isAdminAuthenticated(cookieHeader: string | undefined): boolean {
  const cookies = parseCookies(cookieHeader);
  const token = cookies['admin_session'];
  if (!token) return false;
  if (!process.env.ADMIN_PASSWORD) return false;
  return verifyAdminToken(token);
}

function renderAdminLoginHtml(badPassword: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Login</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .card{background:white;border-radius:16px;padding:36px 40px;box-shadow:0 4px 20px rgba(0,0,0,.08);width:100%;max-width:380px;}
    h1{margin:0 0 8px;font-size:22px;color:#111827;}
    p.sub{margin:0 0 28px;font-size:14px;color:#6b7280;}
    label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;}
    input[type=password]{width:100%;padding:10px 14px;border:1.5px solid #d1d5db;border-radius:8px;font-size:15px;outline:none;transition:border-color .15s;}
    input[type=password]:focus{border-color:#2563eb;}
    .err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:18px;}
    button.signin{width:100%;padding:11px;background:#2563eb;color:white;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:18px;transition:background .15s;}
    button.signin:hover{background:#1d4ed8;}
    .divider{display:flex;align-items:center;gap:10px;margin:22px 0 16px;color:#9ca3af;font-size:12px;}
    .divider::before,.divider::after{content:'';flex:1;height:1px;background:#e5e7eb;}
    button.recover{width:100%;padding:10px;background:transparent;color:#374151;border:1.5px solid #d1d5db;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:all .15s;}
    button.recover:hover{background:#f9fafb;border-color:#9ca3af;}
    .recover-note{text-align:center;margin-top:10px;font-size:12px;color:#9ca3af;line-height:1.5;}
    .back{text-align:center;margin-top:18px;font-size:13px;color:#6b7280;}
    .back a{color:#2563eb;text-decoration:none;}
  </style>
</head>
<body>
  <div class="card">
    <h1>Admin Login</h1>
    <p class="sub">Enter your admin password to manage your work permit details.</p>
    ${badPassword ? '<div class="err">Incorrect password. Please try again.</div>' : ''}
    <form method="POST" action="/admin/login">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password" placeholder="Admin password">
      <button type="submit" class="signin">Sign in</button>
    </form>

    <div class="divider">forgot it?</div>
    <form method="POST" action="/admin/recover">
      <button type="submit" class="recover">Recover password via Telegram</button>
    </form>
    <p class="recover-note">Your password will be sent to your Telegram chat.<br>Recovery contact on file: ${escapeHtml(RECOVERY_EMAIL)}</p>

    <div class="back"><a href="/">← Back to Dashboard</a></div>
  </div>
</body>
</html>`;
}

function renderAdminRecoverResultHtml(kind: 'ok' | 'error', message: string): string {
  const isOk = kind === 'ok';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Password Recovery</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
    .card{background:white;border-radius:16px;padding:36px 40px;box-shadow:0 4px 20px rgba(0,0,0,.08);width:100%;max-width:400px;text-align:center;}
    .icon{font-size:40px;margin-bottom:12px;}
    h1{margin:0 0 10px;font-size:20px;color:#111827;}
    p{margin:0 0 24px;font-size:14px;color:#4b5563;line-height:1.6;}
    a.btn{display:inline-block;padding:10px 24px;background:#2563eb;color:white;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;transition:background .15s;}
    a.btn:hover{background:#1d4ed8;}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isOk ? '✅' : '⚠️'}</div>
    <h1>${isOk ? 'Recovery sent' : 'Could not send'}</h1>
    <p>${escapeHtml(message)}</p>
    <a class="btn" href="/admin">Back to login</a>
  </div>
</body>
</html>`;
}

function renderAdminSettingsHtml(currentPermitName: string, currentExpiry: string, flash?: string): string {
  const updated = flash === undefined ? false : !flash?.startsWith('error:');
  const errorMsg = flash?.startsWith('error:') ? flash.slice(6) : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin — Update Work Permit</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;margin:0;padding:40px 20px;}
    .wrap{max-width:540px;margin:0 auto;}
    .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;}
    .header h1{margin:0;font-size:22px;color:#111827;}
    .header a{font-size:13px;color:#6b7280;text-decoration:none;}
    .header a:hover{color:#111827;}
    .card{background:white;border-radius:16px;padding:32px 36px;box-shadow:0 4px 20px rgba(0,0,0,.07);}
    .card h2{margin:0 0 6px;font-size:17px;color:#111827;}
    .card p.desc{margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.5;}
    label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;}
    input[type=text]{width:100%;padding:10px 14px;border:1.5px solid #d1d5db;border-radius:8px;font-size:15px;outline:none;transition:border-color .15s;margin-bottom:20px;}
    input[type=text]:focus{border-color:#2563eb;}
    .hint{font-size:12px;color:#9ca3af;margin-top:-16px;margin-bottom:20px;}
    .success{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;font-size:14px;margin-bottom:22px;display:flex;align-items:center;gap:8px;}
    .error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;font-size:14px;margin-bottom:22px;}
    .actions{display:flex;gap:12px;align-items:center;margin-top:4px;}
    button.save{padding:11px 28px;background:#2563eb;color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;}
    button.save:hover{background:#1d4ed8;}
    button.logout{padding:11px 20px;background:transparent;color:#6b7280;border:1.5px solid #d1d5db;border-radius:8px;font-size:14px;cursor:pointer;transition:all .15s;}
    button.logout:hover{background:#f9fafb;color:#374151;}
    .preview{margin-top:28px;padding:16px 18px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;}
    .preview h3{margin:0 0 10px;font-size:13px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;}
    .preview p{margin:0;font-size:13px;color:#374151;line-height:1.6;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>Work Permit Settings</h1>
      <a href="/">← Dashboard</a>
    </div>
    <div class="card">
      <h2>Update your permit details</h2>
      <p class="desc">Changes apply immediately — the next cover letter, email, and Gemini query will use the new values automatically.</p>

      ${updated ? '<div class="success"><span>&#10003;</span> Permit details updated successfully.</div>' : ''}
      ${errorMsg ? `<div class="error">${escapeHtml(errorMsg)}</div>` : ''}

      <form method="POST" action="/admin/update-permit">
        <label for="permitName">Permit / card name</label>
        <input type="text" id="permitName" name="permitName" value="${escapeHtml(currentPermitName)}" placeholder="e.g. RECE permit, EU Blue Card, Talent permit" autofocus>
        <p class="hint">Exactly as it appears on your card — used in cover letters and Gemini prompts.</p>

        <label for="expiry">Expiry date</label>
        <input type="text" id="expiry" name="expiry" value="${escapeHtml(currentExpiry)}" placeholder="e.g. October 2026">
        <p class="hint">Free text — used verbatim in &ldquo;valid to &hellip;&rdquo; sentences.</p>

        <div class="preview" id="preview-box">
          <h3>Preview</h3>
          <p id="preview-text">Authorized to work in France. ${escapeHtml(currentPermitName)} valid to ${escapeHtml(currentExpiry)}, standard changement de statut on contract signing.</p>
        </div>

        <div class="actions" style="margin-top:24px;">
          <button type="submit" class="save">Save changes</button>
          <form method="POST" action="/admin/logout" style="margin:0;">
            <button type="submit" class="logout">Log out</button>
          </form>
        </div>
      </form>
    </div>
  </div>
  <script>
    var pn = document.getElementById('permitName');
    var ex = document.getElementById('expiry');
    var pt = document.getElementById('preview-text');
    function updatePreview() {
      var name = pn.value.trim() || 'your permit';
      var exp  = ex.value.trim() || 'unknown date';
      pt.textContent = 'Authorized to work in France. ' + name + ' valid to ' + exp + ', standard changement de statut on contract signing.';
    }
    pn.addEventListener('input', updatePreview);
    ex.addEventListener('input', updatePreview);
  </script>
</body>
</html>`;
}
