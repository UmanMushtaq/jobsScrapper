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

function renderHtml(state: JobSearchState): string {
  const rows =
    state.latestMatches.length > 0
      ? state.latestMatches
          .map((match) => {
            const url = escapeHtml(match.job.canonicalUrl);
            const sc = match.score;
            const reasons = match.reasons.slice(0, 2).join('<br>');
            return `
              <tr>
                <td>
                  <div style="font-weight:600;font-size:14px;line-height:1.4;">${escapeHtml(match.job.title)}</div>
                  <div style="font-size:12px;color:#6b7280;margin-top:2px;">${escapeHtml(match.job.source ?? '')}</div>
                </td>
                <td style="font-weight:500;">${escapeHtml(match.job.company)}</td>
                <td style="color:#374151;font-size:13px;">${escapeHtml(match.job.locationLabel)}</td>
                <td>${workModeBadge(match.job.workMode)}</td>
                <td style="font-size:13px;white-space:nowrap;">${escapeHtml(match.salaryLabel)}</td>
                <td>
                  <span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:13px;font-weight:700;color:${scoreColor(sc)};background:${scoreBg(sc)};">
                    ${sc}%
                  </span>
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
                      <button type="submit" style="width:100%;padding:6px 12px;background:#15803d;color:white;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">
                        ✓ Applied
                      </button>
                    </form>
                    <form method="post" action="/jobs/dismissed">
                      <input type="hidden" name="url" value="${url}" />
                      <button type="submit" style="width:100%;padding:6px 12px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">
                        Dismiss
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            `;
          })
          .join('\n')
      : `<tr><td colspan="8" style="text-align:center;padding:40px;color:#6b7280;">
           No current matches — the bot will check again at the next scheduled run.
         </td></tr>`;

  const statusLabel = state.lastRunStatus === 'running' ? 'Running…' : state.lastRunStatus;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Job Search — Uman Mushtaq</title>
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
            <p class="subtitle">Uman Mushtaq — Node.js / NestJS Backend Engineer, Paris</p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;background:#f8fafc;border:1px solid #e5e7eb;">
            ${statusDot(state.lastRunStatus)}
            <span style="font-size:13px;font-weight:600;color:#374151;">${escapeHtml(statusLabel)}</span>
          </div>
        </div>

        <div class="meta-grid">
          <div class="meta-item">
            <label>Last run</label>
            <span class="ts" data-utc="${escapeHtml(state.lastRunAt ?? '')}">${escapeHtml(state.lastRunAt ?? '—')}</span>
          </div>
          <div class="meta-item">
            <label>Last success</label>
            <span class="ts" data-utc="${escapeHtml(state.lastSuccessAt ?? '')}">${escapeHtml(state.lastSuccessAt ?? '—')}</span>
          </div>
          <div class="meta-item">
            <label>Next run</label>
            <span class="ts" data-utc="${escapeHtml(state.nextRunAt ?? '')}">${escapeHtml(state.nextRunAt ?? '—')}</span>
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
            <span>${state.stats.freshJobsCount ?? '—'}</span>
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
    </script>
  </body>
</html>`;
}
