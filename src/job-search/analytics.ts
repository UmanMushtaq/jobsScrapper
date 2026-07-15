import { getAllJobDecisionsForAnalytics } from '../database/database.service';
import { redisGetJobHistory, redisGetDashboardJobs } from './redis-store';

export type JobStatus = 'applied' | 'dismissed' | 'pending';

export interface AnalyticsRow {
  source: string;
  countryCode: string | null;
  status: JobStatus;
  // ms epoch. For a decided job this is decided_at — the only timestamp job_decisions
  // retains; there is no separate "first found" column for a decided job, so decided_at
  // doubles as the "when this entered the historical record" timestamp. For a pending
  // job this is the real foundAt from the live dashboard cache. This distinction is
  // surfaced in AnalyticsData.dataNote rather than silently glossed over.
  timestamp: number;
}

export type WindowDays = 7 | 30 | 90 | 'all';

export function filterByWindow(rows: AnalyticsRow[], windowDays: WindowDays): AnalyticsRow[] {
  if (windowDays === 'all') return rows;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return rows.filter((r) => r.timestamp >= cutoff);
}

export interface CountBucket {
  label: string;
  count: number;
}

function countBy<T>(rows: T[], keyFn: (r: T) => string): CountBucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = keyFn(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function computeCountsBySource(rows: AnalyticsRow[]): CountBucket[] {
  return countBy(rows, (r) => r.source);
}

export function computeApplicationsBySource(rows: AnalyticsRow[]): CountBucket[] {
  return computeCountsBySource(rows.filter((r) => r.status === 'applied'));
}

export function computeCountsByCountry(rows: AnalyticsRow[]): CountBucket[] {
  return countBy(rows, (r) => r.countryCode ?? 'Unknown');
}

export interface StatusBreakdown {
  applied: number;
  dismissed: number;
  pending: number;
}

export function computeStatusBreakdown(rows: AnalyticsRow[]): StatusBreakdown {
  return {
    applied: rows.filter((r) => r.status === 'applied').length,
    dismissed: rows.filter((r) => r.status === 'dismissed').length,
    pending: rows.filter((r) => r.status === 'pending').length,
  };
}

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  count: number;
}

export function computeTrendOverTime(rows: AnalyticsRow[]): TrendPoint[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = new Date(r.timestamp).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return Array.from(byDay.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export interface AnalyticsData {
  windowDays: WindowDays;
  totalRows: number;
  jobsBySource: CountBucket[];
  applicationsBySource: CountBucket[];
  jobsByCountry: CountBucket[];
  statusBreakdown: StatusBreakdown;
  trend: TrendPoint[];
  dataNote: string;
}

const DATA_NOTE =
  'Includes decided jobs (applied/dismissed, timestamped by decision date) plus ' +
  'currently pending jobs still awaiting a decision (timestamped by when found). ' +
  'Pending reflects only what is currently live in the dashboard cache, not full ' +
  'historical pending volume — there is no durable "found but never decided" log.';

export function buildAnalyticsData(rows: AnalyticsRow[], windowDays: WindowDays): AnalyticsData {
  const filtered = filterByWindow(rows, windowDays);
  return {
    windowDays,
    totalRows: filtered.length,
    jobsBySource: computeCountsBySource(filtered),
    applicationsBySource: computeApplicationsBySource(filtered),
    jobsByCountry: computeCountsByCountry(filtered),
    statusBreakdown: computeStatusBreakdown(filtered),
    trend: computeTrendOverTime(filtered),
    dataNote: DATA_NOTE,
  };
}

// --- Data fetching: PostgreSQL primary (decided jobs), Redis fallback + pending supplement ---
//
// Decided jobs (applied/dismissed) live in Postgres's job_decisions table when configured;
// when Postgres is unavailable or empty, redisGetJobHistory() supplies the same decisions
// from its 180-day Redis fallback — but that shape never tracked country, so jobsByCountry
// will under-report on a Redis-only deployment. Pending (undecided) jobs only ever exist in
// the live Redis dashboard cache regardless of which backend serves decided jobs, since a
// job is removed from that cache the moment a decision is made.
export async function fetchAnalyticsRows(): Promise<AnalyticsRow[]> {
  const rows: AnalyticsRow[] = [];

  const pgDecisions = await getAllJobDecisionsForAnalytics();
  if (pgDecisions.length > 0) {
    for (const d of pgDecisions) {
      rows.push({
        source: d.source,
        countryCode: d.country,
        status: d.decision,
        timestamp: new Date(d.decidedAt).getTime(),
      });
    }
  } else {
    const redisHistory = await redisGetJobHistory();
    for (const h of redisHistory) {
      rows.push({
        source: h.source,
        countryCode: null,
        status: h.type,
        timestamp: new Date(h.date).getTime(),
      });
    }
  }

  const pending = await redisGetDashboardJobs();
  for (const p of pending) {
    const m = p.match as { job?: { source?: string; countryCode?: string | null } } | null;
    rows.push({
      source: m?.job?.source ?? 'unknown',
      countryCode: m?.job?.countryCode ?? null,
      status: 'pending',
      timestamp: p.foundAt,
    });
  }

  return rows;
}
