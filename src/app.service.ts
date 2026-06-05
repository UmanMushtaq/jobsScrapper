import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { enrichMatch, getGeminiModuleState, lastGeminiError } from './job-search/ai-enrichment';
import { loadSearchProfile } from './job-search/profile';
import {
  JobDecisionMeta,
  markJobDecision,
  readJobSearchState,
  runJobSearchOnce,
} from './job-search/run';
import {
  answerCallbackQuery,
  editTelegramMessage,
  registerWebhook,
  resolveJobRef,
} from './job-search/telegram';
import { JobHistoryEntry, isRedisAvailable, redisCountUrlSets, redisGetGeminiDailyCalls, redisGetJobHistory } from './job-search/redis-store';
import { JobSearchState } from './job-search/types';

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

    const decision = action === 'a' ? 'applied' : 'dismissed';
    await markJobDecision(decision, url);

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

  async getHealth(): Promise<Record<string, unknown>> {
    const [state, urlCounts] = await Promise.all([readJobSearchState(), redisCountUrlSets()]);
    return {
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
    };
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

    const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
    const MINI_PROMPT = 'Reply with the single word: OK';
    const results: Array<Record<string, unknown>> = [];

    for (const { key, source } of rawKeys) {
      const keyPreview = `${key.slice(0, 8)}...${key.slice(-4)}`;

      let status = 'unknown';
      let model = '';
      let error = '';

      for (const m of MODELS) {
        try {
          const ai = new GoogleGenAI({ apiKey: key });
          await ai.models.generateContent({ model: m, contents: MINI_PROMPT });
          status = 'ok';
          model = m;
          break;
        } catch (err) {
          const msg = String(err instanceof Error ? err.message : err).toLowerCase();
          if (msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('429')) {
            status = 'quota_exhausted';
            error = 'Daily quota used up';
            break;
          } else if (msg.includes('api_key_invalid') || msg.includes('invalid api key') || msg.includes('401')) {
            status = 'invalid_key';
            error = 'Key is invalid or revoked. Delete it from env vars.';
            break;
          } else if (msg.includes('403')) {
            status = 'permission_denied';
            error = 'Gemini API not enabled for this project. Enable it at console.cloud.google.com.';
            break;
          } else {
            error = msg.slice(0, 120);
          }
        }
      }

      results.push({ source, key: keyPreview, status, model: model || null, error: error || null });
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
    const state = await readJobSearchState();
    return renderHtml(state);
  }

  async getHistoryPage(): Promise<string> {
    const entries = await redisGetJobHistory();
    return renderHistoryHtml(entries);
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
}

function shouldEnableScheduler(): boolean {
  const runMode = (process.env.RUN_MODE ?? 'continuous').toLowerCase();
  return runMode === 'continuous' || runMode === 'railway' || runMode === 'web';
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
  const colors: Record<string, string> = { success: '#16a34a', error: '#dc2626', running: '#d97706', idle: '#9ca3af' };
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
      return `<tr><td colspan="5" style="text-align:center;padding:32px;color:#6b7280;">
        No ${type} jobs yet. ${type === 'applied' ? 'Use the "Applied" button on a job card to track it here.' : ''}
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
               style="font-size:12px;color:#2563eb;text-decoration:none;">View posting →</a>
          </td>
        </tr>`;
    }).join('');
  };

  const tabs = (active: 'applied' | 'dismissed') => `
    <div style="display:flex;gap:4px;margin-bottom:20px;">
      <a href="?tab=applied" style="padding:8px 18px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;
         ${active === 'applied' ? 'background:#2563eb;color:white;' : 'background:#f3f4f6;color:#374151;'}">
        Applied (${applied.length})
      </a>
      <a href="?tab=dismissed" style="padding:8px 18px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;
         ${active === 'dismissed' ? 'background:#6b7280;color:white;' : 'background:#f3f4f6;color:#374151;'}">
        Dismissed (${dismissed.length})
      </a>
    </div>`;

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
      .subtitle { color: #6b7280; font-size: 14px; margin: 0 0 24px; }
      .card { background: white; border-radius: 14px; padding: 24px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04); margin-bottom: 20px; }
      .nav { margin-bottom: 20px; }
      .nav a { color: #2563eb; text-decoration: none; font-size: 14px; }
      table { width: 100%; border-collapse: collapse; }
      thead th { background: #f8fafc; padding: 10px 14px; text-align: left;
                 font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase;
                 letter-spacing: .05em; border-bottom: 1px solid #e5e7eb; }
      tbody tr:hover { background: #f8fafc !important; }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="nav"><a href="/">← Back to Dashboard</a></div>
      <h1>Application History</h1>
      <p class="subtitle">${applied.length} applied · ${dismissed.length} dismissed</p>

      <div class="card" id="applied-section">
        <div style="font-size:17px;font-weight:600;margin-bottom:16px;">Applied (${applied.length})</div>
        ${tabs('applied')}
        <div id="tab-applied">
          <table>
            <thead><tr>
              <th>Date</th><th>Job</th><th>Company</th><th>Score</th><th>Status</th><th>Link</th>
            </tr></thead>
            <tbody>${tableRows(applied, 'applied')}</tbody>
          </table>
        </div>
      </div>

      <div class="card" id="dismissed-section">
        <div style="font-size:17px;font-weight:600;margin-bottom:16px;">Dismissed (${dismissed.length})</div>
        ${tabs('dismissed')}
        <div id="tab-dismissed">
          <table>
            <thead><tr>
              <th>Date</th><th>Job</th><th>Company</th><th>Score</th><th>Status</th><th>Link</th>
            </tr></thead>
            <tbody>${tableRows(dismissed, 'dismissed')}</tbody>
          </table>
        </div>
      </div>
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

function renderHtml(state: JobSearchState): string {
  const rows =
    state.latestMatches.length > 0
      ? state.latestMatches
          .map((match, idx) => {
            const url = escapeHtml(match.job.canonicalUrl);
            const sc = match.score;
            const reasons = match.reasons.slice(0, 2).join('<br>');
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
            const hasCoverLetter = !!(match.coverLetter && match.coverLetter.length > 10);
            const clId = `cl-${idx}`;
            const coverLetterRow = hasCoverLetter
              ? `<tr id="${clId}" style="display:none;"><td colspan="8" style="padding:0 14px 16px;"><div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;font-size:13px;color:#374151;line-height:1.6;white-space:pre-wrap;">${escapeBr(match.coverLetter)}</div></td></tr>`
              : '';
            return `
              <tr>
                <td>
                  <div style="font-weight:600;font-size:14px;line-height:1.4;">${escapeHtml(match.job.title)}</div>
                  <div style="font-size:12px;color:#6b7280;margin-top:2px;">${escapeHtml(match.job.source ?? '')}</div>
                </td>
                <td style="font-weight:500;">${escapeHtml(match.job.company)}</td>
                <td style="color:#374151;font-size:13px;">${escapeHtml(match.job.locationLabel)}${visaBadge}</td>
                <td>${workModeBadge(match.job.workMode)}</td>
                <td style="font-size:13px;white-space:nowrap;">${salaryDisplay}</td>
                <td>
                  <span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;font-weight:700;color:${scoreColor(sc)};background:${scoreBg(sc)};">
                    ${sc}%
                  </span>
                  ${match.relevanceScore != null ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;">AI: ${match.relevanceScore}/10</div>` : ''}
                </td>
                <td style="font-size:12px;color:#4b5563;max-width:220px;">${reasons}</td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:6px;min-width:120px;">
                    <a href="${escapeHtml(match.job.applyUrl)}" target="_blank" rel="noreferrer"
                       style="display:block;text-align:center;padding:6px 12px;background:#2563eb;color:white;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;">
                      Apply
                    </a>
                    <form method="post" action="/jobs/applied">
                      <input type="hidden" name="url" value="${url}" />
                      <input type="hidden" name="title" value="${escapeHtml(match.job.title)}" />
                      <input type="hidden" name="company" value="${escapeHtml(match.job.company)}" />
                      <input type="hidden" name="score" value="${sc}" />
                      <input type="hidden" name="source" value="${escapeHtml(match.job.source ?? '')}" />
                      <button type="submit" style="width:100%;padding:6px 12px;background:#15803d;color:white;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">
                        Applied
                      </button>
                    </form>
                    <form method="post" action="/jobs/dismissed">
                      <input type="hidden" name="url" value="${url}" />
                      <input type="hidden" name="title" value="${escapeHtml(match.job.title)}" />
                      <input type="hidden" name="company" value="${escapeHtml(match.job.company)}" />
                      <input type="hidden" name="score" value="${sc}" />
                      <input type="hidden" name="source" value="${escapeHtml(match.job.source ?? '')}" />
                      <button type="submit" style="width:100%;padding:6px 12px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">
                        Dismiss
                      </button>
                    </form>
                    ${hasCoverLetter ? `<button type="button" onclick="toggleCl('${clId}')" style="width:100%;padding:6px 12px;background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">Cover letter</button>` : ''}
                  </div>
                </td>
              </tr>
              ${coverLetterRow}
            `;
          })
          .join('\n')
      : `<tr><td colspan="8" style="text-align:center;padding:40px;color:#6b7280;">
           No current matches. The bot will check again at the next scheduled run.
         </td></tr>`;

  const statusLabel = state.lastRunStatus === 'running' ? 'Running…' : state.lastRunStatus;

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
            <p class="subtitle">Uman Mushtaq, Node.js / NestJS Backend Engineer, Paris &nbsp;·&nbsp; <a href="/history" style="color:#2563eb;text-decoration:none;">Application History →</a></p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;background:#f8fafc;border:1px solid #e5e7eb;">
            ${statusDot(state.lastRunStatus)}
            <span style="font-size:13px;font-weight:600;color:#374151;">${escapeHtml(statusLabel)}</span>
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

        <div style="margin-top:16px;">
          <div style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">
            Active sources (${state.activeSources.length})
          </div>
          <div class="sources-row">
            ${state.activeSources.map((s) => `<span class="source-chip">${escapeHtml(s)}</span>`).join('')}
          </div>
          ${state.blockedSources.length ? `
          <div style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 8px;">
            No public API
          </div>
          <div class="sources-row">
            ${state.blockedSources.map((s) => `<span class="source-chip blocked-chip">${escapeHtml(s)}</span>`).join('')}
          </div>` : ''}
        </div>

        <div class="actions-row">
          <form method="post" action="/run-now">
            <button class="btn btn-primary" type="submit">
              ▶ Run now
            </button>
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

      <div class="card">
        <h2>Current matches <span style="font-size:14px;font-weight:400;color:#6b7280;">(${state.latestMatches.length})</span></h2>
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
                <th>Why it matches</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
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

      function toggleCl(id) {
        var row = document.getElementById(id);
        if (!row) return;
        row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
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
      setInterval(loadHealth, 30000);
    </script>
  </body>
</html>`;
}
