import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';

const SOURCE = 'stepstone.be';
const BASE_URL = 'https://www.stepstone.be/jobs/';

// All case variations to maximise coverage across Stepstone's search index.
const SEARCH_QUERIES = [
  'nodejs',
  'node.js',
  'node js',
  'NodeJS',
  'Node.js',
  'nestjs',
  'nest.js',
  'NestJS',
  'Nest.js',
  'backend typescript',
  'backend node',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

interface RawJob {
  id?: string;
  url?: string;
  jobUrl?: string;
  title?: string;
  name?: string;
  company?: string | { name?: string };
  employer?: string | { name?: string };
  location?: string | { name?: string; city?: string };
  description?: string;
  salary?: string | { min?: number; max?: number; currency?: string };
  datePosted?: string;
  publishedAt?: string;
  validThrough?: string;
}

export class StepstoneBelgiumSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchPage(query, cutoff);
        for (const job of fetched) {
          jobs.set(job.canonicalUrl, job);
        }
        await sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[stepstone-be] error for "${query}": ${msg}`);
        }
      }
    }

    console.log(`[stepstone-be] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number): Promise<JobPosting[]> {
  const url = `${BASE_URL}${encodeURIComponent(query)}`;
  const res = await axios.get<string>(url, {
    headers: HEADERS,
    timeout: 15_000,
    responseType: 'text',
  });

  if (res.status === 403 || res.status === 429) {
    console.log(`[stepstone-be] blocked ${res.status} for "${query}"`);
    return [];
  }

  const html: string = res.data;
  const jobs = extractJobs(html);

  return jobs
    .filter((j) => {
      const dateStr = j.datePosted ?? j.publishedAt;
      if (!dateStr) return true;
      return new Date(dateStr).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

function extractJobs(html: string): RawJob[] {
  // 1. Try window.__INITIAL_STATE__
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.)/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const list =
        state?.jobList?.jobs ??
        state?.jobs?.list ??
        state?.results?.jobs ??
        state?.listings ??
        [];
      if (Array.isArray(list) && list.length > 0) return list as RawJob[];
    } catch { /* fall through */ }
  }

  // 2. Try JSON-LD blocks (structured data — Stepstone uses JobPosting schema)
  const jsonLdJobs: RawJob[] = [];
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') {
          jsonLdJobs.push({
            title: item.title,
            url: item.url,
            company: item.hiringOrganization?.name ?? item.hiringOrganization,
            location: item.jobLocation?.address?.addressLocality ?? item.jobLocation?.name,
            description: item.description,
            datePosted: item.datePosted,
            validThrough: item.validThrough,
          });
        }
      }
    } catch { /* continue */ }
  }
  if (jsonLdJobs.length > 0) return jsonLdJobs;

  // 3. Try any application/json script blocks
  const scriptMatches = html.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scriptMatches) {
    try {
      const data = JSON.parse(match[1]);
      const list =
        data?.jobs ??
        data?.jobList?.jobs ??
        data?.results ??
        (Array.isArray(data) ? data : null);
      if (Array.isArray(list) && list.length > 0) return list as RawJob[];
    } catch { /* continue */ }
  }

  // 4. Parse job cards from HTML using regex patterns
  return parseJobCardsFromHtml(html);
}

function parseJobCardsFromHtml(html: string): RawJob[] {
  const jobs: RawJob[] = [];

  // Stepstone renders job cards with data-jobid attributes and structured class names
  const cardPattern = /data-jobid=["']([^"']+)["'][^>]*>([\s\S]*?)(?=data-jobid=|<\/article|<\/li>|$)/gi;
  let m: RegExpExecArray | null;

  while ((m = cardPattern.exec(html)) !== null) {
    const id = m[1];
    const block = m[2];

    const titleMatch = block.match(/class="[^"]*(?:job-title|listing-title|job__title)[^"]*"[^>]*>([^<]+)/i)
      ?? block.match(/<h[1-4][^>]*>([^<]{5,100})<\/h[1-4]>/i);
    const companyMatch = block.match(/class="[^"]*(?:company-name|employer-name|job__company)[^"]*"[^>]*>([^<]+)/i);
    const locationMatch = block.match(/class="[^"]*(?:job-location|location|job__location)[^"]*"[^>]*>([^<]+)/i);
    const linkMatch = block.match(/href="([^"]*\/jobs?\/[^"]+)"/i) ?? block.match(/href="([^"]+)"/i);

    const title = titleMatch ? titleMatch[1].trim() : null;
    const url = linkMatch ? (linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.stepstone.be${linkMatch[1]}`) : null;

    if (title && url) {
      jobs.push({
        id,
        title,
        url,
        company: companyMatch ? companyMatch[1].trim() : undefined,
        location: locationMatch ? locationMatch[1].trim() : undefined,
      });
    }
  }

  return jobs;
}

function mapJob(raw: RawJob): JobPosting | null {
  const title = raw.title ?? raw.name;
  if (!title) return null;

  const url = raw.url ?? raw.jobUrl;
  if (!url) return null;

  const canonicalUrl = url.startsWith('http') ? url : `https://www.stepstone.be${url}`;

  const companyRaw = raw.company;
  const company = typeof companyRaw === 'string'
    ? companyRaw
    : companyRaw?.name ?? (typeof raw.employer === 'string' ? raw.employer : raw.employer?.name) ?? 'Unknown';

  const locationRaw = raw.location;
  const locationStr = typeof locationRaw === 'string'
    ? locationRaw
    : locationRaw?.name ?? locationRaw?.city ?? '';
  const locationLabel = locationStr ? `${locationStr}, Belgium` : 'Belgium';
  const city = locationStr || null;

  const description = raw.description ? stripHtml(raw.description) : '';
  const text = `${title} ${description}`.toLowerCase();

  const publishedAt = raw.datePosted ?? raw.publishedAt ? new Date(raw.datePosted ?? raw.publishedAt!) : new Date();
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: inferCountryCode(locationLabel) || 'BE',
    city,
    workMode: inferWorkMode(text),
    language: detectLanguage(`${title} ${description.slice(0, 400)}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsor', 'visa support', 'work permit', 'sponsorship']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail', 'partial remote', 'work from home'])) return 'hybrid';
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function extractExperienceMinimum(text: string): number | null {
  const plusMatch = text.match(/(\d+)\+\s*years?/i);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const rangeMatch = text.match(/(\d+)\s*(?:to|-)\s*\d+\s+years?/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);
  const patterns = [
    /(?:minimum|at\s+least|min\.?)\s+(\d+)\s+years?/i,
    /(\d+)\s+years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
