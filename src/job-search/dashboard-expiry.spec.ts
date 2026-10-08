// In-memory stand-in for the Upstash client: just the calls the dashboard store uses.
const store = new Map<string, { value: string; ex?: number }>();
const index = new Map<string, number>();

class MockRedis {
  set(
    key: string,
    value: string,
    opts: { nx?: boolean; ex?: number } = {},
  ): Promise<'OK' | null> {
    if (opts.nx && store.has(key)) return Promise.resolve(null);
    store.set(key, { value, ex: opts.ex });
    return Promise.resolve('OK');
  }
  zadd(
    _key: string,
    _opts: unknown,
    { score, member }: { score: number; member: string },
  ): Promise<number> {
    if (index.has(member)) return Promise.resolve(0);
    index.set(member, score);
    return Promise.resolve(1);
  }
  zrange(
    _key: string,
    min: number,
    max: number,
    opts?: { byScore?: boolean },
  ): Promise<string[]> {
    const sorted = [...index.entries()].sort((a, b) => a[1] - b[1]);
    if (opts?.byScore)
      return Promise.resolve(
        sorted.filter(([, s]) => s >= min && s <= max).map(([m]) => m),
      );
    return Promise.resolve(sorted.map(([m]) => m));
  }
  zremrangebyscore(_key: string, min: number, max: number): Promise<number> {
    let n = 0;
    for (const [m, s] of index)
      if (s >= min && s <= max) {
        index.delete(m);
        n++;
      }
    return Promise.resolve(n);
  }
  zrem(_key: string, ...members: string[]): Promise<number> {
    members.forEach((m) => index.delete(m));
    return Promise.resolve(members.length);
  }
  mget(...keys: string[]): Promise<Array<string | null>> {
    return Promise.resolve(keys.map((k) => store.get(k)?.value ?? null));
  }
  del(...keys: string[]): Promise<number> {
    keys.forEach((k) => store.delete(k));
    return Promise.resolve(keys.length);
  }
  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const pipe = {
      set: (k: string, v: string, o: { nx?: boolean; ex?: number }) => {
        ops.push(() => this.set(k, v, o));
        return pipe;
      },
      zadd: (k: string, o: unknown, sm: { score: number; member: string }) => {
        ops.push(() => this.zadd(k, o, sm));
        return pipe;
      },
      exec: async () => {
        const out: unknown[] = [];
        for (const op of ops) out.push(await op());
        return out;
      },
    };
    return pipe;
  }
}

jest.mock('@upstash/redis', () => ({ Redis: MockRedis }));

import { renderExpiryBadge } from '../app.service';
import {
  dashboardExpiresAt,
  dashboardTtlSeconds,
  redisGetDashboardJobs,
  redisSaveDashboardJobBatch,
} from './redis-store';

const HOUR = 60 * 60 * 1000;
const parseCard = (raw: string): { expiresAt: number } =>
  JSON.parse(raw) as { expiresAt: number };
const NOW = Date.UTC(2026, 9, 8, 12);
const card = (title: string, postedMsAgo: number | null) => ({
  job: {
    title,
    company: 'Acme',
    publishedAtTimestamp:
      postedMsAgo === null ? null : (NOW - postedMsAgo) / 1000,
  },
});

beforeAll(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
});

