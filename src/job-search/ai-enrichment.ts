import { GoogleGenAI } from '@google/genai';
import { JobPosting, MatchResult, SearchProfile } from './types';

// Free tier: 15 RPM, 1500 req/day per key. One combined call per job.
// All gemini-1.5 variants (including -002) were removed from v1beta in 2025.
// Only 2.0 models are valid on the v1beta endpoint used by @google/genai SDK.
const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

let _cachedKeys: string[] | null = null;
let _currentKeyIndex = 0;
let _workingModel: string | null = null;
// Keys confirmed to have daily quota exhausted this process lifetime — skip immediately.
const _quotaExhaustedKeyIndices = new Set<number>();
// Once every available key is quota-exhausted, skip Gemini for the rest of this run.
let _allKeysDown = false;

export let lastGeminiError = '';

function getApiKeys(): string[] {
  if (_cachedKeys) return _cachedKeys;
  const keys: string[] = [];
  const main = process.env.GEMINI_API_KEY;
  if (main) keys.push(...main.split(',').map((k) => k.trim()).filter(Boolean));
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k?.trim()) keys.push(k.trim());
  }
  _cachedKeys = [...new Set(keys)];
  return _cachedKeys;
}

// Daily quota exhausted — no value retrying with the same key in this process lifetime.
function isDailyQuotaError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    (msg.includes('429') && (msg.includes('quota') || msg.includes('billing') || msg.includes('exceeded')))
  );
}

// Temporary rate limit (per-minute) — rotating keys may help.
function isRetryableError(err: unknown): boolean {
  if (isDailyQuotaError(err)) return true; // still rotate to another key
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('api_key_invalid') ||
    msg.includes('invalid api key') ||
    msg.includes('403') ||
    msg.includes('401')
  );
}

async function callWithRotation<T>(
  fn: (ai: GoogleGenAI, model: string) => Promise<T>,
  label: string,
): Promise<T | null> {
  const keys = getApiKeys();
  if (!keys.length) return null;

  // All keys previously confirmed quota-exhausted — skip immediately, no API calls wasted.
  if (_allKeysDown) {
    return null;
  }

  const modelsToTry = _workingModel ? [_workingModel] : MODELS;

  for (const model of modelsToTry) {
    // Capture startIdx ONCE before the loop — do NOT read _currentKeyIndex inside the loop.
    // Bug: if _currentKeyIndex is mutated per-attempt, later iterations get a shifted base,
    // causing the same key index to be computed twice and other keys to be skipped entirely.
    const startIdx = _currentKeyIndex;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const idx = (startIdx + attempt) % keys.length;

      if (_quotaExhaustedKeyIndices.has(idx)) {
        continue;
      }

      const ai = new GoogleGenAI({ apiKey: keys[idx] });
      try {
        const result = await fn(ai, model);
        _currentKeyIndex = idx;
        _workingModel = model;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastGeminiError = msg;
        if (isRetryableError(err)) {
          if (isDailyQuotaError(err)) {
            _quotaExhaustedKeyIndices.add(idx);
            console.warn(`[gemini] ${label}: key ${idx + 1}/${keys.length} model=${model} quota exhausted, blacklisting for this run`);
          } else {
            console.warn(`[gemini] ${label}: key ${idx + 1}/${keys.length} model=${model} ${msg.slice(0, 100)} trying next`);
          }
          // Do NOT mutate _currentKeyIndex here — startIdx is fixed for this pass.
        } else {
          console.error(`[gemini] ${label}: model=${model} non-retryable error ${msg.slice(0, 150)}`);
          break;
        }
      }
    }
    // Advance by 1 so the next call starts from the key after where this pass began.
    _currentKeyIndex = (startIdx + 1) % keys.length;
  }

  // If every key is now confirmed quota-exhausted, set the run-level flag so
  // subsequent jobs skip Gemini immediately without burning any more API calls.
  if (_quotaExhaustedKeyIndices.size >= keys.length) {
    _allKeysDown = true;
    console.error('[gemini] all keys quota-exhausted — skipping Gemini for remaining jobs in this run');
  } else {
    console.error(`[gemini] ${label}: all keys/models failed — sending job without AI enrichment`);
  }
  return null;
}

