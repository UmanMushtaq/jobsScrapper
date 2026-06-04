import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { enrichMatch, lastGeminiError } from './job-search/ai-enrichment';
import { loadSearchProfile } from './job-search/profile';
import {
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
import { JobSearchState } from './job-search/types';

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private pingHandle: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private intervalMinutes = 0;

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
      await answerCallbackQuery(botToken, cbq.id, 'Job not found — may have expired');
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
    await answerCallbackQuery(botToken, cbq.id, `${label} — saved!`);
  }

  async markApplied(url: string): Promise<void> {
    if (!url) {
      return;
    }

    await markJobDecision('applied', url);
  }

  async markDismissed(url: string): Promise<void> {
    if (!url) {
      return;
    }

    await markJobDecision('dismissed', url);
  }

  async getHealth(): Promise<Record<string, unknown>> {
    const state = await readJobSearchState();
    return {
      ok: true,
      status: state.lastRunStatus,
      lastRunAt: state.lastRunAt,
      lastSuccessAt: state.lastSuccessAt,
      nextRunAt: state.nextRunAt,
      intervalMinutes: state.intervalMinutes,
      matches: state.stats.matchCount,
      error: state.lastError,
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
        return { ok: false, error: lastGeminiError || 'enrichMatch returned null — all keys/models failed', keysConfigured: keys.length };
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

  async validateGeminiKeys(): Promise<Record<string, unknown>> {
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
      return { ok: false, error: 'No keys configured', advice: 'Add GEMINI_API_KEY or GEMINI_API_KEY_1..10 env vars' };
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
          if (msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted')) {
            status = 'quota_exhausted';
            error = 'Daily quota used up — this key needs to be from a different Google account';
            break;
          } else if (msg.includes('api_key_invalid') || msg.includes('invalid api key') || msg.includes('401')) {
            status = 'invalid_key';
            error = 'Key is invalid or revoked';
            break;
          } else if (msg.includes('403')) {
            status = 'permission_denied';
            error = 'Gemini API not enabled for this key/project';
            break;
          } else {
            error = msg.slice(0, 100);
          }
        }
      }

      results.push({ source, key: keyPreview, status, model: model || null, error: error || null });
    }

    const okCount = results.filter((r) => r.status === 'ok').length;
    const exhaustedCount = results.filter((r) => r.status === 'quota_exhausted').length;
    const invalidCount = results.filter((r) => r.status === 'invalid_key').length;

    const advice: string[] = [];

    // Email detection is impossible via the API — API keys contain no identity info.
    // Explain clearly how to manually verify.
    advice.push(
      'IMPORTANT: The Gemini API does not expose which Gmail account a key belongs to. ' +
      'To find out: open https://aistudio.google.com/apikey in a browser. ' +
      'Log into each Gmail account one by one — the keys listed on that page belong to THAT account. ' +
      'If all your keys appear under the same Gmail, they all share one 1500 req/day quota regardless of how many keys there are.',
    );

    if (exhaustedCount > 0 && okCount === 0) {
      advice.push(
        `All ${exhaustedCount} keys are quota-exhausted simultaneously. This almost certainly means they all belong to the same Google account. ` +
        'Fix: go to aistudio.google.com with a different Gmail (friend\'s account, new account) and create a new API key there. ' +
        'That gives an independent 1500 req/day quota. 2 different accounts is more than enough for this bot (~60-100 calls/day).',
      );
    } else if (exhaustedCount > 0) {
      advice.push(`${exhaustedCount} key(s) exhausted, ${okCount} still working. Bot will use the working ones.`);
    }
    if (invalidCount > 0) {
      advice.push(`${invalidCount} key(s) are invalid or revoked — remove them from env vars to reduce noise.`);
    }
    if (okCount > 0 && exhaustedCount === 0 && invalidCount === 0) {
      advice.push(
        `All ${okCount} keys are working. Daily capacity estimate: ${okCount * 1500} req/day IF each key is from a different Google account. ` +
        'If they are all from the same account, real capacity is 1500 req/day total.',
      );
    }

    return {
      testedAt: new Date().toISOString(),
      totalKeys: rawKeys.length,
      working: okCount,
      quotaExhausted: exhaustedCount,
      invalid: invalidCount,
      howToFindEmail: 'Go to https://aistudio.google.com/apikey — log in with each Gmail one at a time. Keys shown = keys owned by that account.',
      advice,
      keys: results,
    };
  }

  async renderDashboard(): Promise<string> {
    const state = await readJobSearchState();
    return renderHtml(state);
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

function renderHtml(state: JobSearchState): string {
  const statusColor =
    state.lastRunStatus === 'success'
      ? '#116329'
      : state.lastRunStatus === 'error'
        ? '#8f1d1d'
        : '#374151';

  const rows =
    state.latestMatches.length > 0
      ? state.latestMatches
          .map((match) => {
            const url = escapeHtml(match.job.canonicalUrl);
            return `
              <tr>
                <td>${escapeHtml(match.job.title)}</td>
                <td>${escapeHtml(match.job.company)}</td>
                <td>${escapeHtml(match.job.locationLabel)}</td>
                <td>${escapeHtml(match.job.workMode)}</td>
                <td>${escapeHtml(match.salaryLabel)}</td>
                <td>${match.score}%</td>
                <td>${escapeHtml(match.reasons.join('; '))}</td>
                <td>
                  <a href="${escapeHtml(match.job.applyUrl)}" target="_blank" rel="noreferrer">Apply</a>
                  <form method="post" action="/jobs/applied" style="display:inline-block;margin-left:8px;">
                    <input type="hidden" name="url" value="${url}" />
                    <button type="submit">Applied</button>
                  </form>
                  <form method="post" action="/jobs/dismissed" style="display:inline-block;margin-left:8px;">
                    <input type="hidden" name="url" value="${url}" />
                    <button type="submit">Dismiss</button>
                  </form>
                </td>
              </tr>
            `;
          })
          .join('\n')
      : '<tr><td colspan="8">No current matches. The bot will keep checking automatically.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Job Search Bot</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; background: #f8fafc; color: #111827; }
      .card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); margin-bottom: 20px; }
      .status { color: ${statusColor}; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; background: white; }
      th, td { border-bottom: 1px solid #e5e7eb; padding: 12px; text-align: left; vertical-align: top; }
      th { background: #f3f4f6; }
      button { border: 0; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
      form button { background: #111827; color: white; }
      .run-button { background: #2563eb; color: white; }
      .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .muted { color: #6b7280; }
      a { color: #1d4ed8; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Job Search Bot</h1>
      <p class="status">Status: ${escapeHtml(state.lastRunStatus)}</p>
      <div class="meta">
        <div><strong>Last run:</strong> <span class="muted ts" data-utc="${escapeHtml(state.lastRunAt ?? '')}">${escapeHtml(state.lastRunAt ?? 'never')}</span></div>
        <div><strong>Last success:</strong> <span class="muted ts" data-utc="${escapeHtml(state.lastSuccessAt ?? '')}">${escapeHtml(state.lastSuccessAt ?? 'never')}</span></div>
        <div><strong>Next run:</strong> <span class="muted ts" data-utc="${escapeHtml(state.nextRunAt ?? '')}">${escapeHtml(state.nextRunAt ?? 'not scheduled')}</span></div>
        <div><strong>Interval:</strong> <span class="muted">${state.intervalMinutes} minutes</span></div>
        <div><strong>Seen TTL:</strong> <span class="muted">${state.seenTtlHours} hour(s)</span></div>
        <div><strong>Latest match count:</strong> <span class="muted">${state.stats.matchCount}</span></div>
      </div>
      ${
        state.lastError
          ? `<p><strong>Last error:</strong> <span class="muted">${escapeHtml(state.lastError)}</span></p>`
          : ''
      }
      <p><strong>Active sources:</strong> ${escapeHtml(state.activeSources.join(', '))}</p>
      <p><strong>Blocked sources:</strong> ${escapeHtml(state.blockedSources.join(', '))}</p>
      <form method="post" action="/run-now">
        <button class="run-button" type="submit">Run now</button>
      </form>
    </div>

    <div class="card">
      <h2>Current matches</h2>
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
    <script>
      document.querySelectorAll('.ts[data-utc]').forEach(function(el) {
        var utc = el.getAttribute('data-utc');
        if (!utc) return;
        var d = new Date(utc);
        if (isNaN(d.getTime())) return;
        el.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      });
    </script>
  </body>
</html>`;
}
