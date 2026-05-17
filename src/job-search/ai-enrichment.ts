import { GoogleGenerativeAI } from '@google/generative-ai';
import { JobPosting, MatchResult, SearchProfile } from './types';

// gemini-1.5-flash: free tier — 15 RPM, 1 M tokens/day, 1 500 req/day.
// Plenty for a bot running every 3 hours with ~10 jobs per run.
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
}

export async function enrichMatch(
  match: MatchResult,
  profile: SearchProfile,
): Promise<AiEnrichment | null> {
  const ai = getClient();
  if (!ai) return null;

  try {
    const [fraud, cover] = await Promise.all([
      detectFraud(ai, match.job),
      humanizeCoverLetter(ai, match.job, profile, match.reasons),
    ]);
    return { ...fraud, coverLetter: cover };
  } catch {
    return null;
  }
}

async function detectFraud(
  ai: GoogleGenerativeAI,
  job: JobPosting,
): Promise<{ fraudScore: number; fraudReasons: string[]; isSuspicious: boolean }> {
  const model = ai.getGenerativeModel({
    model: MODEL,
    systemInstruction:
      'You are a job fraud detection expert. Analyze job postings and score how suspicious they are. ' +
      'Signs of fraud: unrealistic salary, vague or copy-pasted description, no real company info, ' +
      'requests personal info upfront, grammar errors suggesting mass posting, ' +
      'too-good-to-be-true perks, no specific tech requirements for a tech role. ' +
      'Return ONLY valid JSON with no markdown, no code fences: {"fraudScore": 0-100, "reasons": ["signal"]}',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const prompt =
    `Title: ${job.title}\n` +
    `Company: ${job.company}\n` +
    `Location: ${job.locationLabel}\n` +
    `Salary: ${job.salaryMinimum ? `${job.salaryMinimum}–${job.salaryMaximum ?? '?'} ${job.salaryCurrency ?? ''}` : 'not listed'}\n` +
    `Description: ${job.description.slice(0, 700)}`;

  const result = await model.generateContent(prompt);
  const parsed = JSON.parse(result.response.text()) as { fraudScore?: number; reasons?: string[] };
  const fraudScore = Math.min(100, Math.max(0, Number(parsed.fraudScore ?? 0)));
  const fraudReasons = (parsed.reasons ?? []).slice(0, 3);
  return { fraudScore, fraudReasons, isSuspicious: fraudScore >= 60 };
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

  const model = ai.getGenerativeModel({
    model: MODEL,
    systemInstruction:
      `You are ${profile.candidate.name}, a Paris-based backend engineer with ` +
      `${profile.candidate.experienceYears} years of hands-on experience. ` +
      `Your core stack is Node.js, NestJS, TypeScript, PostgreSQL, and REST APIs. ` +
      `Write cover letters as flowing prose paragraphs. ` +
      `Rules: no bullet points, no hyphens as list markers, no numbered lists, no dashes starting a line; ` +
      `keep it under 180 words; address the company by name and say one specific thing about what they do; ` +
      `mention 1 or 2 technical skills from your stack that match the job naturally in a sentence; ` +
      `do not use any of these words: passionate, leverage, synergy, utilize, excited, contribute, journey; ` +
      `end the letter with a natural closing sentence, then on new lines write exactly: ` +
      `"Best regards," and then "${profile.candidate.name}".`,
  });

  const prompt =
    `Write a cover letter for: ${job.title} at ${job.company}\n` +
    `Company type: ${companyType}\n` +
    `Location: ${job.locationLabel} (${job.workMode})\n` +
    `Why it matches me: ${matchReasons.slice(0, 3).join('; ')}\n` +
    `Job description: ${job.description.slice(0, 600)}\n\n` +
    `Write just the letter body, no subject line, no greeting like "Dear Hiring Manager":`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  return text || buildFallbackCoverLetter(job, profile, matchReasons);
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