export interface AiEnrichment {
  fraudScore: number;
  fraudReasons: string[];
  coverLetter: string;
  isSuspicious: boolean;
  suggestedSalary: string | null;
  companyQualityScore: number;
  companyRedFlags: string[];
  relevanceScore: number;
  relevanceIssues: string[];
  visaFriendly: boolean | null;
  visaNote: string | null;
  atsMissingKeywords: string[];
  atsPlacementSuggestions: string[];
  hiringEmail: string | null;
  emailSubject: string | null;
  emailBody: string | null;
}

export async function enrichMatch(
  match: MatchResult,
  profile: SearchProfile,
): Promise<AiEnrichment | null> {
  if (!getApiKeys().length) return null;
  return callWithRotation(
    (ai, model) => enrichSingle(ai, model, match.job, profile, match.reasons),
    match.job.company,
  );
}

const EUR_RATES: Record<string, number> = {
  EUR: 1, USD: 0.88, GBP: 1.16, CHF: 1.04,
  PLN: 0.23, SEK: 0.087, NOK: 0.086, DKK: 0.134, CZK: 0.041,
};

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const SYSTEM_INSTRUCTION = (name: string, expYears: number, cvText: string, workMode: string, countryCode: string | null) =>
  `You are acting as a senior recruiter scanning a job for ${name}.\n\n` +
  `=== CANDIDATE CV ===\n${cvText}\n=== END CV ===\n\n` +
  `Visa: French APS (post-study permit) — valid for work in France only.\n` +
  `  Remote roles: always compatible (candidate works from Paris for any EU company).\n` +
  `  On-site/hybrid in France: compatible.\n` +
  `  On-site/hybrid outside France: only compatible if employer explicitly mentions visa sponsorship or relocation support.\n\n` +
  `Analyse the job posting and return ONE JSON object with ALL fields below. No markdown, no extra text.\n\n` +
  `FIELD DEFINITIONS:\n` +
  `  relevanceScore: integer 0-100. How well does this job match the candidate's CV above?\n` +
  `    Penalise heavily: primary backend NOT Node.js (C#/.NET, Java, Go, PHP) without Node.js.\n` +
  `    Penalise: frontend/fullstack where non-JS dominates; requires skills clearly absent from CV (AI/ML, DevOps, mobile).\n` +
  `    Reward: Node.js/NestJS/TypeScript primary stack; fintech/payments domain; event-driven/microservices.\n` +
  `  relevanceIssues: array of up to 3 short strings explaining deductions.\n` +
  `  visaFriendly: true/false/null — assess using visa rules above.\n` +
  `  visaNote: one short sentence, or null.\n` +
  `  fraudScore: integer 0-100 (0=clean). Signals: vague description, no company info, grammar errors, no tech stack for tech role.\n` +
  `  fraudReasons: array of up to 3 short strings.\n` +
  `  companyQualityScore: integer 0-100. Red flags: rockstar/ninja, "wear many hats", no salary, unlimited PTO only perk.\n` +
  `  companyRedFlags: array of up to 3 short strings.\n` +
  `  atsMissingKeywords: array of up to 8 technical keywords from the job description NOT clearly present in the candidate CV above.\n` +
  `    Focus on: specific frameworks, databases, tools, protocols, testing frameworks, cloud services.\n` +
  `    Do NOT list things clearly in the CV (NestJS, Docker, PostgreSQL, RabbitMQ, Kafka etc. are already there).\n` +
  `  atsPlacementSuggestions: array of up to 3 short strings on WHERE to add the top missing keywords.\n` +
  `    E.g. "Add 'Jest' to Skills > Tools — your NexusPay 85%+ test coverage shows this experience."\n` +
  `    Only suggest if it makes genuine sense given the candidate's background.\n` +
  `  hiringEmail: extract from job description text ONLY if an explicit email address for applications is written there. Return null otherwise — do NOT guess.\n` +
  `  emailSubject: if hiringEmail found, subject line max 60 chars: "Application: [role title] — [company]". Else null.\n` +
  `  emailBody: if hiringEmail found, 3-4 sentences for an email sent with CV attached.\n` +
  `    Mention: specific interest in this company/role, one concrete experience highlight from CV, CV is attached, open to discuss.\n` +
  `    Use first name if hiring manager name appears in description. Else "Dear Hiring Team". Else null.\n` +
  `  coverLetter: write ONLY if relevanceScore >= 55. Otherwise return empty string.\n` +
  `    Format: 3 paragraphs, 140-175 words total.\n` +
  `    Para 1 (2-3 sentences): Specific fact about what THIS company builds or does. Do NOT start with "I".\n` +
  `    Para 2 (3-4 sentences): Reference specific projects/achievements from the CV that match this role.\n` +
  `      Draw on NexusPay, Swiss Block, OptimusFox, or Teams.pk as relevant. Be concrete.\n` +
  `    Para 3 (2 sentences): Mention location fit naturally.\n` +
  `      If workMode="${workMode}" and countryCode="${countryCode ?? 'null'}":\n` +
  `      - remote: "Working from Paris, I can join your distributed team from day one."\n` +
  `      - on-site/hybrid in France (FR): "Based in Paris, I can join your team on-site without relocation."\n` +
  `      - on-site/hybrid outside France: "I am open to relocation and happy to work through the logistics."\n` +
  `      Then one closing sentence.\n` +
  `    End with exactly: "Best regards,\\n${name}"\n` +
  `    Rules: absolutely no dashes of any kind (no hyphen-punctuation, no em dash —, no en dash). Use commas or short sentences instead. No: passionate/leverage/synergy/excited/contribute/dynamic.\n` +
  `  salaryMin: monthly gross integer in local currency, or null.\n` +
  `  salaryMax: monthly gross integer in local currency, or null.\n` +
  `  salaryCurrency: ISO 4217 string, or null.`;

