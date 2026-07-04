import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { detectLanguage } from './language-detect';

const SOURCE = 'justjoin.it';
const BASE_URL = 'https://justjoin.it';
const API_URL = 'https://justjoin.it/api/candidate-api/offers';

const SEARCH_QUERIES = ['nodejs', 'nestjs', 'typescript'];

const RELEVANT_TITLE_KEYWORDS = [
  'node', 'nest', 'typescript', 'javascript', 'backend', 'fullstack',
  'full-stack', 'full stack', 'software engineer', 'developer',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://justjoin.it/',
};

interface JustJoinEmploymentType {
  from?: number | null;
  to?: number | null;
  currency?: string | null;
}

interface JustJoinJob {
  guid: string;
  title?: string;
  companyName?: string;
  city?: string;
  workplaceType?: string;
  experienceLevel?: string;
  publishedAt?: string;
  slug?: string;
  employmentTypes?: JustJoinEmploymentType[];
}

interface JustJoinResponse {
  data?: JustJoinJob[];
}

export class JustJoinSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const seen = new Set<string>();
    const jobs: JobPosting[] = [];
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchQuery(query, cutoff);
        for (const job of fetched) {
          if (!seen.has(job.canonicalUrl)) {
            seen.add(job.canonicalUrl);
            jobs.push(job);
          }
        }
      } catch (err) {
        console.error(`[justjoin] error for "${query}":`, err instanceof Error ? err.message : String(err));
      }
      await sleep(2000);
    }

    console.log(`[justjoin] ${jobs.length} unique jobs fetched`);
    return jobs;
  }
}

async function fetchQuery(query: string, cutoff: number): Promise<JobPosting[]> {
  const res = await axios.get<JustJoinResponse>(API_URL, {
    params: { keywords: query, sortBy: 'publishedAt', orderBy: 'descending', page: 1, perPage: 50 },
    headers: HEADERS,
    timeout: 20_000,
    validateStatus: (s) => s < 500,
  });

  if (res.status === 403 || res.status === 429) {
    console.error('[justjoin] blocked:', res.status, query);
    return [];
  }

  const list: JustJoinJob[] = res.data?.data ?? [];
  if (list.length === 0) {
    console.log(`[justjoin] 0 jobs from API for "${query}" (status ${res.status})`);
    return [];
  }

  return list
    .filter((j) => {
      if (!j.publishedAt) return true;
      return new Date(j.publishedAt).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null)
    .filter((j) => isRelevant(j.title));
}

function mapJob(raw: JustJoinJob): JobPosting | null {
  if (!raw.title || !raw.slug) return null;

  const canonicalUrl = `${BASE_URL}/job-offers/${raw.slug}`;
  const company = raw.companyName ?? 'Unknown';
  const city = raw.city ?? '';
  const locationLabel = city ? `${city}, Poland` : 'Poland';

  const employment = raw.employmentTypes?.[0];
  const salaryMin = employment?.from ?? null;
  const salaryMax = employment?.to ?? null;
  const currency = employment?.currency ?? null;

  const publishedAt = raw.publishedAt ? new Date(raw.publishedAt) : new Date();
  const workMode = inferWorkMode(raw.workplaceType ?? '');

  return {
    source: SOURCE,
    sourcePriority: 5,
    canonicalUrl,
    title: raw.title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: 'PL',
    city: city || null,
    workMode,
    language: detectLanguage(raw.title),
    description: '',
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: currency,
    salaryPeriod: salaryMin ? 'monthly' : null,
    salaryMinimum: salaryMin,
    salaryMaximum: salaryMax,
    salaryYearlyMinimum: salaryMin && currency === 'PLN' ? salaryMin * 12 : salaryMin,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: false,
    isStartup: false,
    employeeCount: null,
    companyCreationYear: null,
  };
}

function isRelevant(title: string): boolean {
  const t = title.toLowerCase();
  return RELEVANT_TITLE_KEYWORDS.some((kw) => t.includes(kw));
}

function inferWorkMode(workplaceType: string): 'remote' | 'hybrid' | 'on-site' {
  const w = workplaceType.toLowerCase();
  if (w === 'remote' || w === 'fully_remote') return 'remote';
  if (w === 'hybrid') return 'hybrid';
  return 'on-site';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
