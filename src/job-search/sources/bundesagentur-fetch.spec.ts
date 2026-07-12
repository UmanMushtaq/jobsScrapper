import { BundesagenturJobsSource } from './bundesagentur.source';
import { SearchSettings } from '../types';

// Fixtures mirror the real Bundesagentur Jobsuche API response shape
// (rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/{v6,v4}/jobs) — a top-level
// `stellenangebote` array of job objects keyed by `refnr`/`titel`/`arbeitgeber`/
// `arbeitsort`. v6 and v4 share this response shape; they differ only in the request
// query parameters (v6: size/page, v4: maxErgebnisse) — see bundesagentur.source.ts.
function fixtureJob(overrides: Record<string, unknown> = {}) {
  return {
    refnr: '10000-1200345678-S',
    titel: 'Backend Entwickler (Node.js/TypeScript)',
    beruf: 'Softwareentwickler',
    arbeitgeber: 'Beispiel GmbH',
    arbeitsort: { ort: 'München', plz: '80331', land: 'Deutschland' },
    aktuelleVeroeffentlichungsdatum: new Date().toISOString(),
    arbeitszeitmodelle: ['Vollzeit'],
    externeUrl: null,
    ...overrides,
  };
}

const settings: SearchSettings = {
  titles: [],
  queries: [],
  requiredKeywords: [],
  preferredKeywordGroups: [],
  experience: { min: 0, max: 5 },
  minimumSalaryMonthlyEur: 0,
  language: 'en',
  maxResults: 50,
  maxAgeHours: 24 * 365,
  checkIntervalHours: 8,
  willingToRelocate: true,
  preferredCountries: [],
  acceptRemote: true,
  acceptHybrid: true,
  acceptOnSite: true,
  usaJobs: false,
  startupJobs: true,
  startupPrioritySources: [],
  excludedCountries: [],
  europeCountryCodes: [],
  usaCountryCodes: [],
  relocationKeywords: [],
  excludedTitleKeywords: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('BundesagenturJobsSource — v6/v4 response-shape handling (registry audit, July 12 2026)', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  it('uses v6 results directly when v6 returns a populated stellenangebote array', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/pc/v6/jobs')) {
        return jsonResponse(200, { stellenangebote: [fixtureJob()], maxErgebnisse: 1 });
      }
      if (url.includes('/pc/v4/jobs')) {
        throw new Error('v4 should not be called when v6 succeeds with results');
      }
      // detail endpoint
      return jsonResponse(404, {});
    });

    const source = new BundesagenturJobsSource();
    const fetchPromise = source.fetch([], settings);
    await jest.runAllTimersAsync();
    const jobs = await fetchPromise;

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].company).toBe('Beispiel GmbH');
    expect(jobs[0].city).toBe('München');
    const v4Calls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/pc/v4/jobs'));
    expect(v4Calls.length).toBe(0);
  });

  it('falls back to v4 when v6 returns 200 with an EMPTY stellenangebote array (the exact silent-zero-results bug)', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/pc/v6/jobs')) {
        // Simulates v6 silently accepting the request but returning nothing — e.g. because
        // of an unrecognized/wrong parameter name, the actual bug found in this audit.
        return jsonResponse(200, { stellenangebote: [], maxErgebnisse: 0 });
      }
      if (url.includes('/pc/v4/jobs')) {
        return jsonResponse(200, { stellenangebote: [fixtureJob()], maxErgebnisse: 1 });
      }
      return jsonResponse(404, {});
    });

    const source = new BundesagenturJobsSource();
    const fetchPromise = source.fetch([], settings);
    await jest.runAllTimersAsync();
    const jobs = await fetchPromise;

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].company).toBe('Beispiel GmbH');
    const v4Calls = fetchSpy.mock.calls.filter(([u]) => String(u).includes('/pc/v4/jobs'));
    expect(v4Calls.length).toBeGreaterThan(0);
  });

  it('falls back to v4 when v6 throws a network error', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/pc/v6/jobs')) {
        throw new Error('network error');
      }
      if (url.includes('/pc/v4/jobs')) {
        return jsonResponse(200, { stellenangebote: [fixtureJob()], maxErgebnisse: 1 });
      }
      return jsonResponse(404, {});
    });

    const source = new BundesagenturJobsSource();
    const fetchPromise = source.fetch([], settings);
    await jest.runAllTimersAsync();
    const jobs = await fetchPromise;

    expect(jobs.length).toBeGreaterThan(0);
  });

  it('sends the X-API-Key header with the exact documented value on both v6 and v4 calls', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(200, { stellenangebote: [] }));

    const source = new BundesagenturJobsSource();
    const fetchPromise = source.fetch([], settings);
    await jest.runAllTimersAsync();
    await fetchPromise;

    for (const [, init] of fetchSpy.mock.calls) {
      const headers = (init as { headers?: Record<string, string> })?.headers ?? {};
      expect(headers['X-API-Key']).toBe('jobboerse-jobsuche');
    }
  });

  it('uses distinct v6 (size/page) vs v4 (maxErgebnisse) query parameter names', async () => {
    const calledUrls: string[] = [];
    fetchSpy.mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (url.includes('/pc/v6/jobs')) return jsonResponse(200, { stellenangebote: [] });
      return jsonResponse(200, { stellenangebote: [fixtureJob()] });
    });

    const source = new BundesagenturJobsSource();
    const fetchPromise = source.fetch([], settings);
    await jest.runAllTimersAsync();
    await fetchPromise;

    const v6Url = calledUrls.find((u) => u.includes('/pc/v6/jobs'));
    const v4Url = calledUrls.find((u) => u.includes('/pc/v4/jobs'));
    expect(v6Url).toContain('size=');
    expect(v6Url).toContain('page=');
    expect(v6Url).not.toContain('maxErgebnisse=');
    expect(v4Url).toContain('maxErgebnisse=');
  });

  it('returns [] and logs a blocked message on 403 without throwing', async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('/pc/v6/jobs')) return jsonResponse(200, { stellenangebote: [] });
      if (url.includes('/pc/v4/jobs')) return jsonResponse(403, {});
      return jsonResponse(404, {});
    });

    const source = new BundesagenturJobsSource();
    const fetchPromise = source.fetch([], settings);
    await jest.runAllTimersAsync();
    const jobs = await fetchPromise;
    expect(jobs).toEqual([]);
  });
});
