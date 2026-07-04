import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';
import { getNextKey, buildScraperUrl } from '../../common/utils/scraper-api.util';
import { RELOCATION_KEYWORDS } from './shared-scraper';

const SOURCE = 'nationalevacaturebank.nl';
const BASE_URL = 'https://www.nationalevacaturebank.nl';
const API_URL = 'https://api.nationalevacaturebank.nl/api/jobs/v3/sites/nationalevacaturebank.nl/jobs';

const SEARCH_QUERIES = ['nodejs', 'typescript'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.nationalevacaturebank.nl/',
  'Origin': 'https://www.nationalevacaturebank.nl',
};

const RELEVANT_KEYWORDS = ['backend', 'back-end', 'node', 'typescript', 'javascript', 'nestjs', 'software engineer', 'fullstack', 'full stack', 'full-stack', 'api engineer'];
const EXCLUDED_KEYWORDS = ['frontend', 'front-end', 'react', 'vue', 'angular', 'ios', 'android', 'mobile', 'devops', 'data engineer', 'machine learning', 'ai engineer', 'site reliability', 'sre'];

interface NvbWorkingPlace {
  city?: string;
  name?: string;
}

interface NvbJob {
  id: string | number;
  metadata?: { jdco?: string; [key: string]: unknown };
  company?: { name?: string };
  apply?: { url?: string };
  description?: string;
  workingPlace?: NvbWorkingPlace | null;
  contractType?: string;
  careerLevel?: string;
  publicationDate?: string;
  datePosted?: string;
}

interface NvbResponse {
  _embedded?: { jobs?: NvbJob[] };
}

export class NvbNlSource implements JobSource {
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
        console.error(`[nvb] error for "${query}":`, err instanceof Error ? err.message : String(err));
      }
      await sleep(2000);
    }

    if (jobs.length === 0) console.log('[nvb] 0 jobs — may be blocked or no results');
    else console.log(`[nvb] ${jobs.length} unique jobs fetched`);
    return jobs;
  }
}

async function fetchQuery(query: string, cutoff: number): Promise<JobPosting[]> {
  const apiKey = await getNextKey();
  if (!apiKey) {
    console.log('[nvb] no ScraperAPI key/credits available — skipping');
    return [];
  }
  const targetUrl = `${API_URL}?${new URLSearchParams({ page: '1', limit: '20', sort: 'date', query })}`;
  const proxiedUrl = buildScraperUrl(targetUrl, apiKey, false, { render: false, residential: false });

  const res = await axios.get<NvbResponse>(proxiedUrl, {
    headers: HEADERS,
    timeout: 60_000,
    validateStatus: (s) => s < 500,
  });

  if (res.status === 403 || res.status === 429) {
    console.log(`[nvb] blocked ${res.status} for "${query}" (via ScraperAPI)`);
    return [];
  }

  const list: NvbJob[] = res.data?._embedded?.jobs ?? [];
  if (list.length === 0) {
    console.log(`[nvb] 0 jobs from API for "${query}" (status ${res.status})`);
    return [];
  }

  return list
    .filter((j) => {
      const pub = j.publicationDate ?? j.datePosted;
      return !pub || new Date(pub).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null)
    .filter((j) => isRelevant(j.title));
}

function mapJob(raw: NvbJob): JobPosting | null {
  const title = raw.metadata?.jdco;
  if (!title) return null;

  const applyUrl = raw.apply?.url;
  if (!applyUrl) return null;
  const canonicalUrl = applyUrl.startsWith('http') ? applyUrl : `${BASE_URL}${applyUrl}`;

  const company = raw.company?.name ?? 'Unknown';
  const city = raw.workingPlace?.city ?? raw.workingPlace?.name ?? '';
  const locationLabel = city ? `${city}, Netherlands` : 'Netherlands';

  const description = stripHtml(raw.description ?? '');
  const text = `${title} ${description}`.toLowerCase();

  const pub = raw.publicationDate ?? raw.datePosted;
  const publishedAt = pub ? new Date(pub) : new Date();

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: inferCountryCode(locationLabel) || 'NL',
    city: city || null,
    workMode: text.includes('remote') ? 'remote' : text.includes('hybrid') ? 'hybrid' : 'on-site',
    language: detectLanguage(`${title} ${description.slice(0, 400)}`),
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
    applyUrl: canonicalUrl,
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

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
