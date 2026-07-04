import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { isRelevantJob } from './shared-scraper';

const SOURCE = 'himalayas.app';

export interface HimalayasJob {
  guid?: string;
  title?: string;
  companyName?: string;
  applicationLink?: string;
  description?: string;
  pubDate?: number;
  locationRestrictions?: string[];
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string | null;
  seniority?: string[];
}

interface HimalayasResponse {
  jobs?: HimalayasJob[];
  totalCount?: number;
}

const SEARCH_QUERIES = ['nodejs', 'node.js', 'node js', 'nestjs', 'nest.js', 'nest js', 'typescript backend', 'typescript'];

// EU/EEA allowlist for Himalayas' locationRestrictions field. If a job lists
// restrictions and NONE of them match this list, the job is scoped to a
// region we can't take (US, Canada, LATAM, APAC, etc.) and is dropped.
const EU_EEA_ALLOWLIST = [
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech', 'denmark', 'estonia',
  'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia',
  'lithuania', 'luxembourg', 'malta', 'netherlands', 'poland', 'portugal', 'romania',
  'slovakia', 'slovenia', 'spain', 'sweden',
  'united kingdom', 'norway', 'switzerland', 'iceland',
  'europe', 'emea', 'worldwide', 'global', 'anywhere',
];

export class HimalayasSource implements JobSource {
  name = SOURCE;
  priority = 5;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchQuery(query, cutoff);
        for (const job of fetched) jobs.set(job.canonicalUrl, job);
      } catch (err) {
        console.error(`[himalayas] error for "${query}": ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(1000);
    }

    if (jobs.size === 0) console.log('[himalayas] 0 jobs fetched');
    else console.log(`[himalayas] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchQuery(query: string, cutoff: number): Promise<JobPosting[]> {
  const url = `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&page=1`;

  const res = await axios.get<HimalayasResponse>(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 20_000,
    validateStatus: (s) => s < 500,
  });

  if (res.status !== 200) {
    console.error(`[himalayas] API returned ${res.status} for "${query}"`);
    return [];
  }

  const list: HimalayasJob[] = res.data?.jobs ?? [];

  return list
    .filter((j) => {
      if (!j.pubDate) return true;
      return j.pubDate * 1000 >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

export function mapJob(j: HimalayasJob): JobPosting | null {
  if (!j.guid || !j.title || !j.applicationLink) return null;

  const title = j.title;
  const company = j.companyName ?? 'Unknown';
  const description = stripHtml(j.description ?? '');

  if (!isRelevantJob(title, description)) return null;

  const restrictions = j.locationRestrictions ?? [];
  if (restrictions.length > 0) {
    const allowed = restrictions.some((r) =>
      EU_EEA_ALLOWLIST.some((a) => r.toLowerCase().includes(a)),
    );
    if (!allowed) {
      console.log(`[himalayas] FILTERED non-EU remote: ${company} — ${restrictions.join(', ')}`);
      return null;
    }
  }

  const text = `${title} ${description}`.toLowerCase();
  const publishedAt = j.pubDate ? new Date(j.pubDate * 1000) : new Date();
  const salaryMin = j.minSalary ?? null;
  const salaryMax = j.maxSalary ?? null;
  const salaryCurrency = j.currency ?? null;

  return {
    source: SOURCE,
    sourcePriority: 5,
    canonicalUrl: j.applicationLink,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: j.locationRestrictions?.join(', ') || 'Remote',
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
    applyUrl: j.applicationLink,
    offersRelocation: false,
    isStartup: text.includes('startup') || text.includes('seed'),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
