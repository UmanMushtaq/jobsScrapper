import Anthropic from '@anthropic-ai/sdk';
import { JobPosting, MatchResult, SearchProfile } from './types';

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 15_000;

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
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
  ai: Anthropic,
  job: JobPosting,
): Promise<{ fraudScore: number; fraudReasons: string[]; isSuspicious: boolean }> {
  const prompt = `You are a job fraud detection expert. Analyze this job posting and rate how suspicious it is.

Title: ${job.title}
Company: ${job.company}
Location: ${job.locationLabel}
Salary: ${job.salaryMinimum ? `${job.salaryMinimum}–${job.salaryMaximum ?? '?'} ${job.salaryCurrency ?? ''}` : 'not listed'}
Description (first 800 chars): ${job.description.slice(0, 800)}

Return ONLY valid JSON with this exact shape:
{
  "fraudScore": <0-100 integer, 0=clearly legitimate, 100=obvious scam>,
  "reasons": ["reason1", "reason2"]
}

Signs of fraud: unrealistic salary, vague/copy-pasted description, no real company info, requests personal info upfront, grammar errors suggesting mass posting, too-good-to-be-true perks, no specific tech requirements for a tech role.`;

  const response = await ai.messages.create(
    {
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    },
    { timeout: TIMEOUT_MS },
  );

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { fraudScore: 0, fraudReasons: [], isSuspicious: false };

  const parsed = JSON.parse(jsonMatch[0]) as { fraudScore?: number; reasons?: string[] };
  const fraudScore = Math.min(100, Math.max(0, Number(parsed.fraudScore ?? 0)));
  const fraudReasons = (parsed.reasons ?? []).slice(0, 3);
  return { fraudScore, fraudReasons, isSuspicious: fraudScore >= 60 };
}

async function humanizeCoverLetter(
  ai: Anthropic,
  job: JobPosting,
  profile: SearchProfile,
  matchReasons: string[],
): Promise<string> {
  const isProductCompany = !/(consulting|conseil|agency|agence|ssii|ess|outsourcing)/i.test(
    `${job.company} ${job.companySummary} ${job.description.slice(0, 300)}`,
  );

  const companyType = isProductCompany
    ? 'product company (building their own software/platform)'
    : 'service/consulting company (working with multiple clients)';

  const prompt = `You are ${profile.candidate.name}, a backend engineer with ${profile.candidate.experienceYears} years of experience in Node.js, TypeScript, NestJS, PostgreSQL, and REST APIs. You are based in Paris and looking for a new role.

Write a cover letter for this job. CRITICAL RULES:
- Sound completely human, conversational, and genuine — NOT AI-generated
- Mention the company by name and what they specifically do or build (based on the job description)
- For a ${companyType}: express why ${isProductCompany ? 'working on their specific product excites you' : 'working across different client projects appeals to you'}
- Reference 1-2 specific technical things from the job description that match your experience
- Keep it under 180 words
- No buzzwords like "passionate", "leverage", "synergy", "utilize", "excited to contribute"
- Write in first person, direct tone, like a real person not a chatbot
- End naturally, not with generic "I look forward to hearing from you" boilerplate

Job: ${job.title} at ${job.company}
Location: ${job.locationLabel} (${job.workMode})
Key match reasons: ${matchReasons.slice(0, 3).join('; ')}
Job description excerpt: ${job.description.slice(0, 600)}

Write the cover letter now (just the letter body, no subject line):`;

  const response = await ai.messages.create(
    {
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    },
    { timeout: TIMEOUT_MS },
  );

  return response.content[0].type === 'text'
    ? response.content[0].text.trim()
    : buildFallbackCoverLetter(job, profile, matchReasons);
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
    `I am a Paris-based backend engineer with about ${profile.candidate.experienceYears} years of hands-on experience building Node.js and TypeScript systems in production.`,
    `What stood out to me here is ${reasonLine.toLowerCase()}, along with the overlap around APIs, data-intensive backend work, and product ownership.`,
    `My recent work has included REST APIs, PostgreSQL and MongoDB, Dockerized deployments, and backend services for fintech-style platforms where performance and reliability mattered every day.`,
    `I would be glad to bring that same practical backend ownership to ${job.company} and contribute quickly in an English-speaking team.`,
    '',
    'Best regards,',
    profile.candidate.name,
  ].join('\n');
}
