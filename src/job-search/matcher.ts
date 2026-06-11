import { PreferenceModel, scorePreference } from './preference';
import { resolveWorkAuth } from './profile';
import { detectLanguage, hasEnglishTeamSignals } from './sources/language-detect';
import { scoreLocation } from './sources/location-filter';
import { MatchResult, JobPosting, SearchProfile, ScoreBreakdown } from './types';

const BASE_REQUIRED_WEIGHTS = [
  {
    // NestJS and Express.js are Node.js-only frameworks — if they appear, Node.js is implied.
    matched: (text: string) => containsAny(text, ['node.js', 'nodejs', 'express.js']),
    weight: 24,
    reason: 'Node.js is explicitly required',
  },
  {
    // NestJS as a standalone signal — jobs mentioning only NestJS without "Node.js" still pass
    matched: (text: string) => containsAny(text, ['nestjs', 'nest.js']),
    weight: 24,
    reason: 'NestJS is explicitly required',
  },
  {
    matched: (text: string) => containsAny(text, ['typescript', 'javascript']),
    weight: 18,
    reason: 'TypeScript/JavaScript matches your backend stack',
  },
  {
    matched: (text: string) => containsAny(text, ['backend', 'back-end', 'api', 'rest', 'server-side', 'microservice', 'server']),
    weight: 18,
    reason: 'The role is centered on backend and API work',
  },
];

