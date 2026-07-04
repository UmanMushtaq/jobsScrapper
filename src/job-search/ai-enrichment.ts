import { GoogleGenAI } from '@google/genai';
import { redisGetJobDecisionHistory, redisIncrGeminiDailyCalls } from './redis-store';
import { getJobDecisionHistory } from '../database/database.service';
import { resolveWorkAuth } from './profile';
import { JobPosting, MatchResult, SearchProfile } from './types';

// Free tier: 15 RPM, 1500 req/day per key. One combined call per job.
// gemini-2.0-flash free tier limit was set to 0 by Google in 2026 — use 2.5.
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-8b', 'gemini-2.0-flash-exp'];

interface ApiKeyEntry { key: string; source: string; }
let _cachedKeyEntries: ApiKeyEntry[] | null = null;
let _currentKeyIndex = 0;
let _workingModel: string | null = null;
// Keys confirmed working in this server session.
const _confirmedWorkingKeyIndices = new Set<number>();
// Keys confirmed permanently unusable (daily quota exhausted, or invalid/revoked).
const _quotaExhaustedKeyIndices = new Set<number>();
// Once every key is exhausted, skip Gemini until Google's quota resets.
// Gemini free-tier quota resets at midnight PACIFIC time, so we track the Pacific
// calendar day on which we went down and resume as soon as that day rolls over.
let _allKeysDown = false;
let _allKeysDownPacificDay: string | null = null;
// Set to true when Gemini returns HTTP 503 "high demand" — different from quota exhaustion.
// run.ts checks this flag after each enrichment pass and retries after a 5-minute wait.
let _isCurrentlyOverloaded = false;
export function isGeminiOverloaded(): boolean { return _isCurrentlyOverloaded; }
export function clearGeminiOverloadFlag(): void { _isCurrentlyOverloaded = false; }

// Proactively reset all in-memory quota state — called by the midnight Pacific scheduler.
export function resetGeminiQuotaState(): void {
  const entries = getApiKeyEntries();
  const wasDown = _allKeysDown;
  const count = _quotaExhaustedKeyIndices.size;
  _allKeysDown = false;
  _allKeysDownPacificDay = null;
  _quotaExhaustedKeyIndices.clear();
  _confirmedWorkingKeyIndices.clear();
  console.log(
    `[gemini] quota reset scheduler fired — clearing all blacklisted keys` +
    (count > 0 ? ` (${count} unblacklisted: ${entries.slice(0, count).map((e) => e.source).join(', ')})` : ' (no keys were blacklisted)') +
    (wasDown ? ' · allKeysDown flag cleared' : ''),
  );
}
// Successful Gemini calls today (Pacific day). Resets on day rollover.
let _dailyCallCount = 0;
let _dailyCallPacificDay = '';

// Current calendar date in Google's quota-reset timezone (America/Los_Angeles), as YYYY-MM-DD.
function pacificDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}

export let lastGeminiError = '';

