import { scoreJob } from './matcher';
import { SearchProfile, JobPosting } from './types';

const profile: SearchProfile = {
  candidate: {
    name: 'Uman Mushtaq',
    location: 'Paris, France',
    summary: 'Backend engineer',
    coreSkills: ['Node.js', 'TypeScript', 'PostgreSQL'],
    experienceYears: 4,
  },
  search: {
    titles: ['Backend Engineer', 'Node.js Developer'],
    queries: ['Node.js backend'],
    requiredKeywords: ['node.js', 'typescript', 'backend', 'api'],
    preferredKeywordGroups: [['nestjs'], ['postgresql'], ['docker'], ['aws']],
    experience: {
      min: 3,
      max: 5,
    },
    minimumSalaryMonthlyEur: 3000,
    language: 'en',
    maxResults: 15,
    maxAgeHours: 24,
    checkIntervalHours: 1,
    seenTtlHours: 1,
    willingToRelocate: true,
    preferredCountries: ['FR'],
    acceptRemote: true,
    acceptHybrid: true,
    acceptOnSite: true,
    usaJobs: false,
    startupJobs: true,
    startupPrioritySources: ['wellfound.com', 'startup.jobs', 'welcometothejungle.com'],
    excludedCountries: ['RO'],
    europeCountryCodes: ['FR', 'DE'],
    usaCountryCodes: ['US'],
    relocationKeywords: ['relocation', 'visa sponsorship'],
    excludedTitleKeywords: ['senior', 'lead'],
  },
};

function buildJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    source: 'welcometothejungle.com',
    sourcePriority: 3,
    canonicalUrl: 'https://example.com/job',
    title: 'Backend Engineer',
    company: 'Example',
    companySummary: 'Startup building SaaS workflows.',
    companySlug: 'example',
    locationLabel: 'Paris, France',
    countryCode: 'FR',
    city: 'Paris',
    workMode: 'hybrid',
    language: 'en',
    description:
      'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS in a product startup.',
    keyMissions: ['Build backend APIs'],
    experienceLevelMinimum: 4,
    salaryCurrency: 'EUR',
    salaryPeriod: 'yearly',
    salaryMinimum: 48000,
    salaryMaximum: 60000,
    salaryYearlyMinimum: 48000,
    publishedAt: '2026-04-11T08:00:00Z',
    publishedAtTimestamp: 1775894400,
    startupSignals: [],
    applyUrl: 'https://example.com/job',
    offersRelocation: false,
    isStartup: true,
    ...overrides,
  };
}

describe('scoreJob', () => {
  it('accepts a strong backend match', () => {
    const result = scoreJob(buildJob(), profile);
    expect(result).not.toBeNull();
    expect(result?.score).toBeGreaterThanOrEqual(90);
  });

  it('rejects senior roles outside the target level', () => {
    const result = scoreJob(
      buildJob({
        title: 'Senior Backend Engineer',
        experienceLevelMinimum: 7,
      }),
      profile,
    );

    expect(result).toBeNull();
  });

  it('rejects a job requiring 6 years (above the 5-year hard cap)', () => {
    const result = scoreJob(
      buildJob({ experienceLevelMinimum: 6 }),
      profile,
    );

    expect(result).toBeNull();
  });

  it('accepts a job requiring exactly 5 years (at the hard cap)', () => {
    const result = scoreJob(
      buildJob({ experienceLevelMinimum: 5 }),
      profile,
    );

    expect(result).not.toBeNull();
  });

  it('rejects a job with no structured experienceLevelMinimum but "6 ans d\'expérience minimum" in the description', () => {
    // experienceLevelMinimum is null so the numeric pre-filter can't catch this — only the
    // text-scan hard reject in detectExperiencePenalty can. This is the exact bypass that
    // used to only apply a soft -10 penalty instead of a hard reject.
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. 6 ans d\'expérience minimum requis.',
      }),
      profile,
    );

    expect(result).toBeNull();
  });

  it('adds a +5 fintech-domain boost for a payments-platform JD', () => {
    const result = scoreJob(
      buildJob({
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS in a product startup. ' +
          'You will build our payments platform, including wallet balances and KYC checks for onboarding.',
      }),
      profile,
    );

    expect(result).not.toBeNull();
    expect(result?.scoreBreakdown?.fintech).toBe(5);
    expect(result?.reasons).toContain('[fintech domain]');
  });

  it('does not add a fintech-domain boost for an unrelated e-commerce JD', () => {
    const result = scoreJob(
      buildJob({
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS in a product startup. ' +
          'You will build our e-commerce storefront, shopping cart, and inventory management system.',
      }),
      profile,
    );

    expect(result).not.toBeNull();
    expect(result?.scoreBreakdown?.fintech).toBeUndefined();
    expect(result?.reasons).not.toContain('[fintech domain]');
  });
});