export function scoreJob(
  job: JobPosting,
  profile: SearchProfile,
  prefModel?: PreferenceModel,
): MatchResult | null {
  const normalizedTitle = job.title.toLowerCase();
  const text = [job.title, job.description, job.companySummary, ...job.keyMissions]
    .join(' ')
    .toLowerCase();

  if (!isLanguageFit(job, profile, text)) {
    return null;
  }

  if (profile.search.excludedTitleKeywords.some((keyword) => normalizedTitle.includes(keyword))) {
    return null;
  }

  const EXCLUDED_ROLE_KEYWORDS = [
    // Frontend (including .js variants and React Native that simple string match misses)
    'frontend', 'front-end', 'front end',
    'ui developer', 'ui engineer', 'ux developer', 'ux engineer',
    'react developer', 'react.js', 'react native',
    'vue developer', 'vue.js',
    'angular developer',
    'flutter', 'ios developer', 'android developer', 'mobile developer',
    // AI / ML / Data — not the backend profile
    'ai engineer', 'ml engineer', 'machine learning engineer', 'machine learning developer',
    'data engineer', 'data scientist', 'data analyst', 'nlp engineer', 'llm engineer',
    'prompt engineer', 'computer vision engineer',
    // AI specialist compound titles — "ai backend engineer", "mcp engineer", etc.
    // 'ai engineer' above only matches exact substring; these catch split patterns.
    'mcp engineer', 'ai backend', 'ai infrastructure', 'mlops', 'ml ops',
    'generative ai', 'genai engineer',
    // DevOps / Infra
    'devops engineer', 'site reliability engineer', 'site reliability', 'sre engineer', 'sre',
    'infrastructure engineer', 'platform engineer', 'cloud engineer',
    // Customer-facing / pre-sales / non-build roles that mention Node.js only in passing.
    // These are NOT backend engineering jobs even though the description lists Node.js as a
    // stack the customer might use (e.g. Sentry "Solutions Engineer").
    'solutions engineer', 'solution engineer', 'sales engineer', 'pre-sales', 'presales',
    'solutions architect', 'solutions consultant', 'implementation engineer', 'implementation consultant',
    'customer success', 'success engineer', 'support engineer', 'technical support',
    'developer advocate', 'developer relations', 'devrel', 'technical account manager',
    'technical advisor', 'field engineer', 'evangelist', 'sales development', 'account executive',
  ];
  if (EXCLUDED_ROLE_KEYWORDS.some((keyword) => normalizedTitle.includes(keyword))) {
    return null;
  }

  // Safety net for sources (e.g. HackerNews) where the title field may be location/work-mode
  // metadata rather than the actual role name. When the title contains no role indicator,
  // also check the first line of the description.
  if (!/\b(?:engineer|developer|architect|programmer|scientist|analyst|designer|lead)\b/i.test(job.title)) {
    const firstDescLine = (job.description.split('\n')[0] ?? '').toLowerCase();
    if (EXCLUDED_ROLE_KEYWORDS.some((keyword) => firstDescLine.includes(keyword))) {
      return null;
    }
  }

  const locationScore = scoreLocation(
    job.countryCode,
    job.city,
    job.workMode,
    job.offersRelocation,
    profile.search,
  );
  if (!locationScore.isAcceptable) {
    return null;
  }

  const effectiveExperience =
    job.experienceLevelMinimum !== null
      ? job.experienceLevelMinimum
      : inferExperienceFromText(text);

  if (effectiveExperience !== null) {
    if (
      effectiveExperience < profile.search.experience.min ||
      effectiveExperience > profile.search.experience.max
    ) {
      return null;
    }
  }

  if (!salaryMeetsMinimum(job, profile)) {
    return null;
  }

  const mandatoryScore = BASE_REQUIRED_WEIGHTS.reduce((sum, check) => {
    return sum + (check.matched(text) ? check.weight : 0);
  }, 0);

  // 36 = TypeScript(18) + backend(18) — enough to pass without Node.js.
  // The nonJsRequiredPattern check below handles the false-positive case where
  // TypeScript is only used for a React frontend while Java/C# is the required backend.
  if (mandatoryScore < 36) {
    return null;
  }

  // Reject jobs where a non-JS backend language is explicitly required and Node.js is absent.
  // Catches "Experience with C# is required" / "Java is required" etc. when Node.js never appears.
  const hasNodeJs = containsAny(text, ['node.js', 'nodejs', 'nestjs', 'nest.js', 'express.js']);
  if (!hasNodeJs) {
    const nonJsRequiredPattern = /\b(?:c#|\.net|java(?!script)|golang|go\s+lang|ruby|php|kotlin|scala)\b.{0,60}(?:required|is\s+a\s+must|mandatory|must\s+have)/i;
    const requiredNonJs = nonJsRequiredPattern.test(text);
    if (requiredNonJs) {
      return null;
    }
  }

  const matchedReasons = BASE_REQUIRED_WEIGHTS.filter((check) => check.matched(text)).map(
    (check) => check.reason,
  );

  const requiredKeywordMatches = countKeywordMatches(text, profile.search.requiredKeywords);
  const preferredGroupScore = profile.search.preferredKeywordGroups.reduce((sum, group) => {
    return sum + (group.some((keyword) => text.includes(keyword.toLowerCase())) ? 6 : 0);
  }, 0);

  const titleScore =
    profile.search.titles.some((title) => normalizedTitle.includes(title.toLowerCase())) ||
    containsAny(normalizedTitle, ['backend', 'node', 'typescript'])
      ? 8
      : 0;

  const startupScore = computeStartupScore(job, text, profile);
  // Boost jobs where the employer mentions visa sponsorship or relocation support.
  // These are the minority of postings that can actually proceed with a non-EU hire.
  const SPONSOR_SIGNALS = [
    'visa sponsor', 'visa sponsorship', 'sponsorship provided', 'can sponsor', 'we sponsor',
    'work permit', 'relocation support', 'relocation assistance', 'relocation package',
    'relocation bonus', 'non-eu welcome', 'non-eu candidates', 'open to sponsoring',
    'willing to sponsor', 'support visa', 'immigration support', 'we support relocation',
  ];
  const hasSponsorSignal = job.offersRelocation || SPONSOR_SIGNALS.some((s) => text.includes(s));
  const sponsorScore = hasSponsorSignal ? 6 : 0;

  const kwScore = Math.min(requiredKeywordMatches * 3, 18);
  const locScore = Math.round(locationScore.score / 10);
  const keywordsTotal = kwScore + preferredGroupScore + titleScore;

  // Layer 1 learning: nudge the score by what you've Applied to / Dismissed before.
  const preference = prefModel ? scorePreference(prefModel, job) : { delta: 0, reasons: [] };

  const score = Math.max(
    0,
    Math.min(
      100,
      mandatoryScore + kwScore + preferredGroupScore + titleScore + locScore + startupScore + sponsorScore + preference.delta,
    ),
  );

  // Adaptive threshold based on description length:
  // Short descriptions can't physically contain many keywords — don't penalise them for it.
  const wordCount = job.description.trim().split(/\s+/).length;
  const threshold = wordCount < 120 ? 55 : wordCount < 350 ? 57 : 60;

  if (score < threshold) {
    return null;
  }

  const scoreBreakdown: ScoreBreakdown = {
    mandatory: mandatoryScore,
    keywords: keywordsTotal,
    location: locScore,
    startup: startupScore,
    sponsor: sponsorScore,
    preference: preference.delta,
  };

  const salaryLabel = buildSalaryLabel(job);
  const reasons = [
    ...matchedReasons,
    ...preference.reasons,
    ...(hasSponsorSignal ? ['Visa/relocation support mentioned in posting'] : []),
    `Location fit: ${locationScore.reason}`,
    ...buildPreferredReasons(text, profile),
  ].slice(0, 5);

  return {
    job: {
      ...job,
      startupSignals: buildStartupSignals(job, text),
    },
    score,
    scoreBreakdown,
    reasons,
    startupScore,
    salaryLabel,
    coverLetter: buildCoverLetter(job, profile, reasons),
    shortAnswers: buildShortAnswers(job, reasons),
  };
}

function isLanguageFit(job: JobPosting, profile: SearchProfile, text: string): boolean {
  const desiredLanguage = profile.search.language.toLowerCase();
  const detectedLanguage = job.language ? job.language.toLowerCase() : detectLanguage(text);
  const isPreferredCountry = profile.search.preferredCountries?.includes(job.countryCode ?? '');

  if (detectedLanguage !== desiredLanguage) {
    // Allow non-English jobs that explicitly signal an English-speaking team
    if (hasEnglishTeamSignals(text)) return true;
    // Allow jobs from preferred countries — candidate lives there and can work in local language
    if (isPreferredCountry) return true;
    return false;
  }

  // Language matches desired — secondary title check catches WTTJ-style jobs that are labelled
  // 'en' but have a French/German title (accented characters are a strong non-English signal).
  if (/[àâéèêëîïôùûüçœæäöüß]/i.test(job.title)) {
    const titleLanguage = detectLanguage(job.title);
    if (titleLanguage !== desiredLanguage && !isPreferredCountry) return false;
  }

  return true;
}

function inferExperienceFromText(text: string): number | null {
  // "5+ years" — treat as exactly the stated number (companies routinely inflate requirements)
  const plusMatch = text.match(/(\d+)\+\s*years?/i);
  if (plusMatch) {
    return parseInt(plusMatch[1], 10);
  }

  // "5 to 10 years" or "5-10 years" — use the lower bound of the range
  const rangeMatch = text.match(/(\d+)\s*(?:to|-)\s*\d+\s+years?/i);
  if (rangeMatch) {
    return parseInt(rangeMatch[1], 10);
  }

  const patterns: RegExp[] = [
    /(?:minimum|at\s+least|min\.?)\s+(\d+)\s+years?/i,
    /(\d+)\s+years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
    /experience\s*(?:of\s+)?(\d+)\s+years?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}



function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function countKeywordMatches(text: string, keywords: string[]): number {
  return keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
}

function buildPreferredReasons(text: string, profile: SearchProfile): string[] {
  const reasons: string[] = [];

  if (containsAny(text, ['nestjs', 'express'])) {
    reasons.push('Framework fit: NestJS/Express overlap is strong');
  }

  if (containsAny(text, ['postgresql', 'postgres', 'sequelize', 'mongodb', 'mongoose'])) {
    reasons.push('Database layer aligns with your production experience');
  }

  if (containsAny(text, ['docker', 'container', 'ci/cd', 'microservices', 'aws'])) {
    reasons.push('Delivery and architecture stack matches your recent work');
  }

  return reasons;
}

function computeStartupScore(job: JobPosting, text: string, profile: SearchProfile): number {
  let score = 0;
  const companyText = `${job.companySummary} ${text}`.toLowerCase();
  const sourceName = job.source.toLowerCase();

  if (job.isStartup) {
    score += 8;
  }

  if (
    profile.search.startupPrioritySources.some((source) => sourceName.includes(source.replace(/^https?:\/\//, '').toLowerCase()))
  ) {
    score += 6;
  }

  if (containsAny(companyText, ['startup', 'seed', 'series a', 'early-stage', 'founding', 'venture'])) {
    score += 8;
  }

  if (job.employeeCount !== null && job.employeeCount !== undefined && job.employeeCount <= 300) {
    score += 5;
  }

  if (
    job.companyCreationYear !== null &&
    job.companyCreationYear !== undefined &&
    job.companyCreationYear >= new Date().getUTCFullYear() - 10
  ) {
    score += 3;
  }

  return score;
}

function buildStartupSignals(job: JobPosting, text: string): string[] {
  const signals = new Set<string>();
  const companyText = `${job.companySummary} ${text}`.toLowerCase();

  if (job.isStartup) {
    signals.add('startup-flag');
  }
  if (containsAny(companyText, ['startup', 'seed', 'series a', 'early-stage'])) {
    signals.add('startup-language');
  }
  if (job.employeeCount !== null && job.employeeCount !== undefined && job.employeeCount <= 300) {
    signals.add('small-team');
  }
  if (job.companyCreationYear && job.companyCreationYear >= new Date().getUTCFullYear() - 10) {
    signals.add('recent-company');
  }

  return Array.from(signals);
}

export function salaryMeetsMinimum(job: JobPosting, profile: SearchProfile): boolean {
  const monthlyEur = toMonthlyEur(job);
  if (monthlyEur === null) {
    return true;
  }

  return monthlyEur >= profile.search.minimumSalaryMonthlyEur;
}

function toMonthlyEur(job: JobPosting): number | null {
  // Prefer explicit yearly minimum; fall back to salaryMinimum + period
  const useYearly = job.salaryYearlyMinimum !== null && job.salaryYearlyMinimum !== undefined;
  const amount = useYearly ? job.salaryYearlyMinimum! : job.salaryMinimum;
  if (amount === null || amount === undefined) {
    return null;
  }

  const exchangeRates: Record<string, number> = {
    EUR: 1,
    USD: 0.88,
    GBP: 1.16,
    CHF: 1.04,
  };

  const currency = (job.salaryCurrency ?? 'EUR').toUpperCase();
  const exchangeRate = exchangeRates[currency];
  if (!exchangeRate) {
    return null;
  }

  // salaryYearlyMinimum is always annual; otherwise use salaryPeriod to decide
  const isMonthly = !useYearly && (job.salaryPeriod === 'monthly' || job.salaryPeriod === 'month');
  if (isMonthly) {
    return amount * exchangeRate;
  }

  return Math.round((amount * exchangeRate) / 12);
}

function buildSalaryLabel(job: JobPosting): string {
  const monthlyEur = toMonthlyEur(job);
  if (monthlyEur === null) {
    return 'salary not listed';
  }

  return `~EUR ${monthlyEur}/month`;
}

function buildCoverLetter(job: JobPosting, profile: SearchProfile, _reasons: string[]): string {
  const isParisArea = /paris|île-de-france|idf/i.test(job.locationLabel ?? '');
  const locationLine =
    job.workMode === 'remote'
      ? 'Working from Paris, I can join your distributed team from day one.'
      : job.countryCode === 'FR'
        ? isParisArea
          ? 'Based in Paris, I can join your team on-site without relocation.'
          : 'I am based in Paris and fully open to relocating within France for this role.'
        : 'I am open to relocation within Europe and happy to work through the logistics.';
  const { statusLine } = resolveWorkAuth(profile);

  return [
    `Hello ${job.company} team,`,
    '',
    `I am a Paris-based Node.js and NestJS backend engineer with ${profile.candidate.experienceYears}+ years of production experience. The ${job.title} role at ${job.company} is a strong match for my background in backend microservices, TypeScript engineering, and fintech platforms.`,
    '',
    `At OptimusFox I designed and delivered production NestJS and TypeScript microservices across fintech and crypto platforms, working in a cross-functional team of roughly ten engineers. I integrated Stripe, PayPal, and blockchain APIs, Dockerized all backend services, and built GitHub Actions CI/CD pipelines from scratch. I am applying the same patterns in NexusPay, an event-driven fintech platform I am building with NestJS, RabbitMQ, Kafka, and Clean Architecture.`,
    '',
    `${locationLine} I would welcome the chance to discuss how my background fits this role.`,
    '',
    statusLine,
    '',
    'Best regards,',
    profile.candidate.name,
  ].join('\n');
}

function buildShortAnswers(job: JobPosting, reasons: string[]): string[] {
  return [
    `Why this role: ${reasons[0] ?? 'It closely matches my Node.js and TypeScript backend experience.'}`,
    `Why this company: ${job.company} looks like a strong fit for product-minded backend work in Europe.`,
  ];
}
