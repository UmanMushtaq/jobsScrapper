import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { RawJob, RELOCATION_KEYWORDS, extractJobsFromHtml, mapRawJob } from './shared-scraper';
import { ENGLISH_KEYWORDS, GERMAN_KEYWORDS } from '../keywords';

const SOURCE = 'jobware.de';
const BASE_URL = 'https://www.jobware.de';
const API_URL = 'https://www.jobware.de/api/d48b2/xnfwe';
// Fallback if the versioned API path above 404s/changes shape — this sandbox cannot
// reach jobware.de to confirm either endpoint is still live (see the Germany-coverage
// report's network-blocked section), so both a working API and a working HTML search
// page are exercised rather than betting the whole source on one guessed URL.
const SEARCH_PAGE_URL = 'https://www.jobware.de/jobs';

// jobware.de's jw_jobname param searches German job TITLES only, and 'nestjs'/'nest.js'/
// 'nest js' confirmed return 0 results here (verified previously) since German titles
// almost never contain "nestjs" — every "nest"-containing canonical keyword is filtered
// out here specifically for that reason (July 13 2026 keyword consolidation: sourced
// from the canonical English + German lists, minus this one confirmed-dead term family;
// do not add "nest" terms back for this source without re-verifying).
const SEARCH_QUERIES = [...ENGLISH_KEYWORDS, ...GERMAN_KEYWORDS].filter((k) => !/nest/i.test(k));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.jobware.de/',
};

const RELEVANT_KEYWORDS = ['backend', 'back-end', 'node', 'typescript', 'javascript', 'nestjs', 'software engineer', 'engineer', 'developer', 'software', 'fullstack', 'full stack', 'full-stack', 'api engineer', 'platform'];
const EXCLUDED_KEYWORDS = ['frontend', 'front-end', 'react', 'vue', 'angular', 'ios', 'android', 'mobile', 'devops', 'data engineer', 'machine learning', 'ai engineer', 'site reliability', 'sre'];

interface JobwareJob {
  id: string | number;
  title?: string;
  location?: string;
  advertiser?: { name?: string };
  apply?: { url?: string };
  url?: string;
  task?: string;
  date?: number;
}

interface JobwareResponse {
  data?: JobwareJob[];
}

export class JobwareSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const seen = new Set<string>();
    const jobs: JobPosting[] = [];
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchQuery(query, cutoff);
        for (const job of fetched) {
          const key = String(job.canonicalUrl);
          if (!seen.has(key)) {
            seen.add(key);
            jobs.push(job);
          }
        }
      } catch (err) {
        console.error(`[jobware] error for "${query}":`, err instanceof Error ? err.message : String(err));
      }
      await sleep(2000);
    }

    if (jobs.length === 0) console.log('[jobware] 0 jobs — may be blocked or no results');
    else console.log(`[jobware] ${jobs.length} unique jobs fetched`);
    return jobs;
  }
}

async function fetchQuery(query: string, cutoff: number): Promise<JobPosting[]> {
  const apiJobs = await fetchViaApi(query, cutoff);
  if (apiJobs.length > 0) return apiJobs;

  return fetchViaHtmlFallback(query, cutoff);
}

async function fetchViaApi(query: string, cutoff: number): Promise<JobPosting[]> {
  let res;
  try {
    res = await axios.get<JobwareResponse>(API_URL, {
      params: { jw_jobname: query },
      headers: HEADERS,
      timeout: 20_000,
      validateStatus: (s) => s < 500,
    });
  } catch (err) {
    console.log(`[jobware] API request failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  if (res.status === 403 || res.status === 429) {
    console.error('[jobware] blocked:', res.status, query);
    return [];
  }
  if (res.status === 404) {
    console.log(`[jobware] API endpoint 404 for "${query}" — falling back to HTML search page`);
    return [];
  }

  const list: JobwareJob[] = res.data?.data ?? [];
  if (list.length === 0) {
    console.log(`[jobware] 0 jobs from API for "${query}" (status ${res.status})`);
    return [];
  }

  return list
    .filter((j) => !j.date || j.date >= cutoff)
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null)
    .filter((j) => isRelevant(j.title));
}

async function fetchViaHtmlFallback(query: string, cutoff: number): Promise<JobPosting[]> {
  let res;
  try {
    res = await axios.get<string>(SEARCH_PAGE_URL, {
      params: { jw_jobname: query },
      headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      timeout: 20_000,
      responseType: 'text',
      validateStatus: (s) => s < 500,
    });
  } catch {
    return [];
  }

  if (res.status !== 200 || typeof res.data !== 'string') return [];

  const rawJobs: RawJob[] = extractJobsFromHtml(res.data, BASE_URL);
  return rawJobs
    .filter((j) => {
      const d = j.datePosted ?? j.publishedAt;
      return !d || new Date(d).getTime() >= cutoff;
    })
    .map((j) => mapRawJob(j, SOURCE, 4, 'DE', 'Germany', BASE_URL))
    .filter((j): j is JobPosting => j !== null)
    .filter((j) => isRelevant(j.title));
}

function mapJob(raw: JobwareJob): JobPosting | null {
  if (!raw.title) return null;

  const relPath = raw.url ?? '';
  const canonicalUrl = relPath.startsWith('http') ? relPath : `${BASE_URL}/${relPath.replace(/^\//, '')}`;
  if (!canonicalUrl || canonicalUrl === BASE_URL + '/') return null;

  const applyUrl = raw.apply?.url ?? canonicalUrl;
  const company = raw.advertiser?.name ?? 'Unknown';
  const locationLabel = raw.location ? `${raw.location}, Germany` : 'Germany';
  const description = raw.task ?? '';
  const text = `${raw.title} ${description}`.toLowerCase();
  const publishedAt = raw.date ? new Date(raw.date) : new Date();

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title: raw.title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: 'DE',
    city: raw.location ?? null,
    workMode: text.includes('remote') ? 'remote' : text.includes('hybrid') ? 'hybrid' : 'on-site',
    language: detectLanguage(`${raw.title} ${description.slice(0, 400)}`),
    description,
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
    applyUrl,
    offersRelocation: RELOCATION_KEYWORDS.some((k) => text.includes(k)),
    isStartup: text.includes('startup') || text.includes('seed'),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function isRelevant(title: string): boolean {
  const t = title.toLowerCase();
  if (EXCLUDED_KEYWORDS.some((k) => t.includes(k))) return false;
  return RELEVANT_KEYWORDS.some((k) => t.includes(k));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
