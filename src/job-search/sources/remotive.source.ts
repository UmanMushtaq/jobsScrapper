import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

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

const KEY_QUERIES = ['Node.js backend', 'TypeScript backend', 'NestJS', 'Backend Engineer'];

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

async function fetchRemotive(query: string, settings: SearchSettings): Promise<JobPosting[]> {
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
  // Remotive is a slow-posting board: use 7-day lookback so low-volume queries
  // don't always return zero results. sentUrls prevents re-sending already-sent jobs.
  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const fresh = data.jobs.filter((job) => new Date(job.publication_date).getTime() >= cutoff);

  if (data.jobs.length > 0 && fresh.length === 0) {
    console.log(`[remotive] "${query}": ${data.jobs.length} total jobs but none posted in last ${lookbackHours}h`);
  }

  return fresh.map(mapJob);
}

function mapJob(job: RemotiveJob): JobPosting {
  const text = `${job.title} ${job.description} ${job.candidate_required_location}`.toLowerCase();
  const publishedAt = new Date(job.publication_date);

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
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: job.url,
    offersRelocation: false,
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferCountryCode(location: string): string | null {
  const loc = location.toLowerCase();
  if (loc.includes('france') || loc.includes('paris')) return 'FR';
  if (loc.includes('germany') || loc.includes('berlin') || loc.includes('munich') || loc.includes('hamburg')) return 'DE';
  if (loc.includes('belgium') || loc.includes('brussels')) return 'BE';
  if (loc.includes('luxembourg')) return 'LU';
  if (loc.includes('netherlands') || loc.includes('amsterdam')) return 'NL';
  if (loc.includes('uk') || loc.includes('united kingdom') || loc.includes('london')) return 'GB';
  if (loc.includes('europe') || loc.includes('eu') || loc.includes('worldwide') || loc.includes('anywhere')) return 'FR';
  return null;
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
