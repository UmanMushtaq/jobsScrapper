import { Redis } from '@upstash/redis';

const DAILY_CAP = 100;

const KEY_SLOTS = ['SCRAPER_API_KEY_1', 'SCRAPER_API_KEY_2', 'SCRAPER_API_KEY_3'] as const;

function getKeys(): Array<{ slot: string; value: string }> {
  const dual = process.env.SCRAPER_API_DUAL_KEY_ENABLED === 'true';
  if (dual) {
    return KEY_SLOTS
      .map((slot) => ({ slot, value: process.env[slot] ?? '' }))
      .filter((k) => k.value !== '');
  }
  const legacy = process.env.SCRAPERAPI_KEY ?? process.env.SCRAPER_API_KEY_1;
  return legacy ? [{ slot: 'SCRAPER_API_KEY_1', value: legacy }] : [];
}

function todayRedisKey(slot: string, date: string): string {
  const label = slot.replace('SCRAPER_API_', '').toLowerCase();
  return `scraper_api_usage:${label}:${date}`;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function getUsage(redis: Redis, slot: string, date: string): Promise<number> {
  try {
    const val = await redis.get<string>(todayRedisKey(slot, date));
    return val ? parseInt(val, 10) : 0;
  } catch {
    return 0;
  }
}

async function incrementUsage(redis: Redis, slot: string, date: string): Promise<void> {
  try {
    const key = todayRedisKey(slot, date);
    await redis.incr(key);
    await redis.expire(key, 86400 * 2);
  } catch { /* non-fatal */ }
}

export async function getNextKey(): Promise<string | null> {
  const keys = getKeys();
  if (keys.length === 0) return null;

  const redis = getRedis();
  if (!redis) {
    return keys[0].value;
  }

  const date = new Date().toISOString().slice(0, 10);

  let bestSlot: string | null = null;
  let bestValue: string | null = null;
  let bestUsage = Infinity;

  for (const { slot, value } of keys) {
    const usage = await getUsage(redis, slot, date);
    if (usage < DAILY_CAP && usage < bestUsage) {
      bestUsage = usage;
      bestSlot = slot;
      bestValue = value;
    }
  }

  if (!bestSlot || !bestValue) {
    console.warn('[scraper-api] all keys at daily cap — skipping ScraperAPI');
    return null;
  }

  const keyNum = bestSlot.replace('SCRAPER_API_KEY_', 'KEY_');
  console.log(`[scraper-api] Using ${keyNum} | today: ${bestUsage + 1}/${DAILY_CAP}`);

  await incrementUsage(redis, bestSlot, date);
  return bestValue;
}

export function buildScraperUrl(
  targetUrl: string,
  apiKey: string,
  premium = false,
  options: { render?: boolean; residential?: boolean } = {},
): string {
  const { render = true, residential = true } = options;
  const params: Record<string, string> = {
    api_key: apiKey,
    url: targetUrl,
  };
  if (render) params['render'] = 'true';
  if (residential) params['residential'] = 'true';
  if (premium) params['premium'] = 'true';
  return `https://api.scraperapi.com?${new URLSearchParams(params)}`;
}
