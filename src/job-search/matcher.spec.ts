import { BORDERLINE_YEARS_TAG, evaluateExperienceRequirement, scoreJob } from './matcher';
import { LANGUAGE_UNCLEAR_TAG } from './language-requirement-filter';
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

  it('rejects a job requiring exactly 5 years (minimum >= 5)', () => {
    const result = scoreJob(
      buildJob({ experienceLevelMinimum: 5 }),
      profile,
    );

    expect(result).toBeNull();
  });

  it('rejects a job with no structured experienceLevelMinimum but "6 ans d\'expérience minimum" in the description', () => {
    // experienceLevelMinimum is null, so only the text scan in evaluateExperienceRequirement
    // can catch this.
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

describe('scoreJob — experience text parsing, real JD examples (minimum >= 5 rejects)', () => {
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

  it('rejects "5+ years"', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description: 'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. 5+ years of experience.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('rejects "5 à 10 ans" (French range, lower bound 5)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description: 'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. 5 à 10 ans d\'expérience.',
      }),
      profile,
    );
    expect(result).toBeNull();
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

  it('rejects "5+ years professional software engineering experience" (Avenga example)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ' +
          '5+ years professional software engineering experience.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('rejects "Deep Backend Expertise: 5+ years of commercial web development experience" (LionHires example)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ' +
          'Deep Backend Expertise: 5+ years of commercial web development experience.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('rejects "solide expérience de 5 ans minimum" (Dougs example, French, minimum after the number)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ' +
          'Vous justifiez d\'une solide expérience de 5 ans minimum.',
      }),
      profile,
    );
    expect(result).toBeNull();
  });

  it('rejects "minimum of 6 years experience required" (filler word between minimum and the number)', () => {
    const result = scoreJob(
      buildJob({
        experienceLevelMinimum: null,
        description:
          'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ' +
          'Minimum of 6 years experience required.',
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

describe('scoreJob — German internship/training title rejection (Germany-coverage pass, July 12 2026)', () => {
  // job_search_profile.json's excludedTitleKeywords list — real production config, not a
  // stand-in, since these keywords only matter in combination with the actual profile.
  const germanProfile: SearchProfile = {
    ...profile,
    search: {
      ...profile.search,
      excludedTitleKeywords: [
        'intern', 'internship', 'alternance', 'apprentice', 'apprenticeship',
        'student', 'staff', 'lead', 'principal', 'head of', 'manager',
        'praktikum', 'praktikant', 'ausbildung', 'duales studium', 'minijob', 'trainee',
      ],
    },
  };

  it.each([
    'Werkstudent Backend Entwicklung (m/w/d)',
    'Praktikant Softwareentwicklung',
    'Praktikum Backend Engineering',
    'Ausbildung zum Fachinformatiker',
    'Duales Studium Informatik',
    'Minijob Backend Support',
    'Trainee Software Engineering',
  ])('rejects title "%s"', (title) => {
    const result = scoreJob(buildJob({ title }), germanProfile);
    expect(result).toBeNull();
  });

  it('"Werkstudent" is caught via the existing "student" substring match, not a dedicated keyword', () => {
    expect('werkstudent'.includes('student')).toBe(true);
  });

  it('still accepts a regular backend title that happens to share no excluded substrings', () => {
    const result = scoreJob(buildJob({ title: 'Backend Entwickler (Node.js)' }), germanProfile);
    expect(result).not.toBeNull();
  });
});

describe('evaluateExperienceRequirement — one rule: minimum years >= 5 rejects', () => {
  it.each([
    // English
    ['5+ years of experience with Node.js', 5],
    ['At least 5 years of backend experience', 5],
    ['Minimum 5 years in a similar role', 5],
    ['Minimum of 6 years experience required', 6],
    ['Around 5+ years building APIs', 5],
    ['5-7 years of experience', 5],
    ['5 to 8 years in backend development', 5],
    // German
    ['Mindestens 5 Jahre Berufserfahrung', 5],
    ['5+ Jahre Erfahrung mit Node.js', 5],
    ['5 bis 7 Jahre Erfahrung', 5],
    // French
    ['5 ans minimum en développement backend', 5],
    ['Minimum 5 ans d\'expérience', 5],
    ['5 à 10 ans d\'expérience', 5],
    // Dutch
    ['5+ jaar ervaring met TypeScript', 5],
    ['Minimaal 6 jaar werkervaring', 6],
    // Swedish
    ['Minst 5 år som backendutvecklare', 5],
    // Danish
    ['Mindst 5 års erfaring med Node.js', 5],
    // Norwegian
    ['Minst 5 års erfaring som utvikler', 5],
    // Finnish
    ['Vähintään 5 vuotta kokemusta', 5],
    ['Vähintään 5 vuoden kokemus backend-kehityksestä', 5],
  ])('rejects "%s" (minimum %i)', (text, years) => {
    expect(evaluateExperienceRequirement(text)).toEqual({ decision: 'reject', minYears: years });
  });

  it.each([
    ['3-5 years of experience', 3],
    ['3 to 5 years of backend experience', 3],
    ['3 bis 5 Jahre Berufserfahrung', 3],
    ['3 à 5 ans d\'expérience', 3],
    ['3-5 jaar ervaring', 3],
    ['Minst 3 års erfarenhet', 3],
    ['Mindst 4 års erfaring', 4],
    ['Vähintään 3 vuoden kokemus', 3],
    ['4 years of experience with NestJS', 4],
  ])('keeps "%s" (range lower bound / minimum %i is below 5)', (text, years) => {
    expect(evaluateExperienceRequirement(text)).toEqual({ decision: 'keep', minYears: years });
  });

  it('never re-reads the upper bound of a range as its own requirement', () => {
    expect(evaluateExperienceRequirement('Experience: 2-5 years of experience with Node.js').decision).toBe('keep');
  });

  it('keeps a job with no years stated', () => {
    expect(evaluateExperienceRequirement('Solid Node.js and TypeScript experience.')).toEqual({ decision: 'keep', minYears: null });
  });

  it('does not reject a job asking fewer than 2 years', () => {
    expect(evaluateExperienceRequirement('1+ year of experience').decision).toBe('keep');
    expect(evaluateExperienceRequirement('', 0).decision).toBe('keep');
  });

  it('rejects when any non-soft requirement is >= 5, even alongside a lower one', () => {
    expect(evaluateExperienceRequirement('3+ years with NestJS. 5+ years of backend experience.').decision).toBe('reject');
  });

  it('rejects a structured minimum of 5 from the source', () => {
    expect(evaluateExperienceRequirement('', 5)).toEqual({ decision: 'reject', minYears: 5 });
  });

  it.each([
    'Ideally 5+ years of experience',
    'Preferably 5+ years of backend experience',
    'Nice to have: 5+ years with Kafka',
    'Nice-to-have:\n- 6+ years in fintech',
    '5+ years of experience preferred',
  ])('marks "%s" as borderline instead of rejecting', (text) => {
    expect(evaluateExperienceRequirement(text).decision).toBe('borderline');
  });

  it('a requirements heading after a nice-to-have list still rejects', () => {
    expect(evaluateExperienceRequirement('Nice to have: Kafka\nRequirements:\n- 5+ years of experience').decision).toBe('reject');
  });
});

describe('scoreJob — experience rule and title seniority', () => {
  const openProfile: SearchProfile = { ...profile, search: { ...profile.search, excludedTitleKeywords: [] } };
  const base = 'Node.js TypeScript backend API role with NestJS, PostgreSQL, Docker and AWS. ';

  it('keeps a borderline 5+ requirement and tags it "borderline-years"', () => {
    const result = scoreJob(
      buildJob({ experienceLevelMinimum: null, description: `${base}Ideally 5+ years of experience.` }),
      openProfile,
    );
    expect(result).not.toBeNull();
    expect(result?.reasons).toContain(BORDERLINE_YEARS_TAG);
    expect(result?.reasons[0]).not.toBe(BORDERLINE_YEARS_TAG);
  });

  it('does not tag a normal job', () => {
    const result = scoreJob(buildJob({ description: `${base}3-5 years of experience.` }), openProfile);
    expect(result).not.toBeNull();
    expect(result?.reasons).not.toContain(BORDERLINE_YEARS_TAG);
  });

  it('accepts a job asking for 1 year (no lower experience bound)', () => {
    expect(scoreJob(buildJob({ experienceLevelMinimum: 1 }), openProfile)).not.toBeNull();
  });

  it('rejects "5-7 years" via the range lower bound', () => {
    const result = scoreJob(
      buildJob({ experienceLevelMinimum: null, description: `${base}5-7 years of experience.` }),
      openProfile,
    );
    expect(result).toBeNull();
  });

  it.each([
    'Lead Backend Engineer',
    'Tech Lead Node.js',
    'Team Lead Backend',
    'Principal Software Engineer',
    'Staff Backend Engineer',
    'Head of Engineering',
    'Engineering Manager, Platform APIs',
    'Backend Architect',
  ])('rejects title "%s"', (title) => {
    expect(scoreJob(buildJob({ title }), openProfile)).toBeNull();
  });

  it.each(['Senior Backend Engineer', 'Senior Node.js Developer', 'Backend Engineer (Leading fintech)'])(
    'keeps title "%s"',
    (title) => {
      expect(scoreJob(buildJob({ title }), openProfile)).not.toBeNull();
    },
  );
});

describe('scoreJob — posting-language step', () => {
  const openProfile: SearchProfile = { ...profile, search: { ...profile.search, excludedTitleKeywords: [] } };
  const enBody =
    'We are looking for a backend engineer to join our team. You will build the APIs and microservices ' +
    'of our platform with Node.js, NestJS, TypeScript, PostgreSQL, Docker and AWS. You will work with the product team.';
  const frBody =
    'Nous recherchons un développeur backend pour rejoindre notre équipe. Vous serez en charge des API et des ' +
    'microservices avec Node.js, NestJS, TypeScript, PostgreSQL, Docker et AWS. Vous travaillerez avec les équipes produit.';

  it.each(['apec.fr', 'welcometothejungle.com', 'arbeitsagentur.de', 'francetravail.fr'])(
    'rejects a French posting with no English signal from trusted source %s',
    (source) => {
      expect(scoreJob(buildJob({ source, description: frBody }), openProfile)).toBeNull();
    },
  );

  it('keeps the same French posting once it mentions an international team', () => {
    const result = scoreJob(buildJob({ description: `${frBody} Vous rejoindrez une équipe internationale.` }), openProfile);
    expect(result).not.toBeNull();
  });

  it('rejects an English posting that requires fluent German', () => {
    expect(scoreJob(buildJob({ description: `${enBody} Fluent German is required.` }), openProfile)).toBeNull();
  });

  it('keeps an English posting without the language-unclear tag', () => {
    const result = scoreJob(buildJob({ description: enBody }), openProfile);
    expect(result).not.toBeNull();
    expect(result?.reasons).not.toContain(LANGUAGE_UNCLEAR_TAG);
  });

  it('keeps a posting whose language is unclear and tags it "language-unclear"', () => {
    const result = scoreJob(buildJob({ description: 'Node.js TypeScript NestJS PostgreSQL Docker AWS backend API.' }), openProfile);
    expect(result).not.toBeNull();
    expect(result?.reasons).toContain(LANGUAGE_UNCLEAR_TAG);
  });
});

describe('scoreJob — seniority titles in French and German', () => {
  const openProfile: SearchProfile = { ...profile, search: { ...profile.search, excludedTitleKeywords: [] } };

  it.each([
    'Architecte logiciel Node.js',
    'Architecte Backend (H/F)',
    'Software Architekt (m/w/d)',
    'Architektin Backend',
    'Lead Dev Node.js',
    'Tech Lead Backend',
    'Responsable technique backend',
  ])('rejects title "%s"', (title) => {
    expect(scoreJob(buildJob({ title }), openProfile)).toBeNull();
  });

  it.each([
    'Développeur Backend Node.js (architecture microservices)',
    'Backend Entwickler Softwarearchitektur',
    'Backend Engineer, Architectures distribuées',
    'Développeur Node.js, responsable de la qualité technique',
  ])('keeps title "%s" (no whole-word seniority match)', (title) => {
    expect(scoreJob(buildJob({ title }), openProfile)).not.toBeNull();
  });
});

describe('scoreJob — onReject reports the rule that rejected the job', () => {
  const openProfile: SearchProfile = { ...profile, search: { ...profile.search, excludedTitleKeywords: [] } };
  const reasonFor = (overrides: Partial<JobPosting>): string | null => {
    let reason: string | null = null;
    scoreJob(buildJob(overrides), openProfile, undefined, (r) => { reason = r; });
    return reason;
  };

  it.each([
    [{ title: 'Architecte logiciel' }, 'title-seniority'],
    [{ experienceLevelMinimum: 6 }, 'years>=5'],
    [{ description: 'Node.js TypeScript backend API role. Fluent German is required.' }, 'local-language-required'],
    [{ title: 'Frontend Engineer' }, 'role-excluded'],
  ] as Array<[Partial<JobPosting>, string]>)('%o → %s', (overrides, expected) => {
    expect(reasonFor(overrides)).toBe(expected);
  });

  it('is not called for an accepted job', () => {
    expect(reasonFor({})).toBeNull();
  });
});