function getApiKeyEntries(): ApiKeyEntry[] {
  if (_cachedKeyEntries) return _cachedKeyEntries;
  const entries: ApiKeyEntry[] = [];
  const main = process.env.GEMINI_API_KEY;
  if (main) {
    main.split(',').map((k) => k.trim()).filter(Boolean).forEach((k, i) => {
      entries.push({ key: k, source: i === 0 ? 'GEMINI_API_KEY' : `GEMINI_API_KEY (slot ${i + 1})` });
    });
  }
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GEMINI_API_KEY_${i}`];
    if (k?.trim()) entries.push({ key: k.trim(), source: `GEMINI_API_KEY_${i}` });
  }
  const seen = new Set<string>();
  _cachedKeyEntries = entries.filter((e) => {
    if (seen.has(e.key)) return false;
    seen.add(e.key);
    return true;
  });
  return _cachedKeyEntries;
}

function getApiKeys(): string[] {
  return getApiKeyEntries().map((e) => e.key);
}

// Daily quota exhausted — no value retrying with the same key until Google resets at midnight UTC.
function isDailyQuotaError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    (msg.includes('429') && (msg.includes('quota') || msg.includes('billing') || msg.includes('exceeded')))
  );
}

// Invalid or revoked key — permanently useless, blacklist immediately.
function isInvalidKeyError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('api_key_invalid') ||
    msg.includes('invalid api key') ||
    msg.includes('api key not valid') ||
    (msg.includes('401') && !msg.includes('rate'))
  );
}

// Google returns 503 when a model is temporarily overloaded with traffic.
// Unlike quota exhaustion (429), rotating keys won't help — the whole model is busy.
// The right response is to pause and retry in a few minutes.
function is503OverloadError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return msg.includes('"code":503') || (msg.includes('503') && msg.toLowerCase().includes('demand'));
}

// Temporary rate limit (per-minute) — rotating to another key may help.
function isRetryableError(err: unknown): boolean {
  if (isDailyQuotaError(err)) return true;
  if (isInvalidKeyError(err)) return true; // still rotate, but also blacklist
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('403')
  );
}

async function callWithRotation<T>(
  fn: (ai: GoogleGenAI, model: string) => Promise<T>,
  label: string,
): Promise<T | null> {
  const keys = getApiKeys();
  if (!keys.length) return null;

  // All keys previously confirmed quota-exhausted. Resume as soon as the Pacific
  // calendar day has rolled over since we went down — that's when Google refills quota.
  if (_allKeysDown) {
    if (_allKeysDownPacificDay && pacificDay() !== _allKeysDownPacificDay) {
      _allKeysDown = false;
      _allKeysDownPacificDay = null;
      _quotaExhaustedKeyIndices.clear();
      _confirmedWorkingKeyIndices.clear();
      console.log('[gemini] new Pacific day since all-keys-down — quota reset, resuming enrichment');
    } else {
      return null;
    }
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
        _confirmedWorkingKeyIndices.add(idx);
        // Track daily call count; reset when Pacific day rolls over.
        const today = pacificDay();
        if (today !== _dailyCallPacificDay) {
          _dailyCallCount = 0;
          _dailyCallPacificDay = today;
        }
        _dailyCallCount++;
        // Persist to Redis — fire-and-forget so enrichment is never delayed.
        redisIncrGeminiDailyCalls(today).catch(() => undefined);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastGeminiError = msg;
        if (isRetryableError(err)) {
          if (isDailyQuotaError(err)) {
            _quotaExhaustedKeyIndices.add(idx);
            _confirmedWorkingKeyIndices.delete(idx);
            console.warn(`[gemini] ${label}: key ${idx + 1}/${keys.length} model=${model} quota exhausted — blacklisted until next day reset`);
          } else if (isInvalidKeyError(err)) {
            _quotaExhaustedKeyIndices.add(idx);
            _confirmedWorkingKeyIndices.delete(idx);
            console.warn(`[gemini] ${label}: key ${idx + 1}/${keys.length} invalid/revoked — permanently blacklisted`);
          } else {
            console.warn(`[gemini] ${label}: key ${idx + 1}/${keys.length} model=${model} ${msg.slice(0, 100)} trying next`);
          }
          // Do NOT mutate _currentKeyIndex here — startIdx is fixed for this pass.
        } else if (is503OverloadError(err)) {
          // Model-level overload — no point trying other keys for this model
          _isCurrentlyOverloaded = true;
          console.warn(`[gemini] ${label}: model=${model} 503 high demand — retry scheduled`);
          break;
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
    _allKeysDownPacificDay = pacificDay();
    console.error('[gemini] all keys quota-exhausted — skipping Gemini until next Pacific-day quota reset');
  } else if (_isCurrentlyOverloaded) {
    // Already logged per-model above — run.ts will retry after a 5-minute wait.
  } else {
    console.error(`[gemini] ${label}: all keys/models failed — sending job without AI enrichment`);
  }
  return null;
}

export interface GeminiKeyState {
  index: number;
  source: string;
  keyPreview: string;
  /** ok = confirmed working this session; quota_exhausted = confirmed exhausted; untested = no attempts yet */
  status: 'ok' | 'quota_exhausted' | 'untested';
}

export interface GeminiModuleState {
  keys: GeminiKeyState[];
  allKeysDown: boolean;
  allKeysDownPacificDay: string | null;
  /** Successful calls counted in-memory since last server start (resets on restart). */
  dailyCallCount: number;
  dailyCallPacificDay: string;
  workingModel: string | null;
  lastError: string;
}

export function getGeminiModuleState(): GeminiModuleState {
  const entries = getApiKeyEntries();
  return {
    keys: entries.map((entry, i) => ({
      index: i,
      source: entry.source,
      keyPreview: `${entry.key.slice(0, 8)}...${entry.key.slice(-4)}`,
      status: _quotaExhaustedKeyIndices.has(i)
        ? 'quota_exhausted'
        : _confirmedWorkingKeyIndices.has(i)
          ? 'ok'
          : 'untested',
    })),
    allKeysDown: _allKeysDown,
    allKeysDownPacificDay: _allKeysDownPacificDay,
    dailyCallCount: _dailyCallCount,
    dailyCallPacificDay: _dailyCallPacificDay,
    workingModel: _workingModel,
    lastError: lastGeminiError,
  };
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
  // Null when salary is above the threshold or unknown.
  // Non-null when estimated salary is below the €39,582/yr (€3,299/mo) Talent permit floor.
  visaRisk: string | null;
  atsMissingKeywords: string[];
  atsPlacementSuggestions: string[];
  hiringEmail: string | null;
  emailSubject: string | null;
  emailBody: string | null;
}

export async function enrichMatch(
  match: MatchResult,
  profile: SearchProfile,
  preferenceContext = '',
): Promise<AiEnrichment | null> {
  if (!getApiKeys().length) return null;
  return callWithRotation(
    (ai, model) => enrichSingle(ai, model, match.job, profile, match.reasons, preferenceContext),
    match.job.company,
  );
}

export async function generateTailoredCv(
  cvText: string,
  jobTitle: string,
  company: string,
  atsMissingKeywords: string[],
  atsPlacementSuggestions: string[],
): Promise<string | null> {
  if (!getApiKeys().length) return null;
  const prompt =
    `CANDIDATE CV:\n${cvText}\n\n` +
    `JOB: ${jobTitle} at ${company}\n\n` +
    `ATS KEYWORDS MISSING FROM THIS CV:\n${atsMissingKeywords.join(', ')}\n\n` +
    `WHERE TO ADD EACH KEYWORD:\n${atsPlacementSuggestions.join('\n')}\n\n` +
    `TASK:\n` +
    `Return the full tailored CV as plain text with the keywords naturally inserted in the correct sections.\n` +
    `Rules:\n` +
    `- Only add keywords where the candidate genuinely has that experience per the suggestions above.\n` +
    `- Keep ALL existing content unchanged — never remove, invent, or exaggerate anything.\n` +
    `- Insert keywords naturally into the existing section text, not as a raw appended list.\n` +
    `- Preserve all section headers and formatting.\n` +
    `- At the very top, before the candidate name, add one line: "Tailored for: ${jobTitle} — ${company}"\n` +
    `- Return ONLY the tailored CV text. No commentary.`;

  return callWithRotation(async (ai, model) => {
    const response = await ai.models.generateContent({
      model,
      config: { responseMimeType: 'text/plain' },
      contents: prompt,
    });
    return response.text?.trim() ?? null;
  }, `tailored-cv:${company}`);
}

export async function generateShortAnswers(
  company: string,
  title: string,
  description: string,
  questions: string[],
  profile: SearchProfile,
): Promise<Array<{ question: string; answer: string }> | null> {
  if (!getApiKeys().length || !questions.length) return null;
  const cvText = profile.candidate.cvText ??
    `${profile.candidate.name} | ${profile.candidate.experienceYears}yrs backend | Skills: ${profile.candidate.coreSkills.join(', ')}`;
  const { statusLine } = resolveWorkAuth(profile);
  const prompt =
    `You are writing job application answers for ${profile.candidate.name}.\n\n` +
    `=== CANDIDATE CV ===\n${cvText}\n=== END CV ===\n\n` +
    `Work authorization: ${statusLine}\n\n` +
    `JOB: ${title} at ${company}\n` +
    (description.trim() ? `Role context:\n${description.slice(0, 600)}\n\n` : '\n') +
    `Write a concise, specific answer to each question below. Reference real experience from the CV. ` +
    `Keep each answer under 150 words. Write naturally, no buzzwords, no clichés.\n\n` +
    `Questions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n` +
    `Return a JSON array of objects: [{"question":"...","answer":"..."}]. One object per question. No extra text.`;
  return callWithRotation(async (ai, model) => {
    const response = await ai.models.generateContent({
      model,
      config: { responseMimeType: 'application/json' },
      contents: prompt,
    });
    const raw = JSON.parse(response.text ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map((item: unknown, i: number) => ({
      question: typeof item === 'object' && item !== null && 'question' in item
        ? String((item as { question: unknown }).question)
        : questions[i] ?? `Question ${i + 1}`,
      answer: typeof item === 'object' && item !== null && 'answer' in item
        ? String((item as { answer: unknown }).answer)
        : String(item),
    }));
  }, `short-answers:${company}`);
}

const EUR_RATES: Record<string, number> = {
  EUR: 1, USD: 0.88, GBP: 1.16, CHF: 1.04,
  PLN: 0.23, SEK: 0.087, NOK: 0.086, DKK: 0.134, CZK: 0.041,
};

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// Safety net: Gemini sometimes ignores the "no dashes" rule. Strip every kind of
// dash from generated prose so cover letters and emails never contain one.
// - em/en/figure dashes etc. surrounded by spaces become a comma + space
// - a hyphen between two letters becomes a single space ("full-stack" -> "full stack")
// - any remaining stray dash characters are removed
function stripDashes(text: string | null | undefined): string {
  if (!text) return '';
  return text
    // spaced long dashes -> comma (", ")
    .replace(/\s*[—–―‒]\s*/g, ', ')
    // spaced hyphen used as punctuation -> comma
    .replace(/\s+-\s+/g, ', ')
    // hyphen joining two word characters -> space ("real-time" -> "real time")
    .replace(/(\w)-(\w)/g, '$1 $2')
    // any leftover dash characters -> remove
    .replace(/[—–―‒-]/g, '')
    // tidy up any doubled commas/spaces the replacements may have produced
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// To convert APS visa to a long-term Talent (salarié qualifié) permit: flat €39,582/yr from Aug 2025 decree.
const TALENT_THRESHOLD_MONTHLY_EUR = Math.ceil(39582 / 12); // 3299

const CANDIDATE_TECH_STACK =
  `=== CANDIDATE TECH STACK (authoritative — do NOT claim experience with anything outside this list) ===\n` +
  `  Languages:  TypeScript, JavaScript\n` +
  `  Frameworks: Node.js, NestJS, Express.js\n` +
  `  Databases:  PostgreSQL, MongoDB, Redis\n` +
  `  Messaging:  RabbitMQ, Kafka\n` +
  `  Cloud:      AWS, Docker\n` +
  `  CI/CD:      GitHub Actions\n` +
  `  Frontend:   React (basic)\n` +
  `  Patterns:   Microservices, Event-Driven Architecture, Clean Architecture, DDD, Saga pattern\n` +
  `  Auth:       JWT, OAuth2\n` +
  `  Testing:    Jest\n` +
  `=== END TECH STACK ===\n`;

const SYSTEM_INSTRUCTION = (name: string, expYears: number, cvText: string, workMode: string, countryCode: string | null, visaContext: string, statusLine: string, jobSource = '') =>
  `You are acting as a senior recruiter scanning a job for ${name}.\n\n` +
  `TECHNOLOGY CONSTRAINT: Only mention technologies, frameworks, tools, and integrations that appear in the candidate's CV or tech stack below. Never invent or assume experience with technologies not listed. If the job requires a technology not in the candidate's stack, do not claim the candidate has experience with it. You may mention willingness to learn it if relevant.\n\n` +
  `=== CANDIDATE CV ===\n${cvText}\n=== END CV ===\n\n` +
  CANDIDATE_TECH_STACK + `\n` +
  `Visa: ${visaContext}\n` +
  `  Remote roles: always compatible (candidate works from Paris for any EU company).\n` +
  `  On-site/hybrid in France: compatible — candidate is open to any French city (Paris, Lyon, Marseille, Bordeaux, etc.).\n` +
  `  On-site/hybrid outside France: only compatible if employer explicitly mentions visa sponsorship or relocation support.\n\n` +
  `Language note: this job posting may be written in French, Dutch, German, or another European language.\n` +
  `  The candidate is a fluent English speaker (A1 French). The candidate has a browser translator and can read any JD language.\n\n` +
  `  LANGUAGE RULE: Never reject a job purely because the JD is written in French, Dutch, or German.\n\n` +
  `  Before applying any language penalty, check for these English signals in the JD:\n` +
  `  - English explicitly mentioned as required or working language\n` +
  `  - C1, B2, fluent English in expected skills\n` +
  `  - International teams or clients mentioned\n` +
  `  - Company is multinational or has offices in multiple countries\n` +
  `  - Role involves international partners or clients\n\n` +
  `  If ANY of these signals are present, do NOT apply a language penalty. Score the job based on stack match only.\n\n` +
  `  If NONE of these signals are present, use web search to check the company. Search: [company name] working language OR langue de travail OR company culture\n\n` +
  `  If web search shows the company works in English or is international, do NOT apply language penalty.\n\n` +
  `  Only apply language penalty if both the JD AND web search confirm the role requires French/Dutch/German fluency with no English alternative. In that case set relevanceScore below 40 and note the language barrier in relevanceIssues.\n\n` +
  `  The posting language alone is NOT evidence that French/Dutch/German is required for the job.\n\n` +
  `Analyse the job posting and return ONE JSON object with ALL fields below. No markdown, no extra text.\n\n` +
  `FIELD DEFINITIONS:\n` +
  `  relevanceScore: integer 0-100. How well does this job match the candidate's CV?\n` +
  `\n` +
  `    HARD PENALTIES (score must be below 40):\n` +
  `    - Primary backend language is NOT Node.js: C#/.NET, Java, Go, PHP, Python, Ruby as the main stack with no Node.js\n` +
  `    - Angular or Vue.js is the PRIMARY frontend framework and the role is fullstack requiring heavy Angular/Vue work\n` +
  `    - Role is primarily frontend (React, Angular, Vue) with backend as secondary\n` +
  `    - Job requires MORE than 5 years of experience (6+ years, "senior" implying 6+, or similar) — this must score below the pass threshold regardless of stack fit, domain, or any other factor. No exceptions.\n` +
  `\n` +
  `    MEDIUM PENALTIES (reduce score by 20-30 points):\n` +
  `    - Fullstack role where frontend is more than 50% of the work\n` +
  `    - Node.js mentioned only once as a nice-to-have, not primary\n` +
  `    - Requires 6+ years strictly with no flexibility signal\n` +
  `    - Requires French, Dutch, or German fluency with no English-team signal (candidate is A1 French only)\n` +
  `    - AI/ML, DevOps, or mobile as primary skill requirement\n` +
  `\n` +
  `    REWARDS (increase score):\n` +
  `    - Node.js or NestJS as PRIMARY backend stack: +20\n` +
  `    - TypeScript explicitly required: +10\n` +
  `    - Fintech, payments, or banking domain: +10\n` +
  `    - Event-driven architecture or microservices: +10\n` +
  `    - Remote or hybrid with no language requirement: +5\n` +
  `    - Senior backend role, pure backend not fullstack: +10\n` +
  `\n` +
  `    CALIBRATION:\n` +
  `    Use the candidate's apply/dismiss history provided below.\n` +
  `    If the job is similar to a DISMISSED job:\n` +
  `      - Same primary stack as dismissed -> reduce by 15 points\n` +
  `      - Same role type (fullstack with Angular) as dismissed -> reduce by 20 points\n` +
  `    If the job is similar to an APPLIED job:\n` +
  `      - Same stack and role type -> increase by 15 points\n` +
  `    Definition of similar: same primary technology AND same role type (backend vs fullstack vs frontend)\n` +
  `  relevanceIssues: array of up to 3 short strings explaining deductions.\n` +
  `  visaFriendly: true/false/null — assess using visa rules above.\n` +
  `  visaNote: one short sentence, or null.\n` +
  `  fraudScore: integer 0-100 (0=clean). Signals: vague description, no company info, grammar errors, no tech stack for tech role.\n` +
  `  fraudReasons: array of up to 3 short strings.\n` +
  `  companyQualityScore: integer 0-100. Red flags: rockstar/ninja, "wear many hats", no salary, unlimited PTO only perk.\n` +
  `  companyRedFlags: array of up to 3 short strings.\n` +
  `  atsMissingKeywords: array of up to 8 technical keywords from the job description NOT clearly present in the candidate CV above.\n` +
  `    STRICT CRITERIA — only flag a keyword as a gap if it meets at least ONE of the following:\n` +
  `    (a) It appears inside a clearly labelled required/must-have section (e.g. "Requirements", "Must have", "You must have", "Required skills", "What we require", "Must-have skills").\n` +
  `    (b) It appears 2 or more times anywhere in the full job description text.\n` +
  `    Do NOT flag skills mentioned only once outside a required section — those are nice-to-haves, not gaps.\n` +
  `    Focus on: specific frameworks, databases, tools, protocols, testing frameworks, cloud services.\n` +
  `    Do NOT list things clearly in the CV (NestJS, Docker, PostgreSQL, RabbitMQ, Kafka etc. are already there).\n` +
  `  atsPlacementSuggestions: array of up to 3 short strings on WHERE to add the top missing keywords.\n` +
  `    E.g. "Add 'Jest' to Skills > Tools — your NexusPay 85%+ test coverage shows this experience."\n` +
  `    Only suggest if it makes genuine sense given the candidate's background.\n` +
  `  hiringEmail: extract from job description text ONLY if an explicit email address for applications is written there. Return null otherwise — do NOT guess.\n` +
  `  emailSubject: if hiringEmail found, subject line max 60 chars: "Application: [role title] — [company]". Else null.\n` +
  `  emailBody: if hiringEmail found, 3-4 sentences for an email sent with CV attached.\n` +
  `    Mention: specific interest in this company/role, one concrete experience highlight from CV, CV is attached, open to discuss.\n` +
  `    Include one location sentence using the same rules as the cover letter Para 3:\n` +
  `      - remote: "Working from Paris, I can join your distributed team from day one."\n` +
  `      - on-site/hybrid in France (FR), Paris-area: "Based in Paris, I can join your team on-site without relocation."\n` +
  `      - on-site/hybrid in France (FR), outside Paris: "I am based in Paris and fully open to relocating within France for this role."\n` +
  `      - on-site/hybrid outside France: "I am open to relocation and happy to work through the logistics."\n` +
  `    Use first name if hiring manager name appears in description. Else "Dear Hiring Team". Else null.\n` +
  `  coverLetter: write ONLY if relevanceScore >= 55. Otherwise return empty string.\n` +
  `    Goal: a warm, human, specific letter that answers every question in a recruiter's head: who is this person, why this company, why this role, why are they the right fit, and (if not Paris) why are they open to this location. It must read like a real person wrote it, not a template.\n` +
  `    Length: 4 short paragraphs, 180-230 words total (APEC source exception: see rule 8).\n` +
  `    GREETING: Begin with "Hi [first name of hiring manager if found in description, otherwise company name + " Team"]," on its own line. Example: "Hi Acme Team," or "Hi Sophie,". Never use "Dear".\n` +
  `    Para 1 (2-3 sentences): MUST begin with the exact words "I am". Introduce the candidate in one line (Paris-based Node.js / NestJS backend engineer with ${expYears}+ years), name the exact role title shown in the prompt that they are applying for, and state one genuine, specific reason this company appeals to him, grounded in a real fact about what THIS company actually builds or does (take it from the company info / description, never generic flattery).\n` +
  `    Para 2 (3-4 sentences): Why he is the right fit. Map his concrete experience to what THIS role needs, using the job description's own requirements. PRIMARY proof: OptimusFox (${expYears} years production, NestJS/Node.js microservices, fintech + crypto platforms, real cross-functional team of ~10). EU recruiters will not know OptimusFox, so name the concrete output: what was built, citing only integrations and technologies that appear in the CANDIDATE TECH STACK above (for example: Dockerized microservices, CI/CD with GitHub Actions, event-driven messaging with RabbitMQ or Kafka). Connect 2-3 of his skills directly to the role's main needs and say plainly why that makes him a strong match. NEVER name a technology (Vue.js, Stripe, PayPal, Angular, Spring, etc.) unless it is in the CANDIDATE TECH STACK above.\n` +
  `    Para 3 (2-3 sentences): Why this company and this role specifically (growth, product, domain, engineering culture, whatever the posting reveals). SUPPORTING proof only: NexusPay may be cited here as evidence of current depth, e.g. "I am applying these same patterns in NexusPay, an event-driven fintech platform I am building", never as primary experience. Do NOT open any paragraph with NexusPay.\n` +
  `    Para 4 (2-3 sentences): Location and availability, worded naturally.\n` +
  `      If workMode="${workMode}" and countryCode="${countryCode ?? 'null'}":\n` +
  `      - remote: "Working from Paris, I can join your distributed team from day one."\n` +
  `      - on-site/hybrid in France (FR), Paris-area: "Based in Paris, I can join your team on-site without relocation."\n` +
  `      - on-site/hybrid in France (FR), outside Paris: say he is based in Paris and genuinely happy to relocate within France for this role, and give a brief human reason he is open to moving for the right team.\n` +
  `      - on-site/hybrid outside France (another country): acknowledge the role is outside France, say he is genuinely open to relocating within Europe for it, and give one authentic reason WHY he would move there for this specific company/role (the opportunity, the product, the team). Do not sound desperate, sound deliberate.\n` +
  `      Then one short closing sentence inviting a conversation.\n` +
  `    After Para 4, add this exact line on its own, word for word: "${statusLine}"\n` +
  `    CLOSING BLOCK: End with this exact block, preserving line breaks:\n` +
  `      "Best regards,\\nUman Mushtaq\\numanmushtaq72@gmail.com\\n+33 651 995 139\\ngithub.com/UmanMushtaq\\nlinkedin.com/in/umanmushtaq"\n` +
  `    HARD RULES:\n` +
  `      1. NO DASHES WHATSOEVER: no em dash (—), no en dash (–), no hyphen used as punctuation. Write compound words as two words or one word ("full stack", "well structured", "real time"). Use commas, "and", or short sentences instead. Zero exceptions.\n` +
  `      2. Sound human: vary sentence length, use plain confident language, write like you are speaking to one person. Avoid AI tells and these banned words: passionate, leverage, synergy, excited, thrilled, contribute, dynamic, fast-paced, cutting-edge, delve, tapestry, robust, seamless, spearheaded.\n` +
  `      3. Be specific over generic: every claim should reference a real fact about the company, the role, or his actual experience.\n` +
  `      4. TECHNOLOGY HONESTY: Only name technologies that appear in the CANDIDATE TECH STACK block at the top of this prompt. If the job description mentions Vue.js, Angular, Spring, Laravel, Stripe, PayPal, or any other technology NOT in the candidate's stack, do NOT claim the candidate has experience with it. You may say he is open to picking it up quickly if it fits naturally.\n` +
  `      5. GRAMMARLY STANDARDS: Use the Oxford comma in lists of three or more. No comma splices (do not join two independent clauses with only a comma). No run-on sentences. Active voice preferred. No unnecessary adverbs (e.g. avoid "very", "really", "truly"). Hyphenate compound modifiers that appear directly before a noun (e.g. "event-driven architecture" is fine as a modifier, but never use a standalone hyphen for punctuation). Do not start a sentence with "And" or "But".\n` +
  `      6. NO HYPERLINKS OR MARKDOWN: Do not include any hyperlink syntax ([text](url)), angle-bracket URLs, or markdown formatting inside the cover letter body. Plain text only. No bullet points.\n` +
  `      7. GREETING AND CLOSING FORMAT: The greeting ("Hi X,") and the closing block must appear exactly as specified above. Do not add any extra lines, signatures, or fields beyond what is specified.\n` +
  `      8. APEC COVER LETTER (hard limit — no exceptions): The job source for this request is "${jobSource}". If it is "apec.fr", apply ALL of the following rules:\n` +
  `         a. The ENTIRE cover letter — greeting, body, sign-off, and closing block — must be 500 characters or fewer including spaces and line breaks.\n` +
  `         b. The body must answer three things in as few words as possible: who you are (role + years), what you bring (1-2 technologies matching the job), why this role.\n` +
  `         c. Start with: Hi [Company/Team],\n` +
  `         d. End with: Best regards, Uman Mushtaq\n` +
  `         e. No hyperlinks. No em-dashes. Plain text only. Active voice.\n` +
  `         f. If 500 characters is not enough to include the sign-off, cut the body — never cut the sign-off.\n` +
  `         g. After generating, count the characters. If over 500, rewrite shorter. NEVER return a letter over 500 characters for APEC.\n` +
  `         h. Do NOT include the full closing block (email, phone, github, linkedin) — only "Best regards, Uman Mushtaq".\n` +
  `      9. For all non-APEC sources, ignore rule 8 entirely.\n` +
  `  salaryMin: monthly gross integer in local currency, or null.\n` +
  `  salaryMax: monthly gross integer in local currency, or null.\n` +
  `  salaryCurrency: ISO 4217 string, or null.`;

// Proper email closings — used to detect truncated Gemini emailBody output.
const EMAIL_CLOSINGS = ['best regards', 'sincerely', 'kind regards', 'regards,', 'thank you,', 'thanks,', 'cordialement', 'bien cordialement', 'yours sincerely', 'linkedin.com/in/umanmushtaq', 'github.com/umanmushtaq'];

function isEmailBodyComplete(body: string): boolean {
  if (body.length < 100) return false;
  const lower = body.toLowerCase().trim();
  // Accept if any closing appears in the last 60 characters (after name is signed)
  const tail = lower.slice(-80);
  return EMAIL_CLOSINGS.some((c) => tail.includes(c));
}

async function enrichSingle(
  ai: GoogleGenAI,
  model: string,
  job: JobPosting,
  profile: SearchProfile,
  matchReasons: string[],
  preferenceContext = '',
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

  // Fetch applied/dismissed history — PostgreSQL primary, Redis fallback
  const pgHistory = await getJobDecisionHistory(20);
  const usePg = pgHistory.applied.length > 0 || pgHistory.dismissed.length > 0;

  let appliedEntries: Array<{ title: string; company: string; country?: string; score: number; stack?: string; roleType?: string; desc?: string }>;
  let dismissedEntries: typeof appliedEntries;

  if (usePg) {
    const toEntry = (r: { job_title: string; company: string; country: string | null; ai_score: number; primary_stack: string | null; role_type: string | null; job_description: string | null }) => ({
      title: r.job_title, company: r.company, country: r.country ?? undefined,
      score: r.ai_score, stack: r.primary_stack ?? undefined,
      roleType: r.role_type ?? undefined, desc: r.job_description?.slice(0, 200) ?? undefined,
    });
    appliedEntries = pgHistory.applied.map(toEntry);
    dismissedEntries = pgHistory.dismissed.map(toEntry);
  } else {
    const [redisApplied, redisDismissed] = await Promise.all([
      redisGetJobDecisionHistory('applied', 20),
      redisGetJobDecisionHistory('dismissed', 20),
    ]);
    appliedEntries = redisApplied.map((e) => ({ title: e.title, company: e.company, country: e.countryCode ?? undefined, score: e.score }));
    dismissedEntries = redisDismissed.map((e) => ({ title: e.title, company: e.company, country: e.countryCode ?? undefined, score: e.score }));
  }

  let historyContext = '';
  if (appliedEntries.length > 0 || dismissedEntries.length > 0) {
    const lines: string[] = ['=== CANDIDATE JOB DECISION HISTORY ==='];
    if (appliedEntries.length > 0) {
      lines.push('Jobs this candidate APPLIED TO recently (good matches — calibrate higher if similar):');
      appliedEntries.forEach((e) => {
        let line = `  - ${e.title} @ ${e.company}${e.country ? ` (${e.country})` : ''} score:${e.score}`;
        if (e.stack) line += ` stack:${e.stack}`;
        if (e.roleType) line += ` type:${e.roleType}`;
        if (e.desc) line += `\n    description preview: ${e.desc}`;
        lines.push(line);
      });
    }
    if (dismissedEntries.length > 0) {
      lines.push('Jobs this candidate DISMISSED recently (bad matches — calibrate lower if similar):');
      dismissedEntries.forEach((e) => {
        let line = `  - ${e.title} @ ${e.company}${e.country ? ` (${e.country})` : ''} score:${e.score}`;
        if (e.stack) line += ` stack:${e.stack}`;
        if (e.roleType) line += ` type:${e.roleType}`;
        if (e.desc) line += `\n    reason pattern: ${e.desc}`;
        lines.push(line);
      });
    }
    lines.push(
      'DECISION HISTORY LEARNING — CRITICAL:',
      'You have access to the candidate\'s full apply/dismiss history with job descriptions. Use it aggressively.',
      '',
      '=== DISMISS PATTERNS (never show these) ===',
      '',
      'AUTOMATIC SCORE BELOW 40 if job matches ANY of these:',
      '- Angular or Vue as PRIMARY framework',
      '- Fullstack role where React/Angular/Vue is 50%+ of work',
      '- Python as primary backend language',
      '- Java or .NET as primary language',
      '- Title contains: Fullstack + Angular, Fullstack + Vue, Fullstack + React (when backend is secondary)',
      '',
      'SCORE REDUCTION from dismissed history:',
      '- Same primary technology as dismissed job: -20 points',
      '- Same role type as dismissed (fullstack+frontend): -15',
      '- Same company type as dismissed: -10',
      '- Job description similar to dismissed (70%+ overlap in responsibilities): -25 points',
      '',
      '=== APPLIED PATTERNS (show more of these) ===',
      '',
      'AUTOMATIC SCORE ABOVE 75 if job matches ALL of these:',
      '- Pure backend role (no frontend responsibilities)',
      '- Node.js OR NestJS as PRIMARY technology',
      '- TypeScript explicitly required',
      '- Senior level or 3-5 years experience required',
      '- Located in France/Germany/Belgium/Netherlands/Luxembourg/Italy OR fully remote',
      '',
      'SCORE BOOST from applied history:',
      '- Same primary technology as applied job (Node.js/NestJS): +20 points',
      '- Same role type as applied (pure backend): +15 points',
      '- Same domain as applied (fintech, SaaS, ESN): +10',
      '- Similar salary range as applied jobs: +5 points',
      '- Same source type as applied (APEC, ESN consulting): +5',
      '',
      '=== CALIBRATION RULES ===',
      '',
      '1. If a new job is more than 70% similar to a dismissed job in stack AND role type: score below 40, no exceptions',
      '',
      '2. If a new job matches the applied pattern perfectly (pure backend + Node.js/NestJS + TypeScript): score above 80, generate cover letter always',
      '',
      '3. For borderline jobs (score 50-70): check if the PRIMARY daily work is backend or frontend.',
      '   If frontend dominates: score below 45. If backend dominates: keep score.',
      '',
      '4. Weight dismissed patterns 2x more than applied patterns when in doubt.',
      '',
      '5. A job with Node.js mentioned once as nice-to-have but Python/Java/.NET as primary: score below 35.',
      '',
      'KEY LEARNINGS FROM HISTORY:',
      'Applied jobs are ALL: pure backend, Node.js/NestJS primary, TypeScript, microservices, senior level, EU location.',
      '',
      'Dismissed jobs are ALL: Angular primary, Vue primary, fullstack with heavy frontend, Python primary, wrong location, or wrong stack.',
      '',
      'Never show the candidate a job that matches dismissed patterns even if the overall score would be high.',
      '=== END HISTORY ===',
    );
    historyContext = lines.join('\n');
  }

  const prompt =
    (preferenceContext ? `${preferenceContext}\n\n` : '') +
    (historyContext ? `${historyContext}\n\n` : '') +
    `${companyInfo}\n` +
    `Role: ${job.title}\n` +
    `Location: ${job.locationLabel} (${job.workMode})\n` +
    `Salary listed: ${job.salaryMinimum ? `${job.salaryMinimum}–${job.salaryMaximum ?? '?'} ${job.salaryCurrency ?? ''}` : 'not listed'}\n` +
    `Relocation/visa sponsorship offered: ${job.offersRelocation ? 'yes' : 'not mentioned'}\n` +
    `Why code filter matched: ${matchReasons.slice(0, 3).join('; ')}\n` +
    `Full description:\n${job.description.slice(0, 1800)}`;

  const cvText = profile.candidate.cvText ?? `${profile.candidate.name} | ${profile.candidate.experienceYears}yrs backend | Skills: ${profile.candidate.coreSkills.join(', ')}`;
  const workAuth = resolveWorkAuth(profile);

  const response = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION(
        profile.candidate.name,
        profile.candidate.experienceYears,
        cvText,
        job.workMode,
        job.countryCode,
        workAuth.visaContext,
        workAuth.statusLine,
        job.source,
      ),
      responseMimeType: 'application/json',
    },
    contents: prompt,
  });

  let raw: {
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
  try {
    raw = JSON.parse(response.text ?? '{}');
  } catch {
    console.warn(`[gemini] malformed JSON response for "${job.title}" @ ${job.company} — treating as empty`);
    raw = {};
  }
  const relevanceScore = Math.min(100, Math.max(0, Number(raw.relevanceScore ?? 50)));
  const fraudScore = Math.min(100, Math.max(0, Number(raw.fraudScore ?? 0)));
  const companyQualityScore = Math.min(100, Math.max(0, Number(raw.companyQualityScore ?? 70)));
  console.log(`[gemini] "${job.title}" @ ${job.company} — relevance=${relevanceScore} fraud=${fraudScore} quality=${companyQualityScore} visa=${raw.visaFriendly ?? 'unknown'} model=${model}`);
  const descWordCount = job.description.trim().split(/\s+/).filter(Boolean).length;
  const coverLetterThreshold = descWordCount < 120 ? 45 : descWordCount < 350 ? 50 : 55;
  const shouldGenerateCoverLetter = relevanceScore >= coverLetterThreshold;
  const coverLetterStatus = shouldGenerateCoverLetter ? 'generated' : 'skipped';

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

  // Server-side Talent permit salary check — more reliable than asking the AI to do the maths.
  // Threshold: €39,582/yr = €3,299/mo (Aug 2025 decree, decoupled from SMIC).
  let visaRisk: string | null = null;
  if (raw.salaryMin && raw.salaryCurrency) {
    const rate = EUR_RATES[(raw.salaryCurrency ?? '').toUpperCase()];
    if (rate) {
      const monthlyEur = Math.round(raw.salaryMin * rate);
      if (monthlyEur < TALENT_THRESHOLD_MONTHLY_EUR) {
        visaRisk =
          `Salary (est. ~${fmt(monthlyEur)} EUR/mo) is below the ${fmt(TALENT_THRESHOLD_MONTHLY_EUR)} EUR/mo (${fmt(39582)} EUR/yr) ` +
          `minimum to convert your APS visa to a Talent permit. You can start this job but negotiate ` +
          `to at least ${fmt(TALENT_THRESHOLD_MONTHLY_EUR + 50)} EUR/mo before or at signing to secure your stay.`;
      }
    }
  }

  return {
    relevanceScore,
    relevanceIssues: (raw.relevanceIssues ?? []).slice(0, 3),
    visaFriendly: raw.visaFriendly ?? null,
    visaNote: raw.visaNote?.trim() || null,
    visaRisk,
    fraudScore,
    fraudReasons: (raw.fraudReasons ?? []).slice(0, 3),
    isSuspicious: fraudScore >= 72,
    companyQualityScore,
    companyRedFlags: (raw.companyRedFlags ?? []).slice(0, 3),
    coverLetter: shouldGenerateCoverLetter
      ? stripDashes(raw.coverLetter?.trim() || buildFallbackCoverLetter(job, profile, matchReasons))
      : '',
    suggestedSalary,
    atsMissingKeywords: (raw.atsMissingKeywords ?? []).slice(0, 8),
    atsPlacementSuggestions: (raw.atsPlacementSuggestions ?? []).slice(0, 3),
    hiringEmail,
    emailSubject: hiringEmail ? (stripDashes(raw.emailSubject?.trim()) || null) : null,
    emailBody: await resolveEmailBody(ai, model, job, profile, hiringEmail, raw.emailBody?.trim() ?? null),
  };
}

