import { PreferenceModel, scorePreference } from './preference';
import { resolveWorkAuth } from './profile';
import { detectLanguage, hasEnglishTeamSignals } from './sources/language-detect';
import { scoreLocation } from './sources/location-filter';
import { MatchResult, JobPosting, SearchProfile, ScoreBreakdown } from './types';

// Multilingual equivalents — all lowercased for use with .includes() on a lowercased text string.
// Node.js variants (EN / FR / DE / NL)
const NODE_VARIANTS = ['node.js', 'nodejs', 'node js', 'node.js', 'express.js', 'expressjs'];
// NestJS variants
const NEST_VARIANTS = ['nestjs', 'nest.js', 'nest js'];
// TypeScript variants + abbreviation
const TS_VARIANTS = ['typescript', 'type script', ' ts '];
// Backend role terms (FR)
const BACKEND_FR = [
  'développeur backend', 'ingénieur backend',
  'développeur back-end', 'ingénieur back-end',
  'développeur node', 'ingénieur node',
  'développeur logiciel', 'ingénieur logiciel',
];
// Backend role terms (DE)
const BACKEND_DE = [
  'backend-entwickler', 'softwareentwickler',
  'node entwickler', 'entwickler node', 'backend entwickler',
];
// Backend role terms (NL)
const BACKEND_NL = [
  'backend ontwikkelaar', 'software ontwikkelaar', 'node ontwikkelaar',
];
// Fullstack — accepted as valid target role
const FULLSTACK_VARIANTS = [
  'fullstack', 'full-stack', 'full stack',
  'développeur fullstack', 'ingénieur fullstack', 'fullstack entwickler',
];

const BASE_REQUIRED_WEIGHTS = [
  {
    // NestJS and Express.js are Node.js-only frameworks — if they appear, Node.js is implied.
    matched: (text: string) => containsAny(text, [...NODE_VARIANTS, ...NEST_VARIANTS]),
    weight: 24,
    reason: 'Node.js is explicitly required',
  },
  {
    // NestJS as a standalone signal — jobs mentioning only NestJS without "Node.js" still pass
    matched: (text: string) => containsAny(text, NEST_VARIANTS),
    weight: 26,
    reason: 'NestJS is explicitly required',
  },
  {
    matched: (text: string) => containsAny(text, [...TS_VARIANTS, 'javascript']),
    weight: 18,
    reason: 'TypeScript/JavaScript matches your backend stack',
  },
  {
    matched: (text: string) => containsAny(text, [
      'backend', 'back-end', 'api', 'rest', 'server-side', 'microservice', 'server',
      ...BACKEND_FR, ...BACKEND_DE, ...BACKEND_NL, ...FULLSTACK_VARIANTS,
    ]),
    weight: 18,
    reason: 'The role is centered on backend and API work',
  },
];

