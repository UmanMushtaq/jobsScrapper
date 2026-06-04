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

const URL_KEY_MAP: Record<string, string> = {
  seen_urls: 'job:seen',       // ZSET — score = timestamp ms; pruned on every read AND write
  sent_urls: 'job:sent',       // SET  — permanent, never expires
  applied_urls: 'job:applied', // SET
  dismissed_urls: 'job:dismissed', // SET
};

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
    if (urlKey === 'seen_urls') {
      // Prune BEFORE reading so the window shrinks even when 0 matches are found
      // (writes only happen when matches exist — without read-time pruning the ZSET
      // accumulates forever and blocks all fresh jobs on every subsequent run).
      const pruneMs = options?.ttlMs ?? 48 * 60 * 60 * 1000;
      await r.zremrangebyscore(key, 0, Date.now() - pruneMs);
      const members = await r.zrange<string[]>(key, 0, -1);
      return new Set(members);
    }
    const members = await r.smembers<string[]>(key);
    return new Set(members);
  } catch (err) {
    console.error('[redis] readUrlSet failed:', (err as Error).message);
    return null;
  }
}

export async function redisAddUrls(urlKey: string, urls: string[], ttlMs?: number): Promise<void> {
  if (!urls.length) return;
  const r = getClient();
  if (!r) return;
  const key = URL_KEY_MAP[urlKey];
  if (!key) return;

  try {
    if (urlKey === 'seen_urls') {
      const now = Date.now();
      type SM = { score: number; member: string };
      const scoreMembers = urls.map((url): SM => ({ score: now, member: url })) as [SM, ...SM[]];
      await r.zadd<string>(key, ...scoreMembers);
      // Prune entries older than the configured TTL (defaults to 48h)
      const pruneMs = ttlMs ?? 48 * 60 * 60 * 1000;
      await r.zremrangebyscore(key, 0, now - pruneMs);
    } else {
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
// Use explicit JSON.stringify/parse to ensure reliable round-trip for nested objects.

export async function redisGetJson<T>(redisKey: string, fallback: T): Promise<T> {
  const r = getClient();
  if (!r) return fallback;
  try {
    // State is stored as a JSON string so complex nested objects survive serialization
    const raw = await r.get<string>(redisKey);
    if (raw == null) return fallback;
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as T;
  } catch (err) {
    console.error('[redis] getJson failed:', (err as Error).message);
    return fallback;
  }
}

export async function redisSetEx(key: string, value: string, ttlSeconds: number): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    await r.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.error('[redis] setEx failed:', (err as Error).message);
  }
}

export async function redisGet(key: string): Promise<string | null> {
  const r = getClient();
  if (!r) return null;
  try {
    return await r.get<string>(key);
  } catch (err) {
    console.error('[redis] get failed:', (err as Error).message);
    return null;
  }
}
export async function redisSetJson<T>(redisKey: string, value: T): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    const serialized = JSON.stringify(value);
    await r.set(redisKey, serialized);
  } catch (err) {
    console.error('[redis] setJson failed:', (err as Error).message);
  }
}
