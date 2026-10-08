import { JobPosting, SearchSettings } from '../types';
import { inferCountryCode } from './country-codes';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { ENGLISH_KEYWORDS } from '../keywords';
import { postDateFrom } from './post-date';
import { mapJobsSafely } from './shared-scraper';

const SOURCE = 'remotive.com';

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
}

interface RemotiveResponse {
  jobs: RemotiveJob[];
}

// July 13 2026 keyword consolidation — full English set.
const KEY_QUERIES = ENGLISH_KEYWORDS;

export class RemotiveJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

    for (const query of KEY_QUERIES) {
      try {
        const results = await fetchRemotive(query, settings);
        for (const job of results) {
          jobs.set(job.canonicalUrl, job);
        }
        await sleep(600);
      } catch (error) {
        console.error(`[remotive] error for "${query}":`, error instanceof Error ? error.message : String(error));
      }
    }

    return Array.from(jobs.values());
  }
}

export async function fetchRemotive(query: string, settings: SearchSettings): Promise<JobPosting[]> {
  const params = new URLSearchParams({
    category: 'software-dev',
    search: query,
    limit: '100',
  });

  const response = await fetch(`https://remotive.com/api/remote-jobs?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Remotive API error: ${response.status}`);
  }

  const data = (await response.json()) as RemotiveResponse;
  // Capped at 72h so this source never looks further back than the global maxAgeHours rule.
  const lookbackHours = Math.min(settings.maxAgeHours, 72);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  // Undated jobs pass here with a null date; run.ts's no-post-date rule handles them.
  const fresh = data.jobs.filter((job) => {
    const ts = postDateFrom(job.publication_date).publishedAtTimestamp;
    return ts === null || ts * 1000 >= cutoff;
  });

  if (data.jobs.length > 0 && fresh.length === 0) {
    console.log(`[remotive] "${query}": ${data.jobs.length} total jobs but none posted in last ${lookbackHours}h`);
  }

  return mapJobsSafely(fresh, mapJob, 'remotive');
}

export function mapJob(job: RemotiveJob): JobPosting {
  const text = `${job.title} ${job.description} ${job.candidate_required_location}`.toLowerCase();
  // Real posting date, or null when missing/unparseable (tagged "no-post-date" in run.ts).
  const postDate = postDateFrom(job.publication_date);

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl: job.url,
    title: job.title,
    company: job.company_name,
    companySummary: '',
    companySlug: job.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: job.candidate_required_location || 'Remote',
    countryCode: inferCountryCode(job.candidate_required_location),
    city: null,
    workMode: 'remote',
    language: detectLanguage(`${job.title} ${stripHtml(job.description)}`),
    description: stripHtml(job.description),
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    ...postDate,
    startupSignals: [],
    applyUrl: job.url,
    offersRelocation: false,
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
