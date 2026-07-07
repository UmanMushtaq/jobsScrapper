import axios from 'axios';
import { EuresSource, EuresJv, mapJob, extractRequiredLanguages } from './eures.source';
import { evaluateLanguageRequirement } from '../language-requirement-filter';
import { SearchSettings } from '../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function buildJv(overrides: Partial<EuresJv> = {}): EuresJv {
  return {
    id: 'NjE5MjM0MCAxMjE',
    title: '(Medior/Senior) Node.js Backend Developer (Full-stack)',
    description: 'We use Node.js and TypeScript.<br>Great team.',
    creationDate: 1783315560441,
    lastModificationDate: 1783369560676,
    numberOfPosts: 1,
    locationMap: { LU: ['LU000'] },
    employer: { name: 'Acme Corp' },
    availableLanguages: ['en'],
    ...overrides,
  };
}

const FAR_FUTURE_CUTOFF = 0; // accepts anything with a real timestamp

describe('eures mapJob', () => {
  it('maps a record with locationMap {"LU": ["LU000"]} to countryCode "LU"', () => {
    const job = mapJob(buildJv(), FAR_FUTURE_CUTOFF);
    expect(job).not.toBeNull();
    expect(job?.countryCode).toBe('LU');
  });

  it('drops a record older than the cutoff', () => {
    const oldTimestamp = 1_000_000_000_000; // well in the past
    const job = mapJob(
      buildJv({ creationDate: oldTimestamp, lastModificationDate: oldTimestamp }),
      Date.now() - 24 * 60 * 60 * 1000, // cutoff: last 24h
    );
    expect(job).toBeNull();
  });

  it('strips HTML tags from the description', () => {
    const job = mapJob(
      buildJv({ description: 'Line one.<br>Line two.<p>Line three.</p>' }),
      FAR_FUTURE_CUTOFF,
    );
    expect(job?.description).not.toMatch(/<[^>]*>/);
    expect(job?.description).toContain('Line one.');
    expect(job?.description).toContain('Line two.');
    expect(job?.description).toContain('Line three.');
  });

  it('converts an epoch-millis date into a valid ISO publishedAt', () => {
    const job = mapJob(buildJv({ lastModificationDate: 1783369560676, creationDate: undefined }), FAR_FUTURE_CUTOFF);
    expect(job?.publishedAt).toBe(new Date(1783369560676).toISOString());
    expect(job?.publishedAtTimestamp).toBe(1783369560676);
  });
});

describe('eures requiredLanguages extraction', () => {
  it('extracts a Dutch B1 requirement from the `requiredLanguages` field shape onto the JobPosting', () => {
    const raw = buildJv({ requiredLanguages: [{ isoCode: 'nl', level: 'B1' }] });
    expect(extractRequiredLanguages(raw)).toEqual([{ code: 'nl', level: 'B1', required: undefined }]);
    // mapJob only extracts/attaches the field — the actual accept/reject decision is made
    // centrally in matcher.ts (evaluateLanguageRequirement), the same layer as the other
    // deterministic filters, so every source's jobs go through one rejection point.
    const job = mapJob(raw, FAR_FUTURE_CUTOFF);
    expect(job).not.toBeNull();
    expect(job?.requiredLanguages).toEqual([{ code: 'nl', level: 'B1', required: undefined }]);
    expect(evaluateLanguageRequirement(job?.requiredLanguages, job?.description ?? '').reject).toBe(true);
  });

  it('extracts languages from the `jvRequirements.languages` field shape', () => {
    const raw = buildJv({ jvRequirements: { languages: [{ code: 'de', level: 'B2', mandatory: true }] } });
    expect(extractRequiredLanguages(raw)).toEqual([{ code: 'de', level: 'B2', required: true }]);
  });

  it('accepts an English-only requirement', () => {
    const raw = buildJv({ requiredLanguages: [{ isoCode: 'en', level: 'B2' }] });
    const job = mapJob(raw, FAR_FUTURE_CUTOFF);
    expect(job).not.toBeNull();
    expect(job?.requiredLanguages).toEqual([{ code: 'en', level: 'B2', required: undefined }]);
  });

  it('accepts a record with no language field at all', () => {
    const raw = buildJv();
    expect(extractRequiredLanguages(raw)).toEqual([]);
    const job = mapJob(raw, FAR_FUTURE_CUTOFF);
    expect(job).not.toBeNull();
    expect(job?.requiredLanguages).toBeNull();
  });
});

describe('EuresSource.fetch — dedup across queries', () => {
  const settings: SearchSettings = {
    titles: [],
    queries: [],
    requiredKeywords: [],
    preferredKeywordGroups: [],
    experience: { min: 0, max: 10 },
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

  beforeEach(() => {
    jest.useFakeTimers();
    mockedAxios.post.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('dedupes the same jvProfileId returned by two different queries', async () => {
    const sharedJv = buildJv({ id: 'same-id-across-queries' });
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { numberRecords: 1, jvs: [sharedJv] },
    });

    const source = new EuresSource();
    const fetchPromise = source.fetch([], settings);
    // Flush every pending sleep(1500) between queries without a real wait.
    await jest.runAllTimersAsync();
    const jobs = await fetchPromise;

    const matching = jobs.filter((j) => j.canonicalUrl.includes(encodeURIComponent('same-id-across-queries')));
    expect(matching.length).toBe(1);
  });
});
