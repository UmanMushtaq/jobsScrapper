// greenhouse, lever and remotive: a missing or unreadable posting date gives a null date
// (never a crash), and one malformed job never fails the whole source.
import {
  fetchCompanyJobs as fetchGreenhouse,
  mapJob as mapGreenhouse,
} from './greenhouse.source';
import {
  fetchCompanyJobs as fetchLever,
  mapPosting as mapLever,
} from './lever.source';
import { fetchRemotive, mapJob as mapRemotive } from './remotive.source';
import { SearchSettings } from '../types';

const NOW = Date.UTC(2026, 9, 8, 12);
const RECENT_ISO = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
const SETTINGS = { maxAgeHours: 72 } as SearchSettings;
const DESC = 'Backend engineer, Node.js and TypeScript, remote in Europe.';

const greenhouseJob = (
  updated_at: unknown,
  extra: Record<string, unknown> = {},
) => ({
  id: 1,
  title: 'Backend Engineer',
  absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
  content: DESC,
  location: { name: 'Berlin, Germany' },
  updated_at,
  ...extra,
});
const leverPosting = (
  updatedAt: unknown,
  extra: Record<string, unknown> = {},
) => ({
  id: '1',
  text: 'Backend Engineer',
  hostedUrl: 'https://jobs.lever.co/acme/1',
  applyUrl: 'https://jobs.lever.co/acme/1/apply',
  descriptionPlain: DESC,
  categories: { location: 'Berlin, Germany' },
  updatedAt,
  ...extra,
});
const remotiveJob = (
  publication_date: unknown,
  extra: Record<string, unknown> = {},
) => ({
  id: 1,
  url: 'https://remotive.com/remote-jobs/1',
  title: 'Backend Engineer',
  company_name: 'Acme',
  description: DESC,
  candidate_required_location: 'Europe',
  publication_date,
  ...extra,
});

function mockFetchJson(body: unknown): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('posting date missing or unreadable → null date, no throw', () => {
  it.each([
    [
      'greenhouse, missing',
      () =>
        mapGreenhouse(
          greenhouseJob(undefined) as unknown as Parameters<
            typeof mapGreenhouse
          >[0],
          'acme',
        ),
    ],
    [
      'greenhouse, unreadable',
      () =>
        mapGreenhouse(
          greenhouseJob('not a date') as unknown as Parameters<
            typeof mapGreenhouse
          >[0],
          'acme',
        ),
    ],
    [
      'lever, missing',
      () =>
        mapLever(
          leverPosting(undefined) as unknown as Parameters<typeof mapLever>[0],
          'acme',
        ),
    ],
    [
      'lever, unreadable',
      () =>
        mapLever(
          leverPosting('garbage') as unknown as Parameters<typeof mapLever>[0],
          'acme',
        ),
    ],
    [
      'remotive, missing',
      () =>
        mapRemotive(
          remotiveJob(undefined) as unknown as Parameters<
            typeof mapRemotive
          >[0],
        ),
    ],
    [
      'remotive, unreadable',
      () =>
        mapRemotive(
          remotiveJob('soon') as unknown as Parameters<typeof mapRemotive>[0],
        ),
    ],
  ])('%s', (_label, map) => {
    const job = map();
    expect(job.publishedAt).toBeNull();
    expect(job.publishedAtTimestamp).toBeNull();
  });

  it('still reads a real date (greenhouse ISO, lever epoch ms, remotive ISO)', () => {
    const seconds = Math.floor(Date.parse(RECENT_ISO) / 1000);
    expect(
      mapGreenhouse(
        greenhouseJob(RECENT_ISO) as unknown as Parameters<
          typeof mapGreenhouse
        >[0],
        'acme',
      ).publishedAtTimestamp,
    ).toBe(seconds);
    expect(
      mapLever(
        leverPosting(Date.parse(RECENT_ISO)) as unknown as Parameters<
          typeof mapLever
        >[0],
        'acme',
      ).publishedAtTimestamp,
    ).toBe(seconds);
    expect(
      mapRemotive(
        remotiveJob(RECENT_ISO) as unknown as Parameters<typeof mapRemotive>[0],
      ).publishedAtTimestamp,
    ).toBe(seconds);
  });
});

describe('one bad job never fails the whole source', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('greenhouse: keeps the dated and the undated job, skips the malformed one', async () => {
    mockFetchJson({
      jobs: [
        greenhouseJob(RECENT_ISO),
        greenhouseJob(undefined, { id: 2 }),
        greenhouseJob(RECENT_ISO, { id: 3, location: undefined }),
      ],
    });
    const jobs = await fetchGreenhouse('acme', SETTINGS);
    expect(jobs.map((j) => j.publishedAtTimestamp === null)).toEqual([
      false,
      true,
    ]);
  });

  it('lever: keeps the dated and the undated posting, skips the malformed one', async () => {
    mockFetchJson([
      leverPosting(Date.parse(RECENT_ISO)),
      leverPosting(undefined, { id: '2' }),
      leverPosting(Date.parse(RECENT_ISO), {
        id: '3',
        categories: { location: 42 },
      }),
    ]);
    const jobs = await fetchLever('acme', SETTINGS);
    expect(jobs.map((j) => j.publishedAtTimestamp === null)).toEqual([
      false,
      true,
    ]);
  });

  it('remotive: keeps the dated and the undated job, skips the malformed one', async () => {
    mockFetchJson({
      jobs: [
        remotiveJob(RECENT_ISO),
        remotiveJob(undefined, { id: 2 }),
        remotiveJob(RECENT_ISO, { id: 3, company_name: null }),
      ],
    });
    const jobs = await fetchRemotive('node', SETTINGS);
    expect(jobs.map((j) => j.publishedAtTimestamp === null)).toEqual([
      false,
      true,
    ]);
  });
});
