// Records per-source run results and home-proxy status every scan so that
// platform failures (IP blocks, crashes, proxy offline, empty results) are
// persisted and can be reviewed/fixed later from the /platform-status page.

import { proxyFetch } from './proxy-fetch';
import { redisGetPlatformHealth, redisSavePlatformHealth } from './redis-store';
import {
  JobPosting,
  PlatformHealth,
  ProxyHealth,
  SourceHealthRecord,
  SourceHealthStatus,
} from './types';

// Sources that route through the home residential proxy (cloud IP is blocked).
// Keep in sync with the sources that import proxy-fetch.
export const PROXY_SOURCES = new Set([
  'apec.fr',
  'remoteok.com',
  'indeed.com',
  'wellfound.com',
  'europeremotely.com',
  'nodesk.co',
  'startup.jobs',
  'jobicy.com',
  'himalayas.app',
]);

export interface SourceRunResult {
  source: string;
  jobs: JobPosting[];
  durationMs: number;
  error: Error | null;
}

function maskUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

// Ping the home proxy through proxyFetch by fetching a tiny, reliable endpoint.
// Retries up to 3 times to avoid false-negatives from transient Cloudflare 502s.
async function pingProxy(): Promise<ProxyHealth> {
  const proxyUrl = process.env.JOB_PROXY_URL;
  const proxySecret = process.env.JOB_PROXY_SECRET;
  const checkedAt = new Date().toISOString();
  const maskedUrl = proxyUrl ? maskUrl(proxyUrl) : null;

  if (!proxyUrl || !proxySecret) {
    return {
      configured: false,
      online: false,
      url: maskedUrl,
      error: 'JOB_PROXY_URL / JOB_PROXY_SECRET not set in environment — proxy sources will be blocked',
      checkedAt,
    };
  }

  // Try multiple targets in case one is temporarily rate-limited or unreachable.
  const PING_TARGETS = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://checkip.amazonaws.com'];
  const MAX_ATTEMPTS = 3;
  let lastError = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const target = PING_TARGETS[attempt % PING_TARGETS.length];
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000 * attempt));
      const res = await proxyFetch(target, { signal: AbortSignal.timeout(12_000) });
      if (res.status === 403) {
        return {
          configured: true, online: false, url: maskedUrl, checkedAt,
          error: 'Proxy returned 403 Forbidden — JOB_PROXY_SECRET on Render does not match your laptop proxy\'s secret. Fix: open Render → Environment, copy the exact secret from your proxy script, paste it into JOB_PROXY_SECRET, and redeploy.',
        };
      }
      if (res.ok) {
        return { configured: true, online: true, url: maskedUrl, error: null, checkedAt };
      }
      lastError = `HTTP ${res.status} from ${target}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    configured: true,
    online: false,
    url: maskedUrl,
    error: `Proxy tunnel appears down after ${MAX_ATTEMPTS} attempts — last error: ${lastError}. Check the proxy + cloudflared are running on your laptop.`,
    checkedAt,
  };
}

function classify(
  result: SourceRunResult,
  usesProxy: boolean,
  proxy: ProxyHealth,
): { status: SourceHealthStatus; error: string | null } {
  if (result.error) {
    const msg = result.error.message;
    const lower = msg.toLowerCase();
    if (usesProxy && (lower.includes('proxy') || lower.includes('tunnel') || lower.includes('503') || lower.includes('523'))) {
      return { status: 'proxy_offline', error: msg };
    }
    if (lower.includes('403') || lower.includes('429') || lower.includes('forbidden') || lower.includes('captcha') || lower.includes('blocked')) {
      return { status: 'blocked', error: msg };
    }
    return { status: 'error', error: msg };
  }

  if (result.jobs.length === 0) {
    // A proxy source returning nothing almost always means the residential
    // tunnel is unavailable rather than "no jobs today".
    if (usesProxy && proxy.configured && !proxy.online) {
      return { status: 'proxy_offline', error: 'Home proxy offline — source could not be reached over your residential IP' };
    }
    if (usesProxy && !proxy.configured) {
      return { status: 'blocked', error: 'Needs the home proxy (JOB_PROXY_URL not set) — this source blocks cloud server IPs' };
    }
    return { status: 'empty', error: null };
  }

  return { status: 'ok', error: null };
}

export async function recordPlatformHealth(results: SourceRunResult[]): Promise<PlatformHealth> {
  const prev = await redisGetPlatformHealth<PlatformHealth | null>(null);
  const prevBySource = new Map((prev?.sources ?? []).map((s) => [s.source, s]));
  const now = new Date().toISOString();

  let proxy = await pingProxy();

  // If the ping failed but at least one proxy source returned real jobs this run,
  // the tunnel is clearly reachable — the ping target was just transiently unreachable.
  if (!proxy.online && proxy.configured) {
    const hasProxyJobs = results.some((r) => PROXY_SOURCES.has(r.source) && r.jobs.length > 0);
    if (hasProxyJobs) {
      proxy = { ...proxy, online: true, error: null };
    }
  }

  const sources: SourceHealthRecord[] = results.map((r) => {
    const usesProxy = PROXY_SOURCES.has(r.source);
    const { status, error } = classify(r, usesProxy, proxy);
    const previous = prevBySource.get(r.source);
    const isFailure = status === 'error' || status === 'blocked' || status === 'proxy_offline';
    return {
      source: r.source,
      status,
      jobsFound: r.jobs.length,
      durationMs: r.durationMs,
      error,
      usesProxy,
      lastCheckedAt: now,
      lastSuccessAt: r.jobs.length > 0 ? now : previous?.lastSuccessAt ?? null,
      consecutiveFailures: isFailure ? (previous?.consecutiveFailures ?? 0) + 1 : 0,
    };
  });

  // Keep a stable ordering: failures first, then by source name.
  const rank: Record<SourceHealthStatus, number> = { proxy_offline: 0, error: 1, blocked: 2, empty: 3, ok: 4 };
  sources.sort((a, b) => rank[a.status] - rank[b.status] || a.source.localeCompare(b.source));

  const health: PlatformHealth = { sources, proxy, updatedAt: now };
  await redisSavePlatformHealth(health);
  return health;
}

export async function getPlatformHealth(): Promise<PlatformHealth | null> {
  return redisGetPlatformHealth<PlatformHealth | null>(null);
}
