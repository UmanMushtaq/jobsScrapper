import { MatchResult, JobPosting, SearchProfile } from './types';

export function scoreJob(job: JobPosting, profile: SearchProfile): MatchResult | null {
  const title = job.title.toLowerCase();
  const text = [job.title, job.description, job.companySummary, ...job.keyMissions]
    .join(' ')
    .toLowerCase();

  // 1. Language
  if (job.language?.toLowerCase() !== profile.search.language.toLowerCase()) return null;

  // 2. Excluded titles
  if (profile.search.excludedTitleKeywords.some(kw => title.includes(kw))) return null;

  // 3. Required keywords - at least 2 (your original requirement)
  const matchedKeywords = profile.search.requiredKeywords.filter(kw =>
    title.includes(kw.toLowerCase()) || text.includes(kw.toLowerCase())
  );
  if (matchedKeywords.length < 2) return null;

  // 4. Experience
  if (job.experienceLevelMinimum !== null) {
    if (job.experienceLevelMinimum < profile.search.experience.min || 
        job.experienceLevelMinimum > profile.search.experience.max) {
      return null;
    }
  }

  // 5. Salary (if provided)
  if (job.salaryMinimum && job.salaryCurrency === 'EUR') {
    const monthly = job.salaryPeriod === 'month' ? job.salaryMinimum : Math.round(job.salaryMinimum / 12);
    if (monthly < profile.search.minimumSalaryMonthlyEur) return null;
  }

  console.log(`[MATCHER] PASSED → ${job.title} | ${job.company} | Score: 85% | Keywords: ${matchedKeywords.join(', ')}`);

  const salaryLabel = job.salaryMinimum 
    ? `~EUR ${job.salaryMinimum}/month` 
    : 'salary not listed';

  return {
    job,
    score: 85,
    reasons: matchedKeywords,
    startupScore: 0,
    salaryLabel,
    coverLetter: buildCoverLetter(job, profile, matchedKeywords),
    shortAnswers: buildShortAnswers(job),
  };
}

function buildCoverLetter(job: JobPosting, profile: SearchProfile, reasons: string[]): string {
  return [
    `Hello ${job.company} team,`,
    '',
    `I am a Paris-based backend engineer with 4+ years building scalable systems in Node.js, TypeScript, Nest.js, PostgreSQL, Docker and microservices.`,
    `Your role matches my experience perfectly, especially ${reasons.join(', ')}.`,
    '',
    `I am immediately available for remote or Paris-based English-speaking roles.`,
    '',
    'Best regards,',
    profile.candidate.name,
  ].join('\n');
}

function buildShortAnswers(job: JobPosting): string[] {
  return [
    `Why this role: Strong match with my Node.js / TypeScript backend experience`,
    `Why this company: English-speaking EU/remote role that fits my profile`,
  ];
}