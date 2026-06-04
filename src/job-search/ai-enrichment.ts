import { GoogleGenAI } from '@google/genai';
import { JobPosting, MatchResult, SearchProfile } from './types';

// Free tier: 15 RPM, 1500 req/day per key. One combined call per job.
// All gemini-1.5 variants (including -002) were removed from v1beta in 2025.
// Only 2.0 models are valid on the v1beta endpoint used by @google/genai SDK.
const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

let _cachedKeys: string[] | null = null;
let _currentKeyIndex = 0;
let _workingModel: string | null = null;

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

function isRetryableError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('rate_limit') ||
    msg.includes('resource_exhausted') ||
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

  const modelsToTry = _workingModel ? [_workingModel] : MODELS;

  for (const model of modelsToTry) {
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const idx = (_currentKeyIndex + attempt) % keys.length;
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
          console.warn(`[gemini] ${label}: key ${idx + 1}/${keys.length} model=${model} — ${msg.slice(0, 100)} — trying next`);
          _currentKeyIndex = (idx + 1) % keys.length;
        } else {
          console.error(`[gemini] ${label}: model=${model} error — ${msg.slice(0, 150)}`);
          break;
        }
      }
    }
  }

  console.error(`[gemini] ${label}: all keys/models failed — sending job without AI enrichment`);
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

const SYSTEM_INSTRUCTION = (name: string, expYears: number) =>
  `You are acting as a senior recruiter scanning a job for ${name}.\n` +
  `Candidate profile:\n` +
  `  Name: ${name}\n` +
  `  Location: Paris, France\n` +
  `  Experience: ${expYears} years backend engineering\n` +
  `  Core stack: Node.js, NestJS, TypeScript, PostgreSQL, Docker, REST APIs, microservices, fintech\n` +
  `  Visa: French APS (Autorisation Provisoire de Séjour) — post-study work permit valid in France only.\n` +
  `        For other EU countries, the employer must offer visa sponsorship or relocation support.\n` +
  `        For remote roles: can work from France for any EU company on this visa.\n\n` +
  `Analyse the job posting and return ONE JSON object with ALL fields below. No markdown, no extra text.\n\n` +
  `FIELD DEFINITIONS:\n` +
  `  relevanceScore: integer 0-100.\n` +
  `    Score HOW WELL this specific job matches this candidate.\n` +
  `    Penalise heavily if: primary backend is NOT Node.js (e.g. C#/.NET, Java, Go, PHP required without Node.js).\n` +
  `    Penalise if: role is frontend/fullstack where C# or Java dominates.\n` +
  `    Penalise if: requires skills the candidate clearly lacks (AI/ML, DevOps, mobile, data engineering).\n` +
  `    Reward if: Node.js/NestJS/TypeScript is the primary stack, fintech/payments domain, remote-friendly.\n` +
  `  relevanceIssues: array of up to 3 short strings explaining deductions (e.g. "Primary stack is C#/.NET, not Node.js").\n` +
  `  visaFriendly: true if the candidate can legally take this job on an APS visa (remote jobs = always true; ` +
  `    on-site/hybrid outside France = true only if job explicitly mentions visa sponsorship or relocation support; ` +
  `    on-site/hybrid in France = true). Return null if genuinely unclear.\n` +
  `  visaNote: one short sentence explaining the visa assessment, or null.\n` +
  `  fraudScore: integer 0-100 (0=clean, 100=scam). Signals: vague description, no real company info, ` +
  `    personal info requested upfront, grammar errors, unrealistic salary, no specific tech stack for a tech role.\n` +
  `  fraudReasons: array of up to 3 short strings.\n` +
  `  companyQualityScore: integer 0-100 (company/role health). Red flags: "rockstar/ninja", "we are a family", ` +
  `    "wear many hats", unlimited PTO as only perk, high-pressure language, vague title, no salary range.\n` +
  `  companyRedFlags: array of up to 3 short strings.\n` +
  `  coverLetter: string — write ONLY if relevanceScore >= 55. Otherwise return empty string.\n` +
  `    Format: 3 paragraphs, 140-175 words total.\n` +
  `    Para 1 (2-3 sentences): Specific fact about what THIS company builds. Do NOT start with "I".\n` +
  `    Para 2 (3-4 sentences): Concrete backend experience (REST APIs, NestJS, PostgreSQL, Docker, fintech). Connect to this role.\n` +
  `    Para 3 (2 sentences): What you bring. Close simply.\n` +
  `    End with exactly: "Best regards,\\n${name}"\n` +
  `    Rules: no dashes, no: passionate/leverage/synergy/excited/contribute/dynamic.\n` +
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

  const response = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION(profile.candidate.name, profile.candidate.experienceYears),
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
  };
}

function buildFallbackCoverLetter(
  job: JobPosting,
  profile: SearchProfile,
  reasons: string[],
): string {
  const reasonLine = reasons[0] ?? 'the backend ownership in the role';
  return [
    `Hello ${job.company} team,`,
    '',
    `I am a Paris-based backend engineer with ${profile.candidate.experienceYears} years building production systems with Node.js, NestJS, and TypeScript.`,
    `What caught my attention here is ${reasonLine.toLowerCase()}, along with the focus on APIs and PostgreSQL-backed services where reliability matters every day.`,
    `My recent work spans REST APIs, Docker deployments, and backend services for fintech platforms. I would be glad to bring that same practical approach to ${job.company}.`,
    '',
    'Best regards,',
    profile.candidate.name,
  ].join('\n');
}
