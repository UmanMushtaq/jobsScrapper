import { AdzunaJobsSource } from './adzuna.source';
import { SearchSettings } from '../types';

describe('AdzunaJobsSource.fetch — missing API credentials no-op', () => {
  const settings: SearchSettings = {
    titles: [],
    queries: ['node.js backend'],
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

  const originalAppId = process.env.ADZUNA_APP_ID;
  const originalAppKey = process.env.ADZUNA_APP_KEY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    if (originalAppId === undefined) delete process.env.ADZUNA_APP_ID;
    else process.env.ADZUNA_APP_ID = originalAppId;
    if (originalAppKey === undefined) delete process.env.ADZUNA_APP_KEY;
    else process.env.ADZUNA_APP_KEY = originalAppKey;
    fetchSpy.mockRestore();
  });

  it('returns an empty array and makes no network call when ADZUNA_APP_ID/ADZUNA_APP_KEY are unset', async () => {
    const source = new AdzunaJobsSource();
    const jobs = await source.fetch(['node.js backend'], settings);
    expect(jobs).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes no network call with only one of the two keys set', async () => {
    process.env.ADZUNA_APP_ID = 'some-id';
    const source = new AdzunaJobsSource();
    const jobs = await source.fetch(['node.js backend'], settings);
    expect(jobs).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
