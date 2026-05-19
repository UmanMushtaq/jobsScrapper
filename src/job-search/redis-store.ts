import { Redis } from '@upstash/redis';

let _client: Redis | null | undefined = undefined;

function getClient(): Redis | null {
  if (_client !== undefined) return _client;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _client = url && token ? new Redis({ url, token }) : null;
  return _client;
}

export function isRedisAvailable(): boolean {
  return getClient() !== null;
}

// URL storage key → Redis key
const URL_KEY_MAP: Record<string, string> = {
  seen_urls: 'job:seen',       // ZSET — score = timestamp ms, enables TTL filtering
  sent_urls: 'job:sent',       // SET  — permanent
  applied_urls: 'job:applied', // SET
  dismissed_urls: 'job:dismissed', // SET
};

// State JSON file basename → Redis key
export const FILE_KEY_MAP: Record<string, string> = {
  'job_search_state.json': 'job:state',
};

// --- URL set operations ---

export async function redisReadUrlSet(
  urlKey: string,
  options?: { ttlMs?: number },
): Promise<Set<string> | null> {
  const r = getClient();
  if (!r) return null;
  const key = URL_KEY_MAP[urlKey];
  if (!key) return null;

  try {
    if (urlKey === 'seen_urls' && options?.ttlMs) {
      const minScore = Date.now() - options.ttlMs;
      // zrange with byScore returns members scored between minScore and +inf
      const members = await r.zrange<string[]>(key, minScore, '+inf', { byScore: true });
      return new Set(members);
    }
    const members = await r.smembers<string[]>(key);
    return new Set(members);
  } catch (err) {
    console.error('[redis] readUrlSet failed:', (err as Error).message);
    return null;
  }
}

export async function redisAddUrls(urlKey: string, urls: string[]): Promise<void> {
  if (!urls.length) return;
  const r = getClient();
  if (!r) return;
  const key = URL_KEY_MAP[urlKey];
  if (!key) return;

  try {
    if (urlKey === 'seen_urls') {
      const now = Date.now();
      // Cast to non-empty tuple — safe because we guard urls.length > 0 above
      type SM = { score: number; member: string };
      const scoreMembers = urls.map((url): SM => ({ score: now, member: url })) as [SM, ...SM[]];
      await r.zadd<string>(key, ...scoreMembers);
      // Prune entries older than 7 days to keep the sorted set bounded
      await r.zremrangebyscore(key, 0, now - 7 * 24 * 60 * 60 * 1000);
    } else {
      // Cast to non-empty tuple — safe because we guard urls.length > 0 above
      const nonEmpty = urls as [string, ...string[]];
      await r.sadd<string>(key, ...nonEmpty);
    }
  } catch (err) {
    console.error('[redis] addUrls failed:', (err as Error).message);
  }
}

export async function redisRemoveUrls(urlKey: string, urls: string[]): Promise<void> {
  if (!urls.length) return;
  const r = getClient();
  if (!r) return;
  const key = URL_KEY_MAP[urlKey];
  if (!key) return;

  try {
    if (urlKey === 'seen_urls') {
      await r.zrem<string>(key, ...urls);
    } else {
      await r.srem<string>(key, ...urls);
    }
  } catch (err) {
    console.error('[redis] removeUrls failed:', (err as Error).message);
  }
}

// --- JSON state operations ---

export async function redisGetJson<T>(redisKey: string, fallback: T): Promise<T> {
  const r = getClient();
  if (!r) return fallback;
  try {
    const data = await r.get<T>(redisKey);
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

export async function redisSetJson<T>(redisKey: string, value: T): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    await r.set(redisKey, value);
  } catch (err) {
    console.error('[redis] setJson failed:', (err as Error).message);
  }
}
