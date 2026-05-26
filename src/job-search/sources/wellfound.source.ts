import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

const SOURCE = 'wellfound.com';

// Wellfound is a Next.js app — job data lives in __NEXT_DATA__ on SSR pages.
// Cloud provider IPs (Render) may be blocked; fails silently like RemoteOK.

const SEARCH_URLS = [
  'https://wellfound.com/role/r/backend-engineer?remote=true',
  'https://wellfound.com/role/r/software-engineer?remote=true',
];

const RELEVANT_KEYWORDS = ['node', 'typescript', 'javascript', 'backend', 'nestjs', 'express', 'postgresql'];

export class WellfoundJobsSource implements JobSource {
  name = SOURCE;
  priority = 2;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs: JobPosting[] = [];
    const seen = new Set<string>();
    const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

    for (const url of SEARCH_URLS) {
      try {
        const pageJobs = await fetchFromPage(url, cutoff);
        for (const job of pageJobs) {
          if (!seen.has(job.canonicalUrl)) {
            seen.add(job.canonicalUrl);
            jobs.push(job);
          }
        }
      } catch (err) {
        console.log(`[wellfound] blocked or error (cloud IP likely blocked): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (jobs.length === 0) {
      console.log('[wellfound] 0 jobs — Wellfound blocks cloud IPs (Render), expected to fail silently');
    }
    return jobs;
  }
}

async function fetchFromPage(url: string, cutoff: number): Promise<JobPosting[]> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (res.status === 403 || res.status === 429) return [];
  if (!res.ok) return [];

  const html = await res.text();

  // Extract __NEXT_DATA__ JSON embedded by Next.js
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (!match) return [];

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return [];
  }

  // Traverse the nested Next.js props to find job listings
  const listings = extractJobListings(data);
  const relevant = listings.filter((j) => isRelevant(j));
  const fresh = relevant.filter((j) => j.publishedAtTimestamp * 1000 >= cutoff);
  return fresh;
}

function extractJobListings(data: Record<string, unknown>): JobPosting[] {
  // Walk nested objects looking for arrays that look like job listings
  const jobs: JobPosting[] = [];
  walkObject(data, jobs);
  return jobs;
}

function walkObject(obj: unknown, jobs: JobPosting[], depth = 0): void {
  if (depth > 8 || !obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const mapped = tryMapJob(item);
      if (mapped) {
        jobs.push(mapped);
      } else {
        walkObject(item, jobs, depth + 1);
      }
    }
    return;
  }

  for (const val of Object.values(obj as Record<string, unknown>)) {
    walkObject(val, jobs, depth + 1);
  }
}

interface WellfoundJob {
  id?: string | number;
  slug?: string;
  title?: string;
  jobType?: string;
  remote?: boolean;
  locationNames?: string[];
  description?: string;
  minCompensation?: number;
  maxCompensation?: number;
  compensation?: string;
  createdAt?: string;
  liveStartAt?: string;
  startup?: {
    name?: string;
    slug?: string;
    companySize?: string;
    description?: string;
    highConcept?: string;
    website?: string;
    productDesc?: string;
    companyType?: string;
    foundedDate?: string;
  };
}

function tryMapJob(raw: unknown): JobPosting | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const j = raw as WellfoundJob;

  if (!j.title || !j.startup?.name) return null;
  if (typeof j.id !== 'string' && typeof j.id !== 'number') return null;

  const slug = j.slug ?? String(j.id);
  const companySlug = j.startup.slug ?? j.startup.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const canonicalUrl = `https://wellfound.com/jobs/${companySlug}/${slug}`;

  const workMode: 'remote' | 'hybrid' | 'on-site' =
    j.remote === true ? 'remote'
    : (j.locationNames ?? []).some((l) => /hybrid/i.test(l)) ? 'hybrid'
    : 'on-site';

  const locationLabel = (j.locationNames ?? []).join(', ') || (workMode === 'remote' ? 'Remote' : '');
  // Set countryCode even for remote jobs so the location filter can enforce usaJobs:false
  const countryCode = guessCountryCode(locationLabel);

  const description = j.description ?? j.startup.description ?? j.startup.highConcept ?? '';
  const publishedAt = j.liveStartAt ?? j.createdAt ?? new Date().toISOString();
  const publishedAtTimestamp = Math.floor(new Date(publishedAt).getTime() / 1000);
  if (isNaN(publishedAtTimestamp)) return null;

  const founded = j.startup.foundedDate ? parseInt(j.startup.foundedDate.slice(0, 4)) : null;

  return {
    source: SOURCE,
    sourcePriority: 2,
    canonicalUrl,
    title: j.title,
    company: j.startup.name,
    companySummary: j.startup.highConcept ?? j.startup.description ?? '',
    companySlug,
    locationLabel,
    countryCode,
    city: null,
    workMode,
    language: 'en',
    description,
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: j.minCompensation ? 'USD' : null,
    salaryPeriod: j.minCompensation ? 'yearly' : null,
    salaryMinimum: j.minCompensation ?? null,
    salaryMaximum: j.maxCompensation ?? null,
    salaryYearlyMinimum: j.minCompensation ?? null,
    publishedAt,
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: false,
    isStartup: true,
    employeeCount: parseEmployeeCount(j.startup.companySize),
    companyCreationYear: founded,
  };
}

function isRelevant(job: JobPosting): boolean {
  const text = `${job.title} ${job.description}`.toLowerCase();
  return RELEVANT_KEYWORDS.some((kw) => text.includes(kw));
}

function parseEmployeeCount(size: string | undefined): number | null {
  if (!size) return null;
  const match = size.match(/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function guessCountryCode(location: string): string | null {
  const l = location.toUpperCase();
  if (l.includes('UNITED STATES') || l.includes('USA') || l.includes(' CA') || l.includes(' NY')) return 'US';
  if (l.includes('UNITED KINGDOM') || l.includes('LONDON')) return 'GB';
  if (l.includes('GERMANY') || l.includes('BERLIN')) return 'DE';
  if (l.includes('FRANCE') || l.includes('PARIS')) return 'FR';
  if (l.includes('NETHERLANDS') || l.includes('AMSTERDAM')) return 'NL';
  if (l.includes('POLAND') || l.includes('WARSAW')) return 'PL';
  if (l.includes('SWEDEN') || l.includes('STOCKHOLM')) return 'SE';
  if (l.includes('SPAIN') || l.includes('MADRID') || l.includes('BARCELONA')) return 'ES';
  if (l.includes('IRELAND') || l.includes('DUBLIN')) return 'IE';
  return null;
}
