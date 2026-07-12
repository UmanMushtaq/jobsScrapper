import { JoobleJobsSource, JoobleResult, mapJob } from './jooble.source';
import { SearchSettings } from '../types';

function buildRaw(overrides: Partial<JoobleResult> = {}): JoobleResult {
  return {
    title: 'Backend Developer (Node.js)',
    link: 'https://jooble.org/desc/123456',
    company: 'Acme GmbH',
    location: 'Berlin, Germany',
    snippet: 'We are looking for a Node.js backend developer with TypeScript experience to join our growing team in Berlin.',
    updated: new Date().toISOString(),
    ...overrides,
  };
}

describe('jooble mapJob', () => {
  it('maps a well-formed result to a JobPosting', () => {
    const job = mapJob(buildRaw());
    expect(job).not.toBeNull();
    expect(job?.source).toBe('jooble.org');
    expect(job?.canonicalUrl).toBe('https://jooble.org/desc/123456');
    expect(job?.company).toBe('Acme GmbH');
  });

  it('returns null when title is missing', () => {
    expect(mapJob(buildRaw({ title: undefined }))).toBeNull();
  });

  it('returns null when link is missing', () => {
    expect(mapJob(buildRaw({ link: undefined }))).toBeNull();
  });

  it('flags descriptionPartial true for a short snippet', () => {
    const job = mapJob(buildRaw({ snippet: 'Short snippet.' }));
    expect(job?.descriptionPartial).toBe(true);
  });

  it('flags descriptionPartial false for a long snippet', () => {
    const job = mapJob(buildRaw({
      snippet: 'A'.repeat(200) + ' Node.js TypeScript backend role with lots of detail about the responsibilities and requirements for this position.',
    }));
    expect(job?.descriptionPartial).toBe(false);
  });

  it('strips HTML tags from the snippet', () => {
    const job = mapJob(buildRaw({ snippet: 'Line one.<br>Line two.<p>Line three.</p>' }));
    expect(job?.description).not.toMatch(/<[^>]*>/);
    expect(job?.description).toContain('Line one.');
  });

  it('defaults countryCode to DE when location cannot be inferred', () => {
    const job = mapJob(buildRaw({ location: 'Somewhere Unrecognizable' }));
    expect(job?.countryCode).toBe('DE');
  });
});

describe('JoobleJobsSource.fetch — missing API key no-op', () => {
  const settings: SearchSettings = {
    titles: [],
    queries: [],
    requiredKeywords: [],
    preferredKeywordGroups: [],
    experience: { min: 0, max: 5 },
    minimumSalaryMonthlyEur: 0,
    language: 'en',
    maxResults: 50,
    maxAgeHours: 24 * 7,
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

  const originalKey = process.env.JOOBLE_API_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.JOOBLE_API_KEY;
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.JOOBLE_API_KEY;
    else process.env.JOOBLE_API_KEY = originalKey;
    fetchSpy.mockRestore();
  });

  it('returns an empty array and makes no network call when JOOBLE_API_KEY is unset', async () => {
    const source = new JoobleJobsSource();
    const jobs = await source.fetch([], settings);
    expect(jobs).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
