import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'jobicy.com';

interface JobicyJob {
  id: number;
  url: string;
  jobTitle: string;
  companyName: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  annualSalaryMin?: number | null;
  annualSalaryMax?: number | null;
  salaryCurrency?: string | null;
}

interface JobicyResponse {
  jobs?: JobicyJob[];
  data?: JobicyJob[];
}

const QUERIES = [
  { tag: 'node.js' },
  { tag: 'typescript' },
  { tag: 'backend-engineer' },
];

export class JobicyJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

    for (const { tag } of QUERIES) {
      try {
        const results = await fetchJobs(tag, settings);
        for (const job of results) {
          jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('fetch failed') && !msg.includes('403')) {
          console.error(`[jobicy] error for "${tag}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) {
      console.log('[jobicy] 0 relevant jobs found');
    } else {
      console.log(`[jobicy] ${jobs.size} unique relevant jobs`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchJobs(tag: string, settings: SearchSettings): Promise<JobPosting[]> {
  const params = new URLSearchParams({
    count: '50',
    tag,
  });

  const response = await fetch(`https://jobicy.com/api/v2/remote-jobs?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });

  if (response.status === 403 || response.status === 429) {
    console.log(`[jobicy] blocked by ${response.status} for tag="${tag}" — cloud IP or rate limit`);
    return [];
  }
  if (!response.ok) throw new Error(`Jobicy API ${response.status}`);

  const data = (await response.json()) as JobicyResponse;
  const jobList = data.jobs ?? data.data ?? [];

  if (!Array.isArray(jobList)) return [];

  // Use 7-day minimum so low-volume tags don't always return 0.
  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  return jobList
    .filter((job) => {
      if (!job.pubDate) return true;
      return new Date(job.pubDate).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

function mapJob(job: JobicyJob): JobPosting | null {
  if (!job.url || !job.jobTitle) return null;

  const description = stripHtml(job.jobDescription ?? job.jobExcerpt ?? '');
  const text = `${job.jobTitle} ${description}`.toLowerCase();
  const location = job.jobGeo ?? 'Remote';

  const dateStr = job.pubDate ?? new Date().toISOString();
  const publishedAt = new Date(dateStr);
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);
  if (isNaN(publishedAtTimestamp)) return null;

  const salaryMin = job.annualSalaryMin ?? null;
  const salaryMax = job.annualSalaryMax ?? null;
  const currency = job.salaryCurrency ?? null;

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl: job.url,
    title: job.jobTitle,
    company: job.companyName ?? 'Unknown',
    companySummary: '',
    companySlug: (job.companyName ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: location,
    countryCode: inferCountryCode(location),
    city: null,
    workMode: 'remote',
    language: detectLanguage(`${job.jobTitle} ${description}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: salaryMin !== null ? (currency ?? 'USD') : null,
    salaryPeriod: salaryMin !== null ? 'yearly' : null,
    salaryMinimum: salaryMin,
    salaryMaximum: salaryMax,
    salaryYearlyMinimum: salaryMin,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: job.url,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsorship', 'visa sponsor']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferCountryCode(location: string): string | null {
  const l = location.toLowerCase();
  if (l.includes('france') || l.includes('paris')) return 'FR';
  if (l.includes('germany') || l.includes('berlin') || l.includes('munich') || l.includes('hamburg')) return 'DE';
  if (l.includes('belgium') || l.includes('brussels')) return 'BE';
  if (l.includes('luxembourg')) return 'LU';
  if (l.includes('netherlands') || l.includes('amsterdam')) return 'NL';
  if (l.includes('uk') || l.includes('united kingdom') || l.includes('london')) return 'GB';
  if (l.includes('europe') || l.includes('eu') || l.includes('worldwide') || l.includes('anywhere') || l.includes('remote') || l === 'global') return 'FR';
  return null;
}

function extractExperienceMinimum(text: string): number | null {
  const plusMatch = text.match(/(\d+)\+\s*years?/i);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const rangeMatch = text.match(/(\d+)\s*(?:to|-)\s*\d+\s+years?/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);
  const patterns = [
    /(?:minimum|at\s+least|min\.?)\s+(\d+)\s+years?/i,
    /(\d+)\s+years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
    /experience\s*(?:of\s+)?(\d+)\s+years?/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