describe('scoreJob — language requirement filter', () => {
  it('rejects a job requiring Dutch at B1', () => {
    const result = scoreJob(
      buildJob({ requiredLanguages: [{ code: 'nl', level: 'B1' }] }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('accepts a job requiring only English at B2', () => {
    const result = scoreJob(
      buildJob({ requiredLanguages: [{ code: 'en', level: 'B2' }] }),
      profile,
    );
    expect(result).not.toBeNull();
  });

  it('accepts a job with no requiredLanguages field at all', () => {
    const result = scoreJob(buildJob({ requiredLanguages: undefined }), profile);
    expect(result).not.toBeNull();
  });

  it('accepts a French-language JD with no stated French requirement', () => {
    const result = scoreJob(
      buildJob({
        description:
          'Nous recherchons un développeur backend Node.js et TypeScript avec NestJS, PostgreSQL, Docker et AWS. ' +
          'Équipe internationale travaillant en anglais.',
      }),
      profile,
    );
    expect(result).not.toBeNull();
  });

  it('rejects a job whose description states French is required', () => {
    const result = scoreJob(
      buildJob({
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. French required for client calls.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });
});

describe('scoreJob — rejected-companies blocklist (Rule 1)', () => {
  it('rejects a job from a blocklisted company on the first match', () => {
    const result = scoreJob(buildJob({ company: 'Dashlane' }), profile);
    expect(result).toBeNull();
  });

  it('rejects a blocklisted company even with a corporate suffix and different casing', () => {
    const result = scoreJob(buildJob({ company: 'SWILE SAS' }), profile);
    expect(result).toBeNull();
  });

  it('accepts a job from a non-blocklisted company', () => {
    const result = scoreJob(buildJob({ company: 'Acme Corp' }), profile);
    expect(result).not.toBeNull();
  });
});

describe('scoreJob — experience-cap text parsing, EN/FR/DE (Rule 3)', () => {
  it('rejects "Around 6+ years of experience" (Air Apps example)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. Around 6+ years of experience required.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('accepts "5+ years"', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description: 'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. 5+ years of experience.',
      }),
      profile,
    );
    expect(result).not.toBeNull();
  });

  it('accepts "5 à 10 ans" (French range, lower bound 5)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description: 'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. 5 à 10 ans d\'expérience.',
      }),
      profile,
    );
    expect(result).not.toBeNull();
  });

  it('rejects "7 Jahre Berufserfahrung" (German)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description: 'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. 7 Jahre Berufserfahrung.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });
});

describe('scoreJob — no-AI-in-applications policy (Rule 5)', () => {
  it('rejects a job with an Air-Apps-style AI-application disclaimer', () => {
    const result = scoreJob(
      buildJob({
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ' +
          'Please submit your application without any AI-generated assistance.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('accepts a job that merely mentions using AI tools on the job', () => {
    const result = scoreJob(
      buildJob({
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ' +
          "You'll use AI tools daily to speed up your workflow.",
      }),
      profile,
    );
    expect(result).not.toBeNull();
  });
});

describe('scoreJob — GTM/marketing-engineering role-type mismatch (Rule 6)', () => {
  it('rejects "GTM MarTech Engineer (Growth & Attribution)" (Vidalytics example)', () => {
    const result = scoreJob(
      buildJob({
        title: 'GTM MarTech Engineer (Growth & Attribution)',
        description: 'Node.js backend role building marketing growth infrastructure.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('accepts a backend role that merely lists one HubSpot integration', () => {
    const result = scoreJob(
      buildJob({
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ' +
          'You will also maintain a small HubSpot integration for the sales team.',
      }),
      profile,
    );
    expect(result).not.toBeNull();
  });
});
