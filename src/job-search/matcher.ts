import { scoreLocation } from './sources/location-filter';
import { MatchResult, JobPosting, SearchProfile } from './types';

const BASE_REQUIRED_WEIGHTS = [
  {
    matched: (text: string) => containsAny(text, ['node.js', 'nodejs']),
    weight: 24,
    reason: 'Node.js is explicitly required',
  },
  {
    matched: (text: string) => containsAny(text, ['typescript', 'javascript']),
    weight: 18,
    reason: 'TypeScript/JavaScript matches your backend stack',
  },
  {
    matched: (text: string) => containsAny(text, ['backend', 'back-end', 'api', 'rest']),
    weight: 18,
    reason: 'The role is centered on backend and API work',
  },
];

export function scoreJob(job: JobPosting, profile: SearchProfile): MatchResult | null {
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

  if (job.experienceLevelMinimum !== null) {
    if (
      job.experienceLevelMinimum < profile.search.experience.min ||
      job.experienceLevelMinimum > profile.search.experience.max
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

  if (mandatoryScore < 50) {
    return null;
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
  const score = Math.min(
    100,
    mandatoryScore +
      Math.min(requiredKeywordMatches * 3, 18) +
      preferredGroupScore +
      titleScore +
      Math.round(locationScore.score / 10) +
      startupScore,
  );

  if (score < 90) {
    return null;
  }

  const salaryLabel = buildSalaryLabel(job);
  const reasons = [
    ...matchedReasons,
    `Location fit: ${locationScore.reason}`,
    ...buildPreferredReasons(text, profile),
  ].slice(0, 5);

  return {
    job: {
      ...job,
      startupSignals: buildStartupSignals(job, text),
    },
    score,
    reasons,
    startupScore,
    salaryLabel,
    coverLetter: buildCoverLetter(job, profile, reasons),
    shortAnswers: buildShortAnswers(job, reasons),
  };
}

function isLanguageFit(job: JobPosting, profile: SearchProfile, text: string): boolean {
  const desiredLanguage = profile.search.language.toLowerCase();

  if (job.language) {
    return job.language.toLowerCase() === desiredLanguage;
  }

  return inferEnglishText(text);
}

function inferEnglishText(text: string): boolean {
  const frenchSignals = ['bonjour', 'developpeur', 'ingenieur', 'rejoignez', 'teletravail', 'expérience'];
  return frenchSignals.filter((token) => text.includes(token)).length === 0;
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

  return [
    `Hello ${job.company} team,`,
    '',
    `I am a Paris-based backend engineer with about ${profile.candidate.experienceYears} years of hands-on experience building Node.js and TypeScript systems in production.`,
    `What stood out to me here is ${reasonLine.toLowerCase()}, along with the overlap around APIs, data-intensive backend work, and product ownership.`,
    `My recent work has included REST APIs, PostgreSQL and MongoDB, Dockerized deployments, and backend services for fintech-style platforms where performance and reliability mattered every day.`,
    `I would be glad to bring that same practical backend ownership to ${job.company} and contribute quickly in an English-speaking team.`,
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
