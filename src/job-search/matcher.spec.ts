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
    startupPrioritySources: ['wellfound.com', 'startup.jobs', 'welcometothejungle.com'],
    excludedCountries: ['RO'],
    europeCountryCodes: ['FR', 'DE'],
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
});

