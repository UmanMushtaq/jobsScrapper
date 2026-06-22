import { Redis } from '@upstash/redis';

const DAILY_CAP = 33;

function getKeys(): string[] {
  const dual = process.env.SCRAPER_API_DUAL_KEY_ENABLED === 'true';
  if (dual) {
    const keys: string[] = [];
    const k1 = process.env.SCRAPER_API_KEY_1;
    const k2 = process.env.SCRAPER_API_KEY_2;
    if (k1) keys.push(k1);
    if (k2) keys.push(k2);
    return keys;
  }
  const legacy = process.env.SCRAPERAPI_KEY ?? process.env.SCRAPER_API_KEY_1;
  return legacy ? [legacy] : [];
}

function todayKey(apiKey: string): string {
  const d = new Date().toISOString().slice(0, 10);
  const suffix = apiKey.slice(-6);
  return `scraper_api_usage:${suffix}:${d}`;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function getUsage(redis: Redis, apiKey: string): Promise<number> {
  try {
    const val = await redis.get<string>(todayKey(apiKey));
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

async function incrementUsage(redis: Redis, apiKey: string): Promise<void> {
  try {
    const key = todayKey(apiKey);
    await redis.incr(key);
    await redis.expire(key, 86400 * 2);
  } catch { /* non-fatal */ }
}

export async function getNextKey(): Promise<string | null> {
  const keys = getKeys();
  if (keys.length === 0) return null;

  const redis = getRedis();
  if (!redis) {
    // No Redis — return first key without cap tracking
    return keys[0];
  }

  let bestKey: string | null = null;
  let bestUsage = Infinity;

  for (const k of keys) {
    const usage = await getUsage(redis, k);
    if (usage < DAILY_CAP && usage < bestUsage) {
      bestUsage = usage;
      bestKey = k;
    }
  }

  if (!bestKey) {
    console.warn('[scraper-api] all keys at daily cap — skipping ScraperAPI');
    return null;
  }

  await incrementUsage(redis, bestKey);
  return bestKey;
}

export function buildScraperUrl(targetUrl: string, apiKey: string, premium = false): string {
  const params: Record<string, string> = {
    api_key: apiKey,
    url: targetUrl,
    render: 'true',
    residential: 'true',
  };
  if (premium) params['premium'] = 'true';
  return `https://api.scraperapi.com?${new URLSearchParams(params)}`;
}
