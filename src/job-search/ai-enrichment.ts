import Anthropic from '@anthropic-ai/sdk';
import { JobPosting, MatchResult, SearchProfile } from './types';

// Haiku 4.5: fast and cheap — appropriate for per-job enrichment every 3 hours.
// Upgrade to claude-sonnet-4-6 if cover letter quality needs improvement.
const MODEL = 'claude-haiku-4-5';

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

const FRAUD_SCHEMA = {
  type: 'object',
  properties: {
    fraudScore: {
      type: 'integer',
      description: '0 = clearly legitimate, 100 = obvious scam',
    },
    reasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3 specific fraud signals found, or empty array if none',
    },
  },
  required: ['fraudScore', 'reasons'],
  additionalProperties: false,
} as const;

async function detectFraud(
  ai: Anthropic,
  job: JobPosting,
): Promise<{ fraudScore: number; fraudReasons: string[]; isSuspicious: boolean }> {
  const response = await ai.messages.create({
    model: MODEL,
    max_tokens: 256,
    system:
      'You are a job fraud detection expert. Analyze job postings and score how suspicious they are. ' +
      'Signs of fraud: unrealistic salary, vague/copy-pasted description, no real company info, ' +
      'requests personal info upfront, grammar errors suggesting mass posting, ' +
      'too-good-to-be-true perks, no specific tech requirements for a tech role.',
    messages: [
      {
        role: 'user',
        content:
          `Title: ${job.title}\n` +
          `Company: ${job.company}\n` +
          `Location: ${job.locationLabel}\n` +
          `Salary: ${job.salaryMinimum ? `${job.salaryMinimum}–${job.salaryMaximum ?? '?'} ${job.salaryCurrency ?? ''}` : 'not listed'}\n` +
          `Description: ${job.description.slice(0, 700)}`,
      },
    ],
    output_config: {
      format: {
        type: 'json_schema',
        schema: FRAUD_SCHEMA,
      },
    },
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { fraudScore: 0, fraudReasons: [], isSuspicious: false };
  }

  const parsed = JSON.parse(textBlock.text) as { fraudScore?: number; reasons?: string[] };
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
    ? 'product company building their own software'
    : 'service or consulting company working with multiple clients';

  const response = await ai.messages.create({
    model: MODEL,
    max_tokens: 512,
    system:
      `You are ${profile.candidate.name}, a Paris-based backend engineer with ` +
      `${profile.candidate.experienceYears} years of experience in Node.js, TypeScript, ` +
      `NestJS, PostgreSQL, and REST APIs. Write cover letters that:\n` +
      `- Sound human, conversational, and genuine — not AI-generated\n` +
      `- Are under 180 words\n` +
      `- Mention the company by name and what they specifically do\n` +
      `- Reference 1-2 technical things from the job that match your background\n` +
      `- Avoid buzzwords: passionate, leverage, synergy, utilize, excited to contribute\n` +
      `- End naturally — not with "I look forward to hearing from you"`,
    messages: [
      {
        role: 'user',
        content:
          `Write a cover letter for: ${job.title} at ${job.company}\n` +
          `Company type: ${companyType}\n` +
          `Location: ${job.locationLabel} (${job.workMode})\n` +
          `Why it matches me: ${matchReasons.slice(0, 3).join('; ')}\n` +
          `Job description: ${job.description.slice(0, 600)}\n\n` +
          `Write just the letter body, no subject line:`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text'
    ? textBlock.text.trim()
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
