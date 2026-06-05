import { PreferenceModel, scorePreference } from './preference';
import { detectLanguage } from './sources/language-detect';
import { scoreLocation } from './sources/location-filter';
import { MatchResult, JobPosting, SearchProfile, ScoreBreakdown } from './types';

const BASE_REQUIRED_WEIGHTS = [
  {
    // NestJS and Express.js are Node.js-only frameworks — if they appear, Node.js is implied.
    matched: (text: string) => containsAny(text, ['node.js', 'nodejs', 'nestjs', 'nest.js', 'express.js']),
    weight: 24,
    reason: 'Node.js is explicitly required',
  },
  {
    matched: (text: string) => containsAny(text, ['typescript', 'javascript']),
    weight: 18,
    reason: 'TypeScript/JavaScript matches your backend stack',
  },
  {
    matched: (text: string) => containsAny(text, ['backend', 'back-end', 'api', 'rest', 'server-side', 'microservice']),
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

  // 42 = Node.js(24) + either TypeScript(18) or backend(18).
  // 36 (TypeScript + backend without Node.js) is no longer enough —
  // that pattern matches C#/.NET/Java full-stack jobs that mention TypeScript for their React frontend.
  if (mandatoryScore < 42) {
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
  const threshold = wordCount < 120 ? 58 : wordCount < 350 ? 65 : 70;

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
  if (detectedLanguage !== desiredLanguage) return false;

  // Some sources (WTTJ) mark bilingual jobs as 'en' even when the title is in another language.
  // If the job title contains accented characters strongly associated with French/German,
  // run a second language check on the title alone and reject if it doesn't match.
  if (/[àâéèêëîïôùûüçœæäöüß]/i.test(job.title)) {
    const titleLanguage = detectLanguage(job.title);
    if (titleLanguage !== desiredLanguage) return false;
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

function salaryMeetsMinimum(job: JobPosting, profile: SearchProfile): boolean {
  const monthlyEur = toMonthlyEur(job);
  if (monthlyEur === null) {
    return true;
  }

  return monthlyEur >= profile.search.minimumSalaryMonthlyEur;
}

function toMonthlyEur(job: JobPosting): number | null {
  const amount = job.salaryYearlyMinimum ?? job.salaryMinimum;
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

  if (job.salaryPeriod === 'monthly' || job.salaryPeriod === 'month') {
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

function buildCoverLetter(job: JobPosting, profile: SearchProfile, reasons: string[]): string {
  const reasonLine = reasons[0] ?? 'the backend ownership in the role';
  const locationLine =
    job.workMode === 'remote'
      ? 'Working from Paris, I can join your distributed team from day one.'
      : job.countryCode === 'FR'
        ? 'Based in Paris, I can join your team on-site without relocation.'
        : 'I am open to relocation within Europe and happy to work through the logistics.';

  return [
    `Hello ${job.company} team,`,
    '',
    `${reasonLine.charAt(0).toUpperCase() + reasonLine.slice(1)} is exactly what drew me to this role.`,
    '',
    `I am a Paris-based Node.js and NestJS backend engineer with ${profile.candidate.experienceYears} years of production experience. At OptimusFox I designed and delivered production microservices across fintech and crypto platforms for a cross-functional team of roughly ten engineers, integrating Stripe, PayPal, and blockchain APIs, Dockerizing backend services, and building GitHub Actions CI/CD pipelines from scratch. I am applying these architecture patterns in NexusPay, an event-driven fintech platform I am building with NestJS, RabbitMQ, Kafka, and Clean Architecture.`,
    '',
    `${locationLine} I would welcome the chance to discuss how my background fits this role.`,
    '',
    'Authorized to work in France (RECE permit, valid Oct 2026 — straightforward status change on contract signing).',
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
