import { JobPosting, SearchSettings } from '../types';
import { inferCountryCode } from './country-codes';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'jobs.ashbyhq.com';
const API_BASE = 'https://api.ashbyhq.com/posting-api/job-board';

// EU-focused tech companies known to use Ashby for hiring
const DEFAULT_COMPANIES = [
  // French companies
  'qonto', 'alan', 'ledger', 'dataiku', 'deepki', 'toucan-toco',
  'shine', 'memo-bank', 'oblean', 'backmarket', 'vestiairecollective',
  // UK / EU scale-ups
  'monzo', 'revolut', 'wise', 'checkout', 'yapily', 'truelayer',
  'starling-bank', 'pleo', 'klarna', 'sumup', 'moss',
  // broader EU tech
  'contentful', 'personio', 'babbel', 'tier', 'gorillas',
  'mambu', 'leanix', 'moss-group', 'nelly-solutions',
];

interface AshbyJobPosting {
  id: string;
  title: string;
  locationName: string;
  isRemote: boolean;
  descriptionHtml: string;
  applyLink: string;
  publishedDate: string;
  teamName?: string;
  employmentType?: string;
}

interface AshbyResponse {
  jobPostings: AshbyJobPosting[];
}

export class AshbyJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const envCompanies = process.env.ASHBY_COMPANIES;
    const companies = envCompanies
      ? envCompanies.split(',').map((c) => c.trim().toLowerCase())
      : DEFAULT_COMPANIES;

    const jobs = new Map<string, JobPosting>();
    const queryTerms = queries.map((q) => q.toLowerCase());
    let totalFound = 0;
    let companiesWithJobs = 0;

    for (const company of companies) {
      try {
        const results = await fetchCompanyJobs(company, settings);
        const relevant = results.filter((job) => isRelevant(job.title, queryTerms));
        if (relevant.length > 0) companiesWithJobs++;
        totalFound += relevant.length;
        for (const job of relevant) {
          jobs.set(job.canonicalUrl, job);
        }
        await sleep(400);
      } catch (error) {
        console.error(
          `[ashby] error for "${company}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (totalFound === 0) {
      console.log(`[ashby] 0 relevant jobs across ${companies.length} companies within ${settings.maxAgeHours}h window`);
    } else {
      console.log(`[ashby] ${totalFound} relevant jobs from ${companiesWithJobs}/${companies.length} companies`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchCompanyJobs(company: string, settings: SearchSettings): Promise<JobPosting[]> {
  const response = await fetch(`${API_BASE}/${company}`, {
    headers: { Accept: 'application/json' },
  });

  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Ashby API error ${response.status} for ${company}`);

  const data = (await response.json()) as AshbyResponse;
  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  return data.jobPostings
    .filter((job) => {
      if (!job.publishedDate) return true; // include if no date
      return new Date(job.publishedDate).getTime() >= cutoff;
    })
    .map((job) => mapJob(job, company));
}

function mapJob(job: AshbyJobPosting, companySlug: string): JobPosting {
  const description = stripHtml(job.descriptionHtml ?? '');
  const text = `${job.title} ${description} ${job.locationName ?? ''}`.toLowerCase();
  const publishedAt = job.publishedDate ? new Date(job.publishedDate) : new Date();
  const workMode = job.isRemote ? 'remote' : inferWorkMode(text);
  const applyUrl = job.applyLink || `https://jobs.ashbyhq.com/${companySlug}/${job.id}`;
  const canonicalUrl = `https://jobs.ashbyhq.com/${companySlug}/${job.id}`;

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl,
    title: job.title,
    company: toCompanyName(companySlug),
    companySummary: '',
    companySlug,
    locationLabel: job.locationName || (job.isRemote ? 'Remote' : 'Unknown'),
    countryCode: inferCountryCode(job.locationName ?? ''),
    city: inferCity(job.locationName ?? ''),
    workMode,
    language: detectLanguage(`${job.title} ${description.slice(0, 400)}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsor', 'visa support', 'work permit', 'sponsorship']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function isRelevant(title: string, queryTerms: string[]): boolean {
  const t = title.toLowerCase();
  const backendTerms = ['backend', 'back-end', 'node', 'typescript', 'software engineer', 'fullstack', 'full stack', 'api', 'platform engineer'];
  return (
    queryTerms.some((q) => t.includes(q)) ||
    backendTerms.some((term) => t.includes(term))
  );
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['full remote', 'fully remote', '100% remote', 'remote only', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail partiel', 'partial remote', 'work from home'])) return 'hybrid';
  return 'on-site';
}

function inferCity(location: string): string | null {
  const known = ['Paris', 'London', 'Berlin', 'Amsterdam', 'Barcelona', 'Madrid', 'Dublin', 'Zurich', 'Brussels', 'Stockholm'];
  for (const city of known) {
    if (location.toLowerCase().includes(city.toLowerCase())) return city;
  }
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

function toCompanyName(slug: string): string {
  return slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
