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

  it('rejects a remote job requiring residency in the Netherlands', () => {
    expect(parseRemoteScope('Remote', 'You must be based in the Netherlands for this role.')).toBe('restricted-single-country');
  });

  it('rejects "Poland residents only"', () => {
    expect(parseRemoteScope('Remote', 'Poland residents only, fully distributed team.')).toBe('restricted-single-country');
  });

  it('rejects "you must be located in Italy"', () => {
    expect(parseRemoteScope('Remote', 'You must be located in Italy to apply.')).toBe('restricted-single-country');
  });

  it('rejects "candidates must reside in Germany"', () => {
    expect(parseRemoteScope('Remote', 'Candidates must reside in Germany.')).toBe('restricted-single-country');
  });

  it('accepts "anywhere in the EU"', () => {
    expect(parseRemoteScope('Remote', 'Open to candidates anywhere in the EU.')).toBe('eu-ok');
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

describe('scoreLocation — country-residency restriction applies to remote only', () => {
  const settingsWithNlIt: SearchSettings = {
    ...baseSettings,
    europeCountryCodes: ['FR', 'DE', 'NL', 'IT'],
  };

  it('rejects a remote job requiring residency in the Netherlands', () => {
    const result = scoreLocation(null, null, 'remote', false, settingsWithNlIt, 'Remote', 'You must be based in the Netherlands.');
    expect(result.isAcceptable).toBe(false);
  });

  it('accepts a remote job open to anywhere in the EU', () => {
    const result = scoreLocation(null, null, 'remote', false, settingsWithNlIt, 'Remote', 'Open to candidates anywhere in the EU.');
    expect(result.isAcceptable).toBe(true);
  });

  it('accepts a remote job with no location restriction stated', () => {
    const result = scoreLocation(null, null, 'remote', false, settingsWithNlIt, 'Remote', 'Join our backend team.');
    expect(result.isAcceptable).toBe(true);
  });

  it('accepts an on-site Amsterdam job even though it requires residency in the Netherlands', () => {
    // offersRelocation:true because NL is not in the hardcoded TARGET_RELOCATION_COUNTRIES
    // list — this isolates the assertion to "the residency-requirement text does not
    // itself cause rejection for on-site roles", independent of that unrelated rule.
    const result = scoreLocation('NL', 'Amsterdam', 'on-site', true, settingsWithNlIt, 'Amsterdam, Netherlands', 'You must be based in the Netherlands.');
    expect(result.isAcceptable).toBe(true);
  });

  it('accepts a hybrid Milan job even though it states "Italy residents preferred"', () => {
    const result = scoreLocation('IT', 'Milan', 'hybrid', false, settingsWithNlIt, 'Milan, Italy', 'Italy residents preferred.');
    expect(result.isAcceptable).toBe(true);
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

describe('scoreLocation — countryTiers', () => {
  // preferredCountries cleared so FR lands on the "Europe hybrid" scoring path
  // instead of the flat 100 "preferred country" path — otherwise the +15 boost
  // would be invisible under the 100-point cap in this test.
  const tierSettings: SearchSettings = {
    ...baseSettings,
    preferredCountries: [],
    europeCountryCodes: ['FR', 'PL', 'NL', 'LU', 'DE', 'SE', 'IT', 'BE'],
    countryTiers: { tier1: ['FR'], tier2: ['PL', 'NL', 'LU'], tier3: ['DE', 'SE', 'IT'] },
  };

  it('adds +15 and "[tier1 country]" for France', () => {
    const result = scoreLocation('FR', 'Paris', 'hybrid', true, tierSettings, 'Paris, France');
    expect(result.isAcceptable).toBe(true);
    expect(result.score).toBe(95); // 80 (Europe hybrid + relocation) + 15
    expect(result.reason).toContain('[tier1 country]');
  });

  it('adds +10 and "[tier2 country]" for Poland', () => {
    const result = scoreLocation('PL', 'Warsaw', 'hybrid', false, tierSettings, 'Warsaw, Poland');
    expect(result.isAcceptable).toBe(true);
    expect(result.score).toBe(80); // 70 (target country hybrid) + 10
    expect(result.reason).toContain('[tier2 country]');
  });

  it('adds +5 and "[tier3 country]" for Sweden', () => {
    const result = scoreLocation('SE', 'Stockholm', 'hybrid', false, tierSettings, 'Stockholm, Sweden');
    expect(result.isAcceptable).toBe(true);
    expect(result.score).toBe(75); // 70 (target country hybrid) + 5
    expect(result.reason).toContain('[tier3 country]');
  });

  it('does not boost an acceptable country outside any tier', () => {
    const result = scoreLocation('BE', 'Brussels', 'hybrid', true, tierSettings, 'Brussels, Belgium');
    expect(result.isAcceptable).toBe(true);
    expect(result.score).toBe(80); // Europe hybrid + relocation, no tier match
    expect(result.reason).not.toMatch(/\[tier\d country\]/);
  });

  it('does not boost a rejected job', () => {
    const result = scoreLocation('RO', null, 'on-site', false, tierSettings, 'Bucharest, Romania');
    expect(result.isAcceptable).toBe(false);
    expect(result.reason).not.toMatch(/\[tier\d country\]/);
  });
});

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