async function enrichSingle(
  ai: GoogleGenAI,
  model: string,
  job: JobPosting,
  profile: SearchProfile,
  matchReasons: string[],
): Promise<AiEnrichment> {
  const isConsulting = /(consulting|conseil|agency|agence|ssii|outsourcing)/i.test(
    `${job.company} ${job.companySummary} ${job.description.slice(0, 300)}`,
  );

  const companyInfo = [
    `Company: ${job.company}`,
    isConsulting ? 'Type: consulting/agency' : 'Type: product company',
    job.employeeCount ? `Size: ~${job.employeeCount} employees` : job.isStartup ? 'Size: early-stage startup' : '',
    job.companyCreationYear ? `Founded: ${job.companyCreationYear}` : '',
    job.companySummary ? `About: ${job.companySummary.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');

  const prompt =
    `${companyInfo}\n` +
    `Role: ${job.title}\n` +
    `Location: ${job.locationLabel} (${job.workMode})\n` +
    `Salary listed: ${job.salaryMinimum ? `${job.salaryMinimum}–${job.salaryMaximum ?? '?'} ${job.salaryCurrency ?? ''}` : 'not listed'}\n` +
    `Relocation/visa sponsorship offered: ${job.offersRelocation ? 'yes' : 'not mentioned'}\n` +
    `Why code filter matched: ${matchReasons.slice(0, 3).join('; ')}\n` +
    `Full description:\n${job.description.slice(0, 1800)}`;

  const cvText = profile.candidate.cvText ?? `${profile.candidate.name} | ${profile.candidate.experienceYears}yrs backend | Skills: ${profile.candidate.coreSkills.join(', ')}`;

  const response = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION(
        profile.candidate.name,
        profile.candidate.experienceYears,
        cvText,
        job.workMode,
        job.countryCode,
      ),
      responseMimeType: 'application/json',
    },
    contents: prompt,
  });

  const raw = JSON.parse(response.text ?? '{}') as {
    relevanceScore?: number;
    relevanceIssues?: string[];
    visaFriendly?: boolean | null;
    visaNote?: string | null;
    fraudScore?: number;
    companyQualityScore?: number;
    fraudReasons?: string[];
    companyRedFlags?: string[];
    coverLetter?: string;
    atsMissingKeywords?: string[];
    atsPlacementSuggestions?: string[];
    hiringEmail?: string | null;
    emailSubject?: string | null;
    emailBody?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    salaryCurrency?: string | null;
  };

  const relevanceScore = Math.min(100, Math.max(0, Number(raw.relevanceScore ?? 50)));
  const fraudScore = Math.min(100, Math.max(0, Number(raw.fraudScore ?? 0)));
  const companyQualityScore = Math.min(100, Math.max(0, Number(raw.companyQualityScore ?? 70)));
  console.log(`[gemini] "${job.title}" @ ${job.company} — relevance=${relevanceScore} fraud=${fraudScore} quality=${companyQualityScore} visa=${raw.visaFriendly ?? 'unknown'} model=${model}`);

  let suggestedSalary: string | null = null;
  if (raw.salaryMin && raw.salaryMax && raw.salaryCurrency) {
    const currency = raw.salaryCurrency.toUpperCase();
    const min = Math.round(raw.salaryMin / 100) * 100;
    const max = Math.round(raw.salaryMax / 100) * 100;
    const localStr = `${currency} ${fmt(min)}–${fmt(max)}/month`;
    const rate = EUR_RATES[currency];
    if (rate && currency !== 'EUR') {
      const minEur = Math.round(min * rate / 100) * 100;
      const maxEur = Math.round(max * rate / 100) * 100;
      suggestedSalary = `${localStr} (~€${fmt(minEur)}–${fmt(maxEur)}/month)`;
    } else {
      suggestedSalary = localStr;
    }
  }

  const hiringEmail = typeof raw.hiringEmail === 'string' && raw.hiringEmail.includes('@')
    ? raw.hiringEmail.trim()
    : null;

  return {
    relevanceScore,
    relevanceIssues: (raw.relevanceIssues ?? []).slice(0, 3),
    visaFriendly: raw.visaFriendly ?? null,
    visaNote: raw.visaNote?.trim() || null,
    fraudScore,
    fraudReasons: (raw.fraudReasons ?? []).slice(0, 3),
    isSuspicious: fraudScore >= 72,
    companyQualityScore,
    companyRedFlags: (raw.companyRedFlags ?? []).slice(0, 3),
    coverLetter: relevanceScore >= 55
      ? (raw.coverLetter?.trim() || buildFallbackCoverLetter(job, profile, matchReasons))
      : '',
    suggestedSalary,
    atsMissingKeywords: (raw.atsMissingKeywords ?? []).slice(0, 8),
    atsPlacementSuggestions: (raw.atsPlacementSuggestions ?? []).slice(0, 3),
    hiringEmail,
    emailSubject: hiringEmail ? (raw.emailSubject?.trim() || null) : null,
    emailBody: hiringEmail ? (raw.emailBody?.trim() || null) : null,
  };
}

function buildFallbackCoverLetter(
  job: JobPosting,
  profile: SearchProfile,
  reasons: string[],
): string {
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
    `I am a Paris-based Node.js and NestJS backend engineer with ${profile.candidate.experienceYears} years of production experience. At OptimusFox I designed and delivered production microservices across fintech and crypto platforms, integrating Stripe, PayPal, and blockchain APIs while maintaining PostgreSQL-backed services for reliability at scale. My current project, NexusPay, is an event-driven fintech platform targeting 10,000 TPS built with NestJS, RabbitMQ, Kafka, Redis, and Clean Architecture across seven independent microservices.`,
    '',
    `${locationLine} I would welcome the chance to discuss how my background fits this role.`,
    '',
    'Best regards,',
    profile.candidate.name,
  ].join('\n');
}
