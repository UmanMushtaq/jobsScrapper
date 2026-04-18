import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { loadSearchProfile } from './job-search/profile';
import {
  markJobDecision,
  readJobSearchState,
  runJobSearchOnce,
} from './job-search/run';
import { JobSearchState } from './job-search/types';

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private activeRun: Promise<void> | null = null;
  private intervalMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? 0);

  async onModuleInit(): Promise<void> {
    const profile = await loadSearchProfile();
    if (!this.intervalMinutes || this.intervalMinutes <= 0) {
      this.intervalMinutes = Math.max(15, Math.round(profile.search.checkIntervalHours * 60));
    }

    if (!shouldEnableScheduler()) {
      this.logger.log('Scheduler disabled; web app is running in health/dashboard mode only.');
      return;
    }

    await this.safeRun('startup');
    this.intervalHandle = setInterval(() => {
      void this.safeRun('interval');
    }, this.intervalMinutes * 60 * 1000);

    this.logger.log(`Scheduler enabled with ${this.intervalMinutes} minute interval.`);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async runNow(): Promise<void> {
    await this.safeRun('manual');
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
        <div><strong>Last run:</strong> <span class="muted">${escapeHtml(state.lastRunAt ?? 'never')}</span></div>
        <div><strong>Last success:</strong> <span class="muted">${escapeHtml(state.lastSuccessAt ?? 'never')}</span></div>
        <div><strong>Next run:</strong> <span class="muted">${escapeHtml(state.nextRunAt ?? 'not scheduled')}</span></div>
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
  </body>
</html>`;
}
