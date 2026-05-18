import { GoogleGenerativeAI } from '@google/generative-ai';
import { JobPosting, MatchResult, SearchProfile } from './types';

// gemini-1.5-flash: free tier — 15 RPM, 1 M tokens/day, 1 500 req/day.
const MODEL = 'gemini-1.5-flash';

let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
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
  const ai = getClient();
  if (!ai) return null;

  try {
    const [fraud, cover, salary] = await Promise.all([
      detectFraudAndQuality(ai, match.job),
      humanizeCoverLetter(ai, match.job, profile, match.reasons),
      suggestSalary(ai, match.job, profile),
    ]);
    return { ...fraud, coverLetter: cover, suggestedSalary: salary };
  } catch (err) {
    console.error('[gemini] enrichment failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function detectFraudAndQuality(
  ai: GoogleGenerativeAI,
  job: JobPosting,
): Promise<{ fraudScore: number; fraudReasons: string[]; isSuspicious: boolean; companyQualityScore: number; companyRedFlags: string[] }> {
  const model = ai.getGenerativeModel({
    model: MODEL,
    systemInstruction:
      'You are a job posting analyst. For each posting, assess two things:\n' +
      '1. FRAUD SCORE (0-100): How suspicious is this? Signs of fraud: unrealistic salary, vague description, ' +
      'no real company info, requests personal info upfront, grammar errors, too-good-to-be-true perks, ' +
      'no specific tech requirements for a tech role.\n' +
      '2. COMPANY QUALITY SCORE (0-100): How healthy does this company/role appear? ' +
      'Positive signals: specific tech stack, salary listed, clear role scope, senior engineering culture, realistic expectations. ' +
      'Red flags: "fast-paced environment", "wear many hats", "we are a family", no salary, ' +
      '"unlimited PTO" only perk listed, vague title, "rockstar ninja", high pressure language, no tech specifics.\n' +
      'Return ONLY valid JSON with no markdown: ' +
      '{"fraudScore": 0-100, "companyQualityScore": 0-100, "fraudReasons": ["signal"], "redFlags": ["flag"]}',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const prompt =
    `Title: ${job.title}\n` +
    `Company: ${job.company}\n` +
    `Location: ${job.locationLabel}\n` +
    `Salary: ${job.salaryMinimum ? `${job.salaryMinimum}–${job.salaryMaximum ?? '?'} ${job.salaryCurrency ?? ''}` : 'not listed'}\n` +
    `Description: ${job.description.slice(0, 800)}`;

  const result = await model.generateContent(prompt);
  const parsed = JSON.parse(result.response.text()) as {
    fraudScore?: number;
    companyQualityScore?: number;
    fraudReasons?: string[];
    redFlags?: string[];
  };
  const fraudScore = Math.min(100, Math.max(0, Number(parsed.fraudScore ?? 0)));
  const companyQualityScore = Math.min(100, Math.max(0, Number(parsed.companyQualityScore ?? 70)));
  const fraudReasons = (parsed.fraudReasons ?? []).slice(0, 3);
  const companyRedFlags = (parsed.redFlags ?? []).slice(0, 3);
  return { fraudScore, fraudReasons, isSuspicious: fraudScore >= 60, companyQualityScore, companyRedFlags };
}

async function humanizeCoverLetter(
  ai: GoogleGenerativeAI,
  job: JobPosting,
  profile: SearchProfile,
  matchReasons: string[],
): Promise<string> {
  const isProductCompany = !/(consulting|conseil|agency|agence|ssii|ess|outsourcing)/i.test(
    `${job.company} ${job.companySummary} ${job.description.slice(0, 300)}`,
  );

  const companyType = isProductCompany
    ? 'product company building their own software'
    : 'service or consulting company working with multiple clients';

  const companySizeHint = job.employeeCount
    ? `approximately ${job.employeeCount} employees`
    : job.isStartup
      ? 'an early-stage startup'
      : 'size not disclosed';

  const companyContext = [
    `Company: ${job.company}`,
    `Type: ${companyType}`,
    `Size: ${companySizeHint}`,
    job.companyCreationYear ? `Founded: ${job.companyCreationYear}` : '',
    job.companySummary ? `About the company: ${job.companySummary.slice(0, 400)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const model = ai.getGenerativeModel({
    model: MODEL,
    systemInstruction:
      `You are ${profile.candidate.name}, a Paris-based backend engineer with ` +
      `${profile.candidate.experienceYears} years of real production experience. ` +
      `Your stack: Node.js, NestJS, TypeScript, PostgreSQL, REST APIs, Docker, fintech systems.\n\n` +
      `Write cover letters that sound like a real email from a person, not a template or an AI. ` +
      `Format: exactly three paragraphs, 140 to 175 words total, every sentence complete and natural.\n\n` +
      `Paragraph 1 (2-3 sentences): Open with something specific about what this company actually does, ` +
      `their product, industry, or mission. Use the company context provided. If you know this company from ` +
      `your training data, use that knowledge too. Do not start with "I".\n\n` +
      `Paragraph 2 (3-4 sentences): Describe your relevant background concretely. ` +
      `Mention actual things you built: REST APIs, NestJS services, PostgreSQL schemas, fintech backends, Docker deployments. ` +
      `Connect them naturally to what the job is asking for.\n\n` +
      `Paragraph 3 (2 sentences): Say what you would bring to their team and close simply.\n\n` +
      `Hard rules: never use any dash character including hyphen (-), em-dash (${'—'}), or en-dash (${'–'}) anywhere in the letter. ` +
      `Use commas or periods instead. No bullet points, no numbered lists. ` +
      `Do not use: passionate, leverage, synergy, utilize, excited, contribute, journey, dynamic, proactive, thrive.\n\n` +
      `End with exactly this on separate lines: "Best regards," then "${profile.candidate.name}".`,
  });

  const prompt =
    `${companyContext}\n` +
    `Role: ${job.title}\n` +
    `Location: ${job.locationLabel}, ${job.workMode}\n` +
    `Why it matches me: ${matchReasons.slice(0, 3).join('; ')}\n` +
    `Job description excerpt: ${job.description.slice(0, 1000)}\n\n` +
    `Write the cover letter body only. No subject line. No greeting like "Dear Hiring Manager". ` +
    `Reference specific details about ${job.company} and what they build.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  return text || buildFallbackCoverLetter(job, profile, matchReasons);
}

// Exchange rate cache — refreshed at most once per hour
let rateCache: { rates: Record<string, number>; fetchedAt: number } | null = null;

async function getEurRates(): Promise<Record<string, number>> {
  if (rateCache && Date.now() - rateCache.fetchedAt < 3_600_000) return rateCache.rates;
  try {
    const res = await fetch(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json',
    );
    const json = (await res.json()) as { eur: Record<string, number> };
    rateCache = { rates: json.eur, fetchedAt: Date.now() };
    return json.eur;
  } catch {
    return rateCache?.rates ?? {};
  }
}

function adjustSalaryYears(requiredYears: number | null, candidateYears: number): number {
  if (requiredYears === null || requiredYears >= 5) return candidateYears;
  if (requiredYears <= 3) return requiredYears;
  // 4 or 4.5 years required → quote at 3.5yr market rate (competitive without overpricing)
  return 3.5;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

async function suggestSalary(
  ai: GoogleGenerativeAI,
  job: JobPosting,
  profile: SearchProfile,
): Promise<string | null> {
  try {
    const adjustedYears = adjustSalaryYears(
      job.experienceLevelMinimum,
      profile.candidate.experienceYears,
    );
    const location = job.city ? `${job.city}, ${job.locationLabel}` : job.locationLabel;

    const model = ai.getGenerativeModel({
      model: MODEL,
      systemInstruction:
        'You are a tech salary research expert with knowledge of developer pay across Europe. ' +
        'Give realistic GROSS MONTHLY salary ranges in the LOCAL currency of the country. ' +
        'Base your answer on typical market rates for that city and country. ' +
        'Return ONLY valid JSON, no markdown: {"min": 4500, "max": 5500, "currency": "EUR"}',
      generationConfig: { responseMimeType: 'application/json' },
    });

    const result = await model.generateContent(
      `What is the realistic gross monthly salary range for a Node.js/NestJS backend engineer ` +
      `with ${adjustedYears} years of experience at a tech company in ${location}? ` +
      `Role title: ${job.title}. Use the local currency of that country.`,
    );

    const parsed = JSON.parse(result.response.text()) as {
      min?: number;
      max?: number;
      currency?: string;
    };

    if (!parsed.min || !parsed.max || !parsed.currency) return null;

    const currency = parsed.currency.toUpperCase();
    const min = Math.round(parsed.min / 100) * 100;
    const max = Math.round(parsed.max / 100) * 100;
    const localStr = `${currency} ${fmt(min)}–${fmt(max)}/month`;

    if (currency === 'EUR') return localStr;

    // Convert to EUR using live rate
    const rates = await getEurRates();
    const rateKey = currency.toLowerCase();
    const rate = rates[rateKey];
    if (!rate) return localStr;

    const minEur = Math.round(min / rate / 100) * 100;
    const maxEur = Math.round(max / rate / 100) * 100;
    return `${localStr} (~€${fmt(minEur)}–${fmt(maxEur)}/month)`;
  } catch {
    return null;
  }
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
