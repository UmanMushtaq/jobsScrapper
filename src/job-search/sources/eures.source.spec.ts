import axios from 'axios';
import { EuresSource, EuresJv, mapJob, extractRequiredLanguages, extractExperienceMinimum, mapToEuresLocationCode } from './eures.source';
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

  it('truncates the description to the 500-char calibration-parity excerpt cap and flags descriptionPartial', () => {
    const longDescription = 'A'.repeat(2000);
    const job = mapJob(buildJv({ description: longDescription }), FAR_FUTURE_CUTOFF);
    expect(job?.description).toHaveLength(500);
    expect(job?.descriptionPartial).toBe(true);
  });

  it('does not pad a short description — only caps the upper bound', () => {
    const job = mapJob(buildJv({ description: 'Short JD.' }), FAR_FUTURE_CUTOFF);
    expect(job?.description).toBe('Short JD.');
    expect(job?.descriptionPartial).toBe(true);
  });
});

describe('mapToEuresLocationCode', () => {
  it('maps every code in Uman\'s target-country list to its lowercase EURES locationCode', () => {
    const expected: Record<string, string> = {
      FR: 'fr', DE: 'de', BE: 'be', NL: 'nl', LU: 'lu', IT: 'it', ES: 'es',
      SE: 'se', DK: 'dk', CZ: 'cz', IE: 'ie', HU: 'hu', PL: 'pl', FI: 'fi',
    };
    for (const [code, expectedLower] of Object.entries(expected)) {
      expect(mapToEuresLocationCode(code)).toBe(expectedLower);
    }
  });

  it('is case-insensitive', () => {
    expect(mapToEuresLocationCode('fr')).toBe('fr');
    expect(mapToEuresLocationCode('Fr')).toBe('fr');
  });

  it('maps Greece (GR), flagged in the July 13 2026 target-country discrepancy report', () => {
    expect(mapToEuresLocationCode('GR')).toBe('gr');
  });

  it('returns null and logs a warning for a country with no known EURES mapping, without throwing', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => mapToEuresLocationCode('XX')).not.toThrow();
    expect(mapToEuresLocationCode('XX')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no EURES locationCode mapping for country "XX"'));
    warnSpy.mockRestore();
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

describe('eures experienceLevelMinimum extraction (>5-year cap, Task 2)', () => {
  it('extracts 6 from a plausible structured experienceYears field — over the cap', () => {
    const raw = buildJv({ experienceYears: 6 });
    expect(extractExperienceMinimum(raw, raw.description ?? '')).toBe(6);
    const job = mapJob(raw, FAR_FUTURE_CUTOFF);
    expect(job?.experienceLevelMinimum).toBe(6);
    // matcher.ts's effectiveExperience check (experienceLevelMinimum > profile.search.experience.max)
    // is what actually rejects this — verified directly in matcher.spec.ts's experience-cap suite.
    expect((job?.experienceLevelMinimum ?? 0) > 5).toBe(true);
  });

  it('extracts 5 from a plausible structured experienceYears field — at the cap, not over it', () => {
    const raw = buildJv({ experienceYears: 5 });
    expect(extractExperienceMinimum(raw, raw.description ?? '')).toBe(5);
    const job = mapJob(raw, FAR_FUTURE_CUTOFF);
    expect(job?.experienceLevelMinimum).toBe(5);
    expect((job?.experienceLevelMinimum ?? 0) > 5).toBe(false);
  });

  it('falls back to text-parsing the description when no structured field is present', () => {
    const raw = buildJv({ description: 'Backend role. 7 Jahre Berufserfahrung erforderlich.' });
    const job = mapJob(raw, FAR_FUTURE_CUTOFF);
    expect(job?.experienceLevelMinimum).toBe(7);
  });

  it('leaves experienceLevelMinimum null when neither a structured field nor description wording is present (unaffected)', () => {
    const raw = buildJv();
    const job = mapJob(raw, FAR_FUTURE_CUTOFF);
    expect(job?.experienceLevelMinimum).toBeNull();
  });
});

describe('EuresSource.fetch — per-country search, dedup, and diagnostics', () => {
  function buildSettings(targetCountryCodes: string[]): SearchSettings {
    return {
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
      targetCountryCodes,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockedAxios.post.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('dedupes the same jvProfileId returned by two different queries within one country', async () => {
    const sharedJv = buildJv({ id: 'same-id-across-queries' });
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { numberRecords: 1, jvs: [sharedJv] },
    });

    const source = new EuresSource();
    const fetchPromise = source.fetch([], buildSettings(['LU']));
    // Flush every pending sleep(1500) between queries without a real wait.
    await jest.runAllTimersAsync();
    const jobs = await fetchPromise;

    const matching = jobs.filter((j) => j.canonicalUrl.includes(encodeURIComponent('same-id-across-queries')));
    expect(matching.length).toBe(1);
  });

  it('logs one [eures] country=<code> fetched=N passed_filters=M line per country, not one aggregate line', async () => {
    const jv = buildJv({ id: 'per-country-log-check' });
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { numberRecords: 1, jvs: [jv] },
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const source = new EuresSource();
    const fetchPromise = source.fetch([], buildSettings(['LU', 'NL']));
    await jest.runAllTimersAsync();
    await fetchPromise;

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /^\[eures\] country=LU fetched=\d+ passed_filters=\d+$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[eures\] country=NL fetched=\d+ passed_filters=\d+$/.test(l))).toBe(true);

    logSpy.mockRestore();
  });

  it('skips a target country with no EURES mapping (warns, does not throw, still processes the rest)', async () => {
    const jv = buildJv({ id: 'unmapped-country-check' });
    mockedAxios.post.mockResolvedValue({
      status: 200,
      data: { numberRecords: 1, jvs: [jv] },
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const source = new EuresSource();
    const fetchPromise = source.fetch([], buildSettings(['XX', 'LU']));
    await jest.runAllTimersAsync();
    const jobs = await fetchPromise;

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no EURES locationCode mapping for country "XX"'));
    expect(jobs.some((j) => j.canonicalUrl.includes(encodeURIComponent('unmapped-country-check')))).toBe(true);

    warnSpy.mockRestore();
  });

  it('uses only ENGLISH_KEYWORDS for a non-FR/DE country, but adds FRENCH_KEYWORDS for FR and GERMAN_KEYWORDS for DE', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200, data: { numberRecords: 0, jvs: [] } });

    const source = new EuresSource();
    const fetchPromise = source.fetch([], buildSettings(['LU', 'FR', 'DE']));
    await jest.runAllTimersAsync();
    await fetchPromise;

    const bodies = mockedAxios.post.mock.calls.map((c) => c[1] as { locationCodes: string[] });
    const luCalls = bodies.filter((b) => b.locationCodes[0] === 'lu').length;
    const frCalls = bodies.filter((b) => b.locationCodes[0] === 'fr').length;
    const deCalls = bodies.filter((b) => b.locationCodes[0] === 'de').length;

    expect(frCalls).toBeGreaterThan(luCalls);
    expect(deCalls).toBeGreaterThan(luCalls);
  });
});