async function resolveEmailBody(
  ai: GoogleGenAI,
  model: string,
  job: JobPosting,
  profile: SearchProfile,
  hiringEmail: string | null,
  rawBody: string | null,
): Promise<string | null> {
  if (!hiringEmail) return null;

  const body = rawBody ? stripDashes(rawBody) : null;
  if (body && isEmailBodyComplete(body)) return body;

  const label = `"${job.title}" @ ${job.company}`;

  if (body) {
    console.warn(`[gemini] ${label} — emailBody incomplete (${body.length} chars, no proper closing), retrying`);
  } else {
    console.warn(`[gemini] ${label} — emailBody missing or empty, retrying`);
  }

  const workAuth = resolveWorkAuth(profile);
  const isParisArea = /paris|île-de-france|idf/i.test(job.locationLabel ?? '');
  const locationLine =
    job.workMode === 'remote'
      ? 'Working from Paris, I can join your distributed team from day one.'
      : job.countryCode === 'FR'
        ? isParisArea
          ? 'Based in Paris, I can join your team on-site without relocation.'
          : 'I am based in Paris and fully open to relocating within France for this role.'
        : 'I am open to relocation within Europe and happy to work through the logistics.';

  const retryPrompt =
    `Write a short professional email applying for the ${job.title} role at ${job.company}.\n` +
    `The candidate is ${profile.candidate.name}, a Paris-based Node.js/NestJS backend engineer.\n` +
    `CV summary: ${profile.candidate.experienceYears}+ years, NestJS microservices, fintech/crypto platforms, Stripe/PayPal integrations.\n` +
    `Work authorization: ${workAuth.statusLine}\n\n` +
    `Requirements:\n` +
    `- Open with "Dear Hiring Team,"\n` +
    `- 3-4 sentences: specific interest in this role, one concrete experience highlight, CV is attached, open to discuss.\n` +
    `- Include exactly this location sentence: "${locationLine}"\n` +
    `- Close with exactly: "Best regards,\\n${profile.candidate.name}"\n` +
    `- Minimum 120 words total.\n\n` +
    `Return ONE JSON object: {"emailBody":"..."}\n` +
    `No markdown, no extra text.`;

  try {
    const retryResponse = await ai.models.generateContent({
      model,
      config: { responseMimeType: 'application/json' },
      contents: retryPrompt,
    });
    const retryRaw = JSON.parse(retryResponse.text ?? '{}') as { emailBody?: string };
    const retryBody = stripDashes(retryRaw.emailBody?.trim() || '');
    if (retryBody && isEmailBodyComplete(retryBody)) {
      console.log(`[gemini] ${label} — email retry succeeded (${retryBody.length} chars)`);
      return retryBody;
    }
    console.warn(`[gemini] ${label} — email retry also incomplete — suppressing partial email`);
    return null;
  } catch (err) {
    console.warn(`[gemini] ${label} — email retry failed: ${err instanceof Error ? err.message : String(err)} — suppressing partial email`);
    return null;
  }
}

function buildFallbackCoverLetter(
  job: JobPosting,
  profile: SearchProfile,
  _reasons: string[],
): string {
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
    `Hi ${job.company} team,`,
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