beforeEach(() => {
  store.clear();
  index.clear();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('dashboardExpiresAt — the earlier of foundAt + 72h and posted + 72h', () => {
  it('dated job posted 70h ago expires in about 2h', () => {
    expect(dashboardExpiresAt(NOW, (NOW - 70 * HOUR) / 1000)).toBe(
      NOW + 2 * HOUR,
    );
  });

  it('dated job posted 10h ago expires at posted + 72h', () => {
    expect(dashboardExpiresAt(NOW, (NOW - 10 * HOUR) / 1000)).toBe(
      NOW - 10 * HOUR + 72 * HOUR,
    );
  });

  it('undated job expires at foundAt + 72h', () => {
    expect(dashboardExpiresAt(NOW, null)).toBe(NOW + 72 * HOUR);
  });

  it('a job posted after it was found still never outlives foundAt + 72h', () => {
    expect(dashboardExpiresAt(NOW - 5 * HOUR, (NOW - 2 * HOUR) / 1000)).toBe(
      NOW - 5 * HOUR + 72 * HOUR,
    );
  });

  it('dashboardTtlSeconds counts whole seconds to the deadline, at least 1', () => {
    expect(dashboardTtlSeconds(NOW + 2 * HOUR, NOW)).toBe(2 * 60 * 60);
    expect(dashboardTtlSeconds(NOW - HOUR, NOW)).toBe(1);
  });
});

describe('saving dashboard cards', () => {
  it('sets expiresAt and the Redis TTL from the earlier deadline', async () => {
    await redisSaveDashboardJobBatch([
      {
        jobId: 'posted70h',
        match: card('Posted 70h ago', 70 * HOUR),
        foundAt: NOW,
      },
      {
        jobId: 'posted10h',
        match: card('Posted 10h ago', 10 * HOUR),
        foundAt: NOW,
      },
      { jobId: 'undated', match: card('Undated', null), foundAt: NOW },
    ]);

    const saved = (id: string) => store.get(`dashboard:job:${id}`);
    expect(saved('posted70h')?.ex).toBe(2 * 60 * 60);
    expect(parseCard(saved('posted70h')!.value).expiresAt).toBe(NOW + 2 * HOUR);
    expect(saved('posted10h')?.ex).toBe(62 * 60 * 60);
    expect(parseCard(saved('posted10h')!.value).expiresAt).toBe(
      NOW + 62 * HOUR,
    );
    expect(saved('undated')?.ex).toBe(72 * 60 * 60);
    expect(parseCard(saved('undated')!.value).expiresAt).toBe(NOW + 72 * HOUR);
  });

  it('does not save a job already older than 72h', async () => {
    await redisSaveDashboardJobBatch([
      {
        jobId: 'stale',
        match: card('Posted 80h ago', 80 * HOUR),
        foundAt: NOW,
      },
    ]);
    expect(store.has('dashboard:job:stale')).toBe(false);
    expect(index.has('stale')).toBe(false);
  });
});

describe('reading dashboard cards', () => {
  it('returns live cards with their expiresAt', async () => {
    await redisSaveDashboardJobBatch([
      {
        jobId: 'posted10h',
        match: card('Posted 10h ago', 10 * HOUR),
        foundAt: NOW,
      },
    ]);
    const [entry] = await redisGetDashboardJobs();
    expect(entry.jobId).toBe('posted10h');
    expect(entry.expiresAt).toBe(NOW + 62 * HOUR);
  });

  it('removes a card saved before this change once its posting date is more than 72h old', async () => {
    // Old-format card: no expiresAt, no Redis TTL, found 10h ago, posted 75h ago.
    store.set('dashboard:job:legacy', {
      value: JSON.stringify({
        jobId: 'legacy',
        foundAt: NOW - 10 * HOUR,
        match: card('Legacy', 75 * HOUR),
      }),
    });
    index.set('legacy', NOW - 10 * HOUR);
    store.set('dashboard:job:legacy-fresh', {
      value: JSON.stringify({
        jobId: 'legacy-fresh',
        foundAt: NOW - 10 * HOUR,
        match: card('Legacy fresh', 20 * HOUR),
      }),
    });
    index.set('legacy-fresh', NOW - 10 * HOUR);

    const entries = await redisGetDashboardJobs();
    expect(entries.map((e) => e.jobId)).toEqual(['legacy-fresh']);
    expect(entries[0].expiresAt).toBe(NOW + 52 * HOUR);
    expect(store.has('dashboard:job:legacy')).toBe(false);
    expect(index.has('legacy')).toBe(false);
  });

  it('drops a card once its stored expiresAt passes', async () => {
    await redisSaveDashboardJobBatch([
      {
        jobId: 'posted70h',
        match: card('Posted 70h ago', 70 * HOUR),
        foundAt: NOW,
      },
    ]);
    jest.setSystemTime(NOW + 2 * HOUR + 1000);
    expect(await redisGetDashboardJobs()).toEqual([]);
    expect(index.has('posted70h')).toBe(false);
  });
});

describe('renderExpiryBadge', () => {
  it('shows "expires in Xh" instead of the old 48h+ badge', () => {
    expect(renderExpiryBadge(NOW + 62 * HOUR, NOW).badge).toContain(
      'expires in 62h',
    );
    expect(renderExpiryBadge(NOW + 62 * HOUR, NOW).rowStyle).toBe('');
  });

  it('highlights the last 12 hours, and shows <1h at the end', () => {
    const soon = renderExpiryBadge(NOW + 2 * HOUR, NOW);
    expect(soon.badge).toContain('expires in 2h');
    expect(soon.badge).toContain('badge-warning');
    expect(soon.rowStyle).toContain('border-left');
    expect(renderExpiryBadge(NOW + 20 * 60 * 1000, NOW).badge).toContain(
      'expires in &lt;1h',
    );
  });

  it('shows nothing without an expiresAt (file-only mode)', () => {
    expect(renderExpiryBadge(undefined, NOW)).toEqual({
      badge: '',
      rowStyle: '',
    });
  });
});