// Group-based keyword filter (replaces hard mandatoryScore threshold).
// A job passes if it matches Group A alone OR (Group B AND Group C).
const KEYWORD_GROUP_A = [...NODE_VARIANTS, ...NEST_VARIANTS, ...FULLSTACK_VARIANTS];
const KEYWORD_GROUP_B = [...TS_VARIANTS];
const KEYWORD_GROUP_C = [
  'backend', 'back-end', 'back end', 'server-side', 'api development', 'microservices', 'rest api', 'graphql',
  ...BACKEND_FR, ...BACKEND_DE, ...BACKEND_NL,
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

  const isApec = job.source === 'apec.fr';

  if (!isLanguageFit(job, profile, text)) {
    if (isApec) console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: langFilter (detected: ${job.language ?? 'unknown'})`);
    return null;
  }

  const matchedTitleExcl = profile.search.excludedTitleKeywords.find((keyword) => normalizedTitle.includes(keyword));
  if (matchedTitleExcl) {
    if (isApec) console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: titleExcl (matched: "${matchedTitleExcl}")`);
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
  const matchedRoleExcl = EXCLUDED_ROLE_KEYWORDS.find((keyword) => normalizedTitle.includes(keyword));
  if (matchedRoleExcl) {
    if (isApec) console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: roleExcl (matched: "${matchedRoleExcl}")`);
    return null;
  }

  // Safety net for sources (e.g. HackerNews) where the title field may be location/work-mode
  // metadata rather than the actual role name. When the title contains no role indicator,
  // also check the first line of the description.
  if (!/\b(?:engineer|developer|architect|programmer|scientist|analyst|designer|lead)\b/i.test(job.title)) {
    const firstDescLine = (job.description.split('\n')[0] ?? '').toLowerCase();
    const matchedDescRoleExcl = EXCLUDED_ROLE_KEYWORDS.find((keyword) => firstDescLine.includes(keyword));
    if (matchedDescRoleExcl) {
      if (isApec) console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: roleExcl/desc (matched: "${matchedDescRoleExcl}")`);
      return null;
    }
  }

  // Hard reject: desktop / Electron app roles — not relevant to backend API profile
  const ELECTRON_DESKTOP_SIGNALS = ['desktop app', 'native app', 'macos api', 'windows api', 'screencapturekit', 'cgeventtap', 'win32'];
  if (text.includes('electron') && ELECTRON_DESKTOP_SIGNALS.some((s) => text.includes(s))) {
    console.log(`[scorer] FILTERED: ${job.company}, desktop/Electron role not relevant to backend profile`);
    return null;
  }

  // Hard reject: explicit US-only or no-sponsorship clause — applies even to remote roles
  const US_ONLY_CLAUSES = [
    'us citizens only', 'green card holders only', 'authorized to work in the us',
    'us work authorization required', 'unable to sponsor', 'cannot sponsor',
    'no visa sponsorship', 'must be located in the us', 'must reside in the us',
    'us residents only', 'legally authorized to work in the united states',
  ];
  if (US_ONLY_CLAUSES.some((clause) => text.includes(clause))) {
    console.log(`[scorer] FILTERED: ${job.company} hard rejected, explicit US-only or no-sponsorship clause found`);
    return null;
  }

  const locationScore = scoreLocation(
    job.countryCode,
    job.city,
    job.workMode,
    job.offersRelocation,
    profile.search,
    job.locationLabel,
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

  // Hard reject: absolute salary floor (logged explicitly)
  const absoluteMonthlyEur = toMonthlyEur(job);
  if (absoluteMonthlyEur !== null && absoluteMonthlyEur < 2500) {
    console.log(`[scorer] FILTERED: ${job.company}, salary below minimum threshold (${Math.round(absoluteMonthlyEur)} EUR/month < 2,500 EUR/month)`);
    if (isApec) console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: salary<min (${Math.round(absoluteMonthlyEur)} EUR/month < 2,500)`);
    return null;
  }

  if (!salaryMeetsMinimum(job, profile)) {
    if (isApec) {
      const monthly = toMonthlyEur(job);
      console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: salary<min (${monthly !== null ? Math.round(monthly) : 'unknown'} EUR/month < profile minimum)`);
    }
    return null;
  }

  // Group-based keyword filter: pass if Group A OR (Group B AND Group C).
  // Trusted sources (server-side keyword filtering) skip this check entirely —
  // APEC and FranceTravail filter by keyword before returning results, so every
  // job is pre-qualified and descriptions may legitimately be empty on listing pages.
  const TRUSTED_SOURCES = ['apec.fr', 'welcometothejungle.com', 'arbeitsagentur.de'];
  const isTrustedSource = TRUSTED_SOURCES.includes(job.source);

  if (!isTrustedSource) {
    const hasGroupA = containsAny(text, KEYWORD_GROUP_A);
    const hasGroupB = containsAny(text, KEYWORD_GROUP_B) || text.includes('typescript');
    const hasGroupC = containsAny(text, KEYWORD_GROUP_C);

    if (!hasGroupA && !(hasGroupB && hasGroupC)) {
      const snippet = `${job.title} | ${job.description.slice(0, 120).replace(/\s+/g, ' ')}`;
      console.log(`[keyword-filter] FILTERED: ${job.company} — checked: "${snippet}"`);
      return null;
    }

    // Reject jobs where a non-JS backend language is explicitly required and Node.js is absent.
    if (!hasGroupA) {
      const nonJsRequiredPattern = /\b(?:c#|\.net|java(?!script)|golang|go\s+lang|ruby|php|kotlin|scala)\b.{0,60}(?:required|is\s+a\s+must|mandatory|must\s+have)/i;
      if (nonJsRequiredPattern.test(text)) {
        return null;
      }
    }
  }

  // Experience year text scan — penalty/reject for high-year requirements in required section
  const { penalty: expPenalty, hardReject: expHardReject } = detectExperiencePenalty(text);
  if (expHardReject) {
    console.log(`[scorer] FILTERED: ${job.company}, 8+ years required — too senior for mid-level profile`);
    if (isApec) console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: exp>max (8+ years required)`);
    return null;
  }

  const mandatoryScore = BASE_REQUIRED_WEIGHTS.reduce((sum, check) => {
    return sum + (check.matched(text) ? check.weight : 0);
  }, 0);

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
  // +5 for mid-size accessible companies (Series A/B, scale-ups, consulting, ESN, etc.)
  // explicitly excluded: Series C/D, unicorn, CAC40, Fortune 500 — hyper-competitive or too large.
  const TIER2_POSITIVE = [
    'series a', 'série a', 'series b', 'série b',
    'scale-up', 'scaleup',
    'esn', 'conseil', 'consulting',
    'mission', 'freelance', 'portage',
    'cdd', 'interim',
    '50 to 200 employees', 'moins de 200', 'startup',
  ];
  const TIER2_NEGATIVE = ['series c', 'série c', 'series d', 'série d', 'unicorn', 'cac40', 'cac 40', 'fortune 500', 'fortune500', '5000+ employees', '5,000+ employees', '10,000+ employees', '10000+ employees'];
  const hasTier1Signal = TIER2_NEGATIVE.some((s) => text.includes(s));
  const hasTier2 = TIER2_POSITIVE.some((s) => text.includes(s)) && !hasTier1Signal;
  const tier2Score = hasTier2 ? 5 : 0;
  const tier1Penalty = 0;

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

  const rawScore = Math.max(
    0,
    Math.min(
      100,
      mandatoryScore + kwScore + preferredGroupScore + titleScore + locScore + startupScore + sponsorScore + tier2Score + preference.delta - expPenalty - tier1Penalty,
    ),
  );

  // Primary stack bonus: reward explicit Node.js / NestJS mentions in title or description.
  // Includes multilingual spelling variants (FR développeur node, DE node entwickler, etc.)
  const stackText = `${job.title} ${job.description}`.toLowerCase();
  const hasNodeJs = /node\.js|nodejs|node\s+js\b/.test(stackText) ||
    containsAny(stackText, ['développeur node', 'ingénieur node', 'node entwickler', 'entwickler node', 'node ontwikkelaar']);
  const hasNestJs = /nest\.js|nestjs|nest\s+js\b/.test(stackText);
  const stackBonus = (hasNodeJs ? 15 : 0) + (hasNestJs ? 20 : 0);

  const score = Math.min(100, rawScore + stackBonus);

  // Adaptive threshold based on description length and language.
  // Non-English JDs (FR/DE/NL/IT/ES) naturally match fewer English keywords — use lower thresholds.
  const wordCount = job.description.trim().split(/\s+/).length;
  const isNonEnglishJd = /\b(nous|vous|notre|votre|emploi|poste|wir|sind|ihre|ihnen|wij|zijn|uw|onze|siamo|noi|nosotros|somos)\b/i.test(text);
  const threshold = isNonEnglishJd
    ? (wordCount < 120 ? 45 : wordCount < 350 ? 48 : 52)
    : (wordCount < 120 ? 55 : wordCount < 350 ? 57 : 60);

  if (score < threshold) {
    const lang = isNonEnglishJd ? (text.match(/\b(nous|vous|wir|sind|wij|zijn)\b/i)?.[0] ? (text.includes('wir') || text.includes('sind') ? 'DE' : text.includes('wij') || text.includes('zijn') ? 'NL' : 'FR') : 'non-EN') : 'EN';
    if (isApec || (rawScore >= 35 && rawScore < threshold)) {
      console.log(`[scorer-reject] "${job.title}" @ ${job.company} — reason: score<threshold (score=${score} raw=${rawScore} threshold=${threshold} words=${wordCount} lang=${lang} mandatory=${mandatoryScore})`);
    }
    return null;
  }

  const scoreBreakdown: ScoreBreakdown = {
    mandatory: mandatoryScore,
    keywords: keywordsTotal,
    location: locScore,
    startup: startupScore,
    sponsor: sponsorScore,
    tier2: tier2Score || undefined,
    preference: preference.delta,
    expPenalty: expPenalty || undefined,
    tier1Penalty: tier1Penalty || undefined,
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



function detectExperiencePenalty(text: string): { penalty: number; hardReject: boolean } {
  // Only scan required section — ignore nice-to-have context
  const niceIdx = text.search(/(?:nice[- ]to[- ]have|bonus|preferred|would be a plus|optionnel|bon à avoir)/i);
  const required = niceIdx > 0 ? text.slice(0, niceIdx) : text;

  // Hard reject: 8+ years (English and French)
  if (
    /\b(?:8|9|10|1\d)\+\s*(?:years?|ans?)\b/i.test(required) ||
    /\b(?:minimum|at least|au moins|minimum de)\s+(?:8|9|10|1\d)\s+(?:years?|ans?)\b/i.test(required) ||
    /\b(?:8|9|10|1\d)\s+ans?\s+(?:minimum|d['']expérience)\b/i.test(required) ||
    /\bminimum\s+(?:8|9|10|1\d)\s+years?\b/i.test(required)
  ) {
    return { penalty: 0, hardReject: true };
  }

  // -10 penalty: 6 years required (stack match compensates; interviews happen at 4yr with strong fit)
  if (
    /\b6\+\s*(?:years?|ans?)\b/i.test(required) ||
    /\b(?:minimum|at least|au moins)\s+6\s+(?:years?|ans?)\b/i.test(required) ||
    /\b6\s+ans?\s+(?:minimum|d['']expérience)\b/i.test(required) ||
    /\bminimum\s+6\s+years?\b/i.test(required)
  ) {
    return { penalty: 10, hardReject: false };
  }

  // -25 penalty: 7 years required
  if (
    /\b7\+\s*(?:years?|ans?)\b/i.test(required) ||
    /\b(?:minimum|at least|au moins)\s+7\s+(?:years?|ans?)\b/i.test(required) ||
    /\b7\s+ans?\s+(?:minimum|d['']expérience)\b/i.test(required) ||
    /\bminimum\s+7\s+years?\b/i.test(required)
  ) {
    return { penalty: 25, hardReject: false };
  }

  // 5 years required — no penalty (4 years experience is close enough)
  if (
    /\b5\+\s*(?:years?|ans?)\b/i.test(required) ||
    /\b(?:minimum|at least|au moins)\s+5\s+(?:years?|ans?)\b/i.test(required) ||
    /\b5\s+ans?\s+(?:minimum|d['']expérience)\b/i.test(required) ||
    /\bminimum\s+5\s+years?\b/i.test(required)
  ) {
    return { penalty: 0, hardReject: false };
  }

  return { penalty: 0, hardReject: false };
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

export function toMonthlyEur(job: JobPosting): number | null {
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

function fmtNum(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function buildSalaryLabel(job: JobPosting): string {
  const useYearly = job.salaryYearlyMinimum !== null && job.salaryYearlyMinimum !== undefined;
  const amount = useYearly ? job.salaryYearlyMinimum! : job.salaryMinimum;
  if (amount === null || amount === undefined) return 'salary not listed';

  const currency = (job.salaryCurrency ?? 'EUR').toUpperCase();
  const exchangeRates: Record<string, number> = { EUR: 1, USD: 0.88, GBP: 1.16, CHF: 1.04 };
  const rate = exchangeRates[currency];
  if (!rate) return 'salary not listed';

  const descLower = job.description.toLowerCase();
  const annualSignals = ['per year', '/year', 'annual', 'annually', 'a year', 'brut annuel', 'par an', '/an', 'per annum'];
  const monthlyTextSignals = ['per month', 'par mois', '/month', 'monthly'];
  const isExplicitlyMonthly = !useYearly && (
    job.salaryPeriod === 'monthly' || job.salaryPeriod === 'month' ||
    (amount < 20000 && monthlyTextSignals.some((s) => descLower.includes(s)))
  );
  const isAnnual = useYearly || (!isExplicitlyMonthly && amount > 50000 && annualSignals.some((s) => descLower.includes(s)));

  if (isAnnual) {
    const monthlyLocal = Math.round(amount / 12);
    const monthlyEur = Math.round(monthlyLocal * rate);
    if (currency === 'EUR') {
      return `EUR ${fmtNum(amount)}/year (~EUR ${fmtNum(monthlyEur)}/month)`;
    }
    return `${currency} ${fmtNum(amount)}/year (~${currency} ${fmtNum(monthlyLocal)}/month, ~EUR ${fmtNum(monthlyEur)}/month)`;
  }

  const monthlyEur = Math.round(amount * rate);
  if (currency === 'EUR') return `~EUR ${fmtNum(amount)}/month`;
  return `~${currency} ${fmtNum(amount)}/month (~EUR ${fmtNum(monthlyEur)}/month)`;
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
