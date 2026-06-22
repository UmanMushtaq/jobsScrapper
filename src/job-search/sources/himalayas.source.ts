import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { sleep, isRelevantJob, stripHtml } from './shared-scraper';

const SOURCE = 'himalayas.app';

interface HimalayasJob {
  slug?: string;
  title?: string;
  companyName?: string;
  company?: { name?: string; slug?: string };
  locationRestrictions?: string[];
  jobType?: string;
  description?: string;
  salary?: { min?: number; max?: number; currency?: string };
  publishedAt?: string;
  createdAt?: string;
}

const SEARCH_KEYWORDS = ['nodejs', 'node.js', 'NestJS', 'nestjs', 'typescript'];

export class HimalayasSource implements JobSource {
  name = SOURCE;
  priority = 5;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const keyword of SEARCH_KEYWORDS) {
      try {
        const fetched = await fetchKeyword(keyword, cutoff);
        for (const job of fetched) jobs.set(job.canonicalUrl, job);
        await sleep(1500);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[himalayas] error for "${keyword}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) console.log(`[himalayas] 0 jobs — may be blocked`);
    else console.log(`[himalayas] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchKeyword(keyword: string, cutoff: number): Promise<JobPosting[]> {
  // Himalayas has a public JSON API — no ScraperAPI needed
  const url = `https://himalayas.app/jobs/api?q=${encodeURIComponent(keyword)}&limit=50`;

  let res;
  try {
    res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 20_000,
      validateStatus: (s) => s < 500,
    });
  } catch { return []; }

  if (res.status !== 200) {
    console.log(`[himalayas] API returned ${res.status} for "${keyword}"`);
    return [];
  }

  const body = res.data;
  const list: HimalayasJob[] = Array.isArray(body)
    ? body
    : (body?.jobs ?? body?.data ?? body?.results ?? []);

  return list
    .filter((j) => {
      const pub = j.publishedAt ?? j.createdAt;
      return !pub || new Date(pub).getTime() >= cutoff;
    })
    .map((j) => mapJob(j))
    .filter((j): j is JobPosting => j !== null);
}

function mapJob(j: HimalayasJob): JobPosting | null {
  const title = j.title;
  if (!title) return null;

  const slug = j.slug;
  if (!slug) return null;

  const canonicalUrl = `https://himalayas.app/jobs/${slug}`;
  const company = j.companyName ?? j.company?.name ?? 'Unknown';
  const description = stripHtml(j.description ?? '');

  if (!isRelevantJob(title, description)) return null;

  const text = `${title} ${description}`.toLowerCase();
  const publishedAt = j.publishedAt ?? j.createdAt ? new Date(j.publishedAt ?? j.createdAt!) : new Date();
  const salaryMin = j.salary?.min ?? null;
  const salaryMax = j.salary?.max ?? null;
  const salaryCurrency = j.salary?.currency ?? null;

  return {
    source: SOURCE,
    sourcePriority: 5,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: 'Remote',
    countryCode: 'REMOTE',
    city: null,
    workMode: 'remote',
    language: detectLanguage(`${title} ${description.slice(0, 400)}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency,
    salaryPeriod: salaryMin !== null ? 'yearly' : null,
    salaryMinimum: salaryMin,
    salaryMaximum: salaryMax,
    salaryYearlyMinimum: salaryMin,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: false,
    isStartup: text.includes('startup') || text.includes('seed'),
    employeeCount: null,
    companyCreationYear: null,
  };
}
