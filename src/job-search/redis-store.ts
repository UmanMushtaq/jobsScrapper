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

// All URL stores use ZSET (score = timestamp ms) so per-entry TTL is trivial.
// Legacy SET keys (job:sent, job:applied, job:dismissed) are migrated on first access.
const URL_KEY_MAP: Record<string, string> = {
  seen_urls: 'job:seen',           // ZSET — always was ZSET
  sent_urls: 'job:sent_z',         // ZSET (migrated from job:sent SET)
  applied_urls: 'job:applied_z',   // ZSET (migrated from job:applied SET)
  dismissed_urls: 'job:dismissed_z', // ZSET (migrated from job:dismissed SET)
};

const LEGACY_SET_KEY_MAP: Record<string, string> = {
  sent_urls: 'job:sent',
  applied_urls: 'job:applied',
  dismissed_urls: 'job:dismissed',
};

// Default TTLs when none supplied by caller
const DEFAULT_TTL_MS: Record<string, number> = {
  sent_urls: 30 * 24 * 60 * 60 * 1000,       // 30 days
  applied_urls: 180 * 24 * 60 * 60 * 1000,    // 180 days
  dismissed_urls: 60 * 24 * 60 * 60 * 1000,   // 60 days
};

// --- Role-based deduplication (company + base title) ---
const ROLE_KEY_MAP: Record<string, string> = {
  applied: 'job:applied_roles',
  dismissed: 'job:dismissed_roles',
};

