import { parseRemoteScope, scoreLocation } from './location-filter';
import { mapJob as mapHimalayasJob, HimalayasJob } from './himalayas.source';
import { SearchSettings } from '../types';

const baseSettings: SearchSettings = {
  titles: ['Backend Engineer'],
  queries: ['Node.js backend'],
  requiredKeywords: ['node.js', 'typescript', 'backend', 'api'],
  preferredKeywordGroups: [['nestjs']],
  experience: { min: 3, max: 5 },
  minimumSalaryMonthlyEur: 3000,
  language: 'en',
  maxResults: 15,
  maxAgeHours: 24,
  checkIntervalHours: 1,
  willingToRelocate: true,
  preferredCountries: ['FR'],
  acceptRemote: true,
  acceptHybrid: true,
  acceptOnSite: true,
  usaJobs: false,
  startupJobs: true,
  startupPrioritySources: [],
  excludedCountries: ['RO'],
  europeCountryCodes: ['FR', 'DE'],
  usaCountryCodes: ['US'],
  relocationKeywords: ['relocation', 'visa sponsorship'],
  excludedTitleKeywords: ['senior', 'lead'],
};

describe('parseRemoteScope', () => {
  it('rejects "Remote (US/CA)"', () => {
    expect(parseRemoteScope('Remote (US/CA)', '')).toBe('restricted-non-eu');
  });

  it('rejects "REMOTE (US or LATAM; must overlap with US Pacific hours)"', () => {
    expect(parseRemoteScope('REMOTE (US or LATAM; must overlap with US Pacific hours)', '')).toBe('restricted-non-eu');
  });

  it('rejects "United States (Remote)"', () => {
    expect(parseRemoteScope('United States (Remote)', '')).toBe('restricted-non-eu');
  });

  it('accepts "Remote (Global)"', () => {
    expect(parseRemoteScope('Remote (Global)', '')).toBe('eu-ok');
  });

  it('accepts "Remote EMEA"', () => {
    expect(parseRemoteScope('Remote EMEA', '')).toBe('eu-ok');
  });

  it('treats bare "Remote" with nothing else as unknown (acceptable)', () => {
    expect(parseRemoteScope('Remote', '')).toBe('unknown');
  });
});

describe('scoreLocation — remote branch', () => {
  it('rejects a US/CA-restricted remote job', () => {
    const result = scoreLocation(null, null, 'remote', false, baseSettings, 'Remote (US/CA)');
    expect(result.isAcceptable).toBe(false);
    expect(result.priority).toBe('rejected');
  });

  it('rejects a US-or-LATAM remote job with US Pacific hours overlap', () => {
    const result = scoreLocation(
      null,
      null,
      'remote',
      false,
      baseSettings,
      'REMOTE (US or LATAM; must overlap with US Pacific hours)',
    );
    expect(result.isAcceptable).toBe(false);
  });

  it('accepts a global remote job', () => {
    const result = scoreLocation(null, null, 'remote', false, baseSettings, 'Remote (Global)');
    expect(result.isAcceptable).toBe(true);
    expect(result.score).toBe(95);
  });

  it('accepts a location-silent remote job as acceptable, not rejected', () => {
    const result = scoreLocation(null, null, 'remote', false, baseSettings, 'Remote');
    expect(result.isAcceptable).toBe(true);
    expect(result.score).toBe(85);
  });
});

function buildHimalayasJob(overrides: Partial<HimalayasJob> = {}): HimalayasJob {
  return {
    guid: 'abc123',
    title: 'Backend Engineer',
    companyName: 'Acme',
    applicationLink: 'https://example.com/apply',
    description: 'Node.js TypeScript backend API role',
    pubDate: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('himalayas mapJob — locationRestrictions', () => {
  it('drops a job restricted to Argentina', () => {
    const job = mapHimalayasJob(buildHimalayasJob({ locationRestrictions: ['Argentina'] }));
    expect(job).toBeNull();
  });

  it('keeps a job restricted to Germany and France', () => {
    const job = mapHimalayasJob(buildHimalayasJob({ locationRestrictions: ['Germany', 'France'] }));
    expect(job).not.toBeNull();
  });

  it('keeps a job with no locationRestrictions', () => {
    const job = mapHimalayasJob(buildHimalayasJob({ locationRestrictions: [] }));
    expect(job).not.toBeNull();
  });
});
