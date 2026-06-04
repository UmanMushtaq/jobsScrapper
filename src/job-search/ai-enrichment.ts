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
  `You are helping ${name}, a Paris-based backend engineer ` +
  `(${expYears} yrs exp, Node.js/NestJS/TypeScript/PostgreSQL/Docker/fintech). ` +
  `Analyse a job posting and return a single JSON object with ALL fields below. No markdown.\n\n` +
  `Required JSON fields:\n` +
  `  fraudScore: integer 0-100 (how suspicious is this posting?)\n` +
  `  companyQualityScore: integer 0-100 (how healthy does the role/company appear?)\n` +
  `  fraudReasons: array of up to 3 short strings\n` +
  `  companyRedFlags: array of up to 3 short strings\n` +
  `  coverLetter: string — 3 paragraphs, 140-175 words total.\n` +
  `    Para 1 (2-3 sentences): Open with a specific fact about what THIS company builds or does. Do NOT start with "I".\n` +
  `    Para 2 (3-4 sentences): Concrete backend experience — REST APIs, NestJS services, PostgreSQL schemas, Docker, fintech backends. Connect to the role.\n` +
  `    Para 3 (2 sentences): What you bring to their team. Close simply.\n` +
  `    End with exactly: "Best regards,\\n${name}"\n` +
  `    Rules: no dashes (use commas/periods). No: passionate, leverage, synergy, excited, contribute, dynamic.\n` +
  `  salaryMin: monthly gross integer in local currency, or null\n` +
  `  salaryMax: monthly gross integer in local currency, or null\n` +
  `  salaryCurrency: ISO 4217 currency code string, or null\n\n` +
  `Fraud signals: vague description, no real company info, requests personal info upfront, grammar errors, ` +
  `unrealistic salary, no specific tech requirements for a tech role.\n` +
  `Quality red flags: "wear many hats", "we are a family", no salary listed, rockstar/ninja, ` +
  `unlimited PTO as only perk, high-pressure language, vague title.`;

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
    `Why it matches: ${matchReasons.slice(0, 3).join('; ')}\n` +
    `Description: ${job.description.slice(0, 1200)}`;

  const response = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION(profile.candidate.name, profile.candidate.experienceYears),
      responseMimeType: 'application/json',
    },
    contents: prompt,
  });

  const raw = JSON.parse(response.text ?? '{}') as {
    fraudScore?: number;
    companyQualityScore?: number;
    fraudReasons?: string[];
    companyRedFlags?: string[];
    coverLetter?: string;
    salaryMin?: number | null;
    salaryMax?: number | null;
    salaryCurrency?: string | null;
  };

  const fraudScore = Math.min(100, Math.max(0, Number(raw.fraudScore ?? 0)));
  const companyQualityScore = Math.min(100, Math.max(0, Number(raw.companyQualityScore ?? 70)));
  console.log(`[gemini] "${job.title}" @ ${job.company} — fraud=${fraudScore} quality=${companyQualityScore} model=${model}`);

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
    fraudScore,
    fraudReasons: (raw.fraudReasons ?? []).slice(0, 3),
    isSuspicious: fraudScore >= 72,
    companyQualityScore,
    companyRedFlags: (raw.companyRedFlags ?? []).slice(0, 3),
    coverLetter: raw.coverLetter?.trim() || buildFallbackCoverLetter(job, profile, matchReasons),
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