export function buildRoleKey(company: string, title: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${norm(company)}::${norm(title.split('|')[0].trim())}`;
}

export async function redisAddRoleKey(
  type: 'applied' | 'dismissed',
  roleKey: string,
  ttlMs: number,
): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    type SM = { score: number; member: string };
    await r.zadd<string>(ROLE_KEY_MAP[type], { score: Date.now(), member: roleKey } as SM);
    await r.zremrangebyscore(ROLE_KEY_MAP[type], 0, Date.now() - ttlMs);
  } catch (err) {
    console.error('[redis] addRoleKey failed:', (err as Error).message);
  }
}

export async function redisGetRoleSet(
  type: 'applied' | 'dismissed',
  ttlMs: number,
): Promise<Set<string>> {
  const r = getClient();
  if (!r) return new Set();
  try {
    await r.zremrangebyscore(ROLE_KEY_MAP[type], 0, Date.now() - ttlMs);
    const members = await r.zrange<string[]>(ROLE_KEY_MAP[type], 0, -1);
    return new Set(members);
  } catch (err) {
    console.error('[redis] getRoleSet failed:', (err as Error).message);
    return new Set();
  }
}

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
    const pruneMs = options?.ttlMs ?? DEFAULT_TTL_MS[urlKey] ?? 48 * 60 * 60 * 1000;
    await r.zremrangebyscore(key, 0, Date.now() - pruneMs);
    const members = await r.zrange<string[]>(key, 0, -1);

    // One-time migration: copy members from legacy SET key into ZSET
    const legacyKey = LEGACY_SET_KEY_MAP[urlKey];
    if (legacyKey) {
      try {
        const legacyCount = await r.scard(legacyKey);
        if (legacyCount > 0) {
          const legacyMembers = await r.smembers<string[]>(legacyKey);
          const now = Date.now();
          type SM = { score: number; member: string };
          const scoreMembers = legacyMembers.map((m): SM => ({ score: now, member: m })) as [SM, ...SM[]];
          await r.zadd<string>(key, ...scoreMembers);
          await r.del(legacyKey);
          console.log(`[redis] migrated ${legacyCount} entries from legacy SET ${legacyKey} → ZSET ${key}`);
          return new Set([...members, ...legacyMembers]);
        }
      } catch {
        // Migration is best-effort — don't fail the read
      }
    }

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
    const now = Date.now();
    type SM = { score: number; member: string };
    const scoreMembers = urls.map((url): SM => ({ score: now, member: url })) as [SM, ...SM[]];
    await r.zadd<string>(key, ...scoreMembers);
    const pruneMs = ttlMs ?? DEFAULT_TTL_MS[urlKey] ?? 48 * 60 * 60 * 1000;
    await r.zremrangebyscore(key, 0, now - pruneMs);
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
    await r.zrem<string>(key, ...urls);
  } catch (err) {
    console.error('[redis] removeUrls failed:', (err as Error).message);
  }
}

// Read URL entries together with their stored timestamp (ZSET score = ms epoch when added).
// Used by the follow-up reminder, which needs the applied-at time, not just the URL.
export async function redisReadUrlEntries(
  urlKey: string,
): Promise<Array<{ url: string; timestamp: string }> | null> {
  const r = getClient();
  if (!r) return null;
  const key = URL_KEY_MAP[urlKey];
  if (!key) return null;

  try {
    // withScores returns a flat [member, score, member, score, ...] array.
    const flat = (await r.zrange<(string | number)[]>(key, 0, -1, { withScores: true })) ?? [];
    const entries: Array<{ url: string; timestamp: string }> = [];
    for (let i = 0; i < flat.length; i += 2) {
      const url = String(flat[i]);
      const scoreMs = Number(flat[i + 1]);
      if (!url || Number.isNaN(scoreMs)) continue;
      entries.push({ url, timestamp: new Date(scoreMs).toISOString() });
    }
    return entries;
  } catch (err) {
    console.error('[redis] readUrlEntries failed:', (err as Error).message);
    return null;
  }
}

// Follow-up "already reminded" markers live in their own ZSET so they survive restarts.
const FOLLOWUP_SENT_KEY = 'job:followup_sent';

export async function redisGetFollowupSent(ttlMs: number): Promise<Set<string> | null> {
  const r = getClient();
  if (!r) return null;
  try {
    await r.zremrangebyscore(FOLLOWUP_SENT_KEY, 0, Date.now() - ttlMs);
    const members = await r.zrange<string[]>(FOLLOWUP_SENT_KEY, 0, -1);
    return new Set(members);
  } catch (err) {
    console.error('[redis] getFollowupSent failed:', (err as Error).message);
    return null;
  }
}

export async function redisMarkFollowupSent(urls: string[]): Promise<void> {
  if (!urls.length) return;
  const r = getClient();
  if (!r) return;
  try {
    const now = Date.now();
    type SM = { score: number; member: string };
    const scoreMembers = urls.map((url): SM => ({ score: now, member: url })) as [SM, ...SM[]];
    await r.zadd<string>(FOLLOWUP_SENT_KEY, ...scoreMembers);
  } catch (err) {
    console.error('[redis] markFollowupSent failed:', (err as Error).message);
  }
}

// --- Job history (applied / dismissed with metadata) ---

export interface JobHistoryEntry {
  type: 'applied' | 'dismissed';
  title: string;
  company: string;
  url: string;
  score: number;
  source: string;
  date: string; // ISO 8601
}

const HISTORY_KEY = 'job:history_z';
const HISTORY_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

export async function redisStoreJobHistory(entry: JobHistoryEntry): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    const now = Date.now();
    type SM = { score: number; member: string };
    await r.zadd<string>(HISTORY_KEY, { score: now, member: JSON.stringify(entry) } as SM);
    await r.zremrangebyscore(HISTORY_KEY, 0, now - HISTORY_TTL_MS);
  } catch (err) {
    console.error('[redis] storeJobHistory failed:', (err as Error).message);
  }
}

export async function redisGetJobHistory(): Promise<JobHistoryEntry[]> {
  const r = getClient();
  if (!r) return [];
  try {
    const members = await r.zrange(HISTORY_KEY, 0, -1);
    const entries = members
      .map((m) => {
        try {
          // Upstash may auto-deserialize the JSON string into an object on retrieval.
          // Handle both cases: raw string (needs JSON.parse) and already-parsed object.
          const obj = typeof m === 'string' ? JSON.parse(m) : m;
          return obj as JobHistoryEntry;
        } catch { return null; }
      })
      .filter((e): e is JobHistoryEntry => e !== null);
    // Most recent first
    return entries.reverse();
  } catch (err) {
    console.error('[redis] getJobHistory failed:', (err as Error).message);
    return [];
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

// --- URL set counts (for dashboard display, no pruning side-effect) ---

export async function redisCountUrlSets(): Promise<{ seen: number; applied: number; dismissed: number; sent: number }> {
  const r = getClient();
  if (!r) return { seen: 0, applied: 0, dismissed: 0, sent: 0 };
  try {
    const [seen, applied, dismissed, sent] = await Promise.all([
      r.zcard('job:seen'),
      r.zcard('job:applied_z'),
      r.zcard('job:dismissed_z'),
      r.zcard('job:sent_z'),
    ]);
    return { seen: seen ?? 0, applied: applied ?? 0, dismissed: dismissed ?? 0, sent: sent ?? 0 };
  } catch {
    return { seen: 0, applied: 0, dismissed: 0, sent: 0 };
  }
}

// --- Platform health (per-source run results + proxy status) ---
// Persisted so source failures (blocks, crashes, proxy offline, empty results)
// survive restarts and can be reviewed/fixed later from the /platform-status page.

const PLATFORM_HEALTH_KEY = 'platform:health';

export async function redisSavePlatformHealth(value: unknown): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    await r.set(PLATFORM_HEALTH_KEY, JSON.stringify(value));
  } catch (err) {
    console.error('[redis] savePlatformHealth failed:', (err as Error).message);
  }
}

export async function redisGetPlatformHealth<T>(fallback: T): Promise<T> {
  const r = getClient();
  if (!r) return fallback;
  try {
    const raw = await r.get<string>(PLATFORM_HEALTH_KEY);
    if (raw == null) return fallback;
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as T;
  } catch (err) {
    console.error('[redis] getPlatformHealth failed:', (err as Error).message);
    return fallback;
  }
}

// --- Gemini daily call counter ---
// Key: gemini:calls:{pacific-day} (YYYY-MM-DD in America/Los_Angeles)
// Incremented on every successful Gemini API call. TTL 50h covers day rollover + buffer.

export async function redisIncrGeminiDailyCalls(day: string): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    await r.incr(`gemini:calls:${day}`);
    await r.expire(`gemini:calls:${day}`, 50 * 60 * 60);
  } catch { /* silent — never block enrichment */ }
}

export async function redisGetGeminiDailyCalls(day: string): Promise<number> {
  const r = getClient();
  if (!r) return 0;
  try {
    return Number(await r.get<string>(`gemini:calls:${day}`)) || 0;
  } catch { return 0; }
}

// --- Indeed separate-timer run tracking ---

export interface IndeedRunData {
  timestamp: string;   // ISO 8601
  jobsFound: number;
  status: 'success' | 'failed' | 'pending';
  nextRunAt: string;   // ISO 8601
}

const INDEED_LAST_RUN_KEY = 'indeed:lastRun';
const INDEED_TTL_SECONDS = 48 * 60 * 60; // 48h — survives restarts

export async function redisSetIndeedLastRun(data: IndeedRunData): Promise<void> {
  const r = getClient();
  if (!r) return;
  try {
    await r.set(INDEED_LAST_RUN_KEY, JSON.stringify(data), { ex: INDEED_TTL_SECONDS });
  } catch (err) {
    console.error('[redis] setIndeedLastRun failed:', (err as Error).message);
  }
}

export async function redisGetIndeedLastRun(): Promise<IndeedRunData | null> {
  const r = getClient();
  if (!r) return null;
  try {
    const raw = await r.get<string>(INDEED_LAST_RUN_KEY);
    if (!raw) return null;
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as IndeedRunData;
  } catch (err) {
    console.error('[redis] getIndeedLastRun failed:', (err as Error).message);
    return null;
  }
}

// --- Persistent run log (last 500 entries, stored as ZSET scored by timestamp ms) ---

export interface BotLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  tag: string;
  msg: string;
}

const LOG_KEY = 'bot:logs';
const LOG_MAX = 500;

export async function redisLog(level: BotLogEntry['level'], tag: string, msg: string): Promise<void> {
  const r = getClient();
  if (!r) return;
  const entry: BotLogEntry = { ts: new Date().toISOString(), level, tag, msg };
  const now = Date.now();
  try {
    type SM = { score: number; member: string };
    await r.zadd(LOG_KEY, { score: now, member: JSON.stringify(entry) } as SM);
    // Keep only the newest LOG_MAX entries
    await r.zremrangebyrank(LOG_KEY, 0, -(LOG_MAX + 1));
  } catch {
    // logging failures must never crash the bot
  }
}

export async function redisGetLogs(limit = 200): Promise<BotLogEntry[]> {
  const r = getClient();
  if (!r) return [];
  try {
    const members = await r.zrange(LOG_KEY, 0, -1);
    const all = members
      .map((m) => {
        try { return (typeof m === 'string' ? JSON.parse(m) : m) as BotLogEntry; }
        catch { return null; }
      })
      .filter((e): e is BotLogEntry => e !== null)
      .reverse(); // newest first
    return all.slice(0, limit);
  } catch {
    return [];
  }
}
