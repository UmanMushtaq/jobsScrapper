import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';
import { getNextKey, buildScraperUrl } from '../../common/utils/scraper-api.util';

const SOURCE = 'pracuj.pl';
const BASE_URL = 'https://www.pracuj.pl/praca/';

const SEARCH_QUERIES = [
  'nodejs',
  'node.js',
  'NodeJS',
  'nestjs',
  'NestJS',
  'backend typescript',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
};


interface RawJob {
  id?: string | number;
  url?: string;
  link?: string;
  title?: string;
  name?: string;
  company?: string | { name?: string };
  employer?: string | { name?: string };
  location?: string | { name?: string; city?: string };
  city?: string;
  description?: string;
  summary?: string;
  datePosted?: string;
  publishedAt?: string;
  date?: string;
}

export class PracujPlSource implements JobSource {
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
          console.error(`[pracuj] error for "${query}": ${msg}`);
        }
      }
    }

    console.log(`[pracuj] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number): Promise<JobPosting[]> {
  const targetUrl = `${BASE_URL}${encodeURIComponent(query)};kw`;
  const apiKey = await getNextKey();
  const url = apiKey ? buildScraperUrl(targetUrl, apiKey) : targetUrl;
  const res = await axios.get<string>(url, {
    headers: HEADERS,
    timeout: 60_000,
    responseType: 'text',
  });

  if (res.status === 403 || res.status === 429) {
    console.log(`[pracuj] blocked ${res.status} for "${query}"`);
    return [];
  }

  const html: string = res.data;
  const jobs = extractJobs(html);

  return jobs
    .filter((j) => {
      const dateStr = j.datePosted ?? j.publishedAt ?? j.date;
      if (!dateStr) return true;
      return new Date(dateStr).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

function extractJobs(html: string): RawJob[] {
  // 1. Try window.__INITIAL_STATE__ or similar hydration blob
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.)/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const list =
        state?.jobs?.list ??
        state?.jobList?.jobs ??
        state?.offers?.list ??
        state?.listings ??
        [];
      if (Array.isArray(list) && list.length > 0) return list as RawJob[];
    } catch { /* fall through */ }
  }

  // 2. Try JSON-LD (JobPosting schema.org)
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
          });
        }
      }
    } catch { /* continue */ }
  }
  if (jsonLdJobs.length > 0) return jsonLdJobs;

  // 3. Try application/json script blocks
  const scriptMatches = html.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scriptMatches) {
    try {
      const data = JSON.parse(match[1]);
      const list =
        data?.jobs ??
        data?.offers ??
        data?.jobList?.jobs ??
        data?.items ??
        (Array.isArray(data) ? data : null);
      if (Array.isArray(list) && list.length > 0) return list as RawJob[];
    } catch { /* continue */ }
  }

  // 4. Parse job cards from HTML
  return parseJobCardsFromHtml(html);
}

function parseJobCardsFromHtml(html: string): RawJob[] {
  const jobs: RawJob[] = [];

  // Pracuj.pl renders offers inside article/div blocks with data attributes
  const cardPattern = /data-test="[\w-]*offer[\w-]*"[^>]*>([\s\S]*?)(?=data-test="[\w-]*offer[\w-]*"|<\/section|$)/gi;
  let m: RegExpExecArray | null;

  while ((m = cardPattern.exec(html)) !== null) {
    const block = m[1];

    const titleMatch = block.match(/<h[1-4][^>]*>([^<]{5,120})<\/h[1-4]>/i)
      ?? block.match(/data-test="[\w-]*title[\w-]*"[^>]*>([^<]+)/i);
    const companyMatch = block.match(/data-test="[\w-]*company[\w-]*"[^>]*>([^<]+)/i)
      ?? block.match(/class="[^"]*(?:company|employer)[^"]*"[^>]*>([^<]+)/i);
    const locationMatch = block.match(/data-test="[\w-]*location[\w-]*"[^>]*>([^<]+)/i)
      ?? block.match(/class="[^"]*(?:location|city)[^"]*"[^>]*>([^<]+)/i);
    const linkMatch = block.match(/href="(https?:\/\/www\.pracuj\.pl\/[^"]+)"/i)
      ?? block.match(/href="(\/praca\/[^"]+)"/i);

    const title = titleMatch ? titleMatch[1].trim() : null;
    const rawUrl = linkMatch ? linkMatch[1] : null;
    const url = rawUrl
      ? (rawUrl.startsWith('http') ? rawUrl : `https://www.pracuj.pl${rawUrl}`)
      : null;

    if (title && url) {
      jobs.push({
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

  const url = raw.url ?? raw.link;
  if (!url) return null;

  const canonicalUrl = url.startsWith('http') ? url : `https://www.pracuj.pl${url}`;

  const companyRaw = raw.company;
  const company = typeof companyRaw === 'string'
    ? companyRaw
    : companyRaw?.name ?? (typeof raw.employer === 'string' ? raw.employer : raw.employer?.name) ?? 'Unknown';

  const locationRaw = raw.location ?? raw.city;
  const locationStr = typeof locationRaw === 'string'
    ? locationRaw
    : (locationRaw as { name?: string; city?: string })?.name ?? (locationRaw as { city?: string })?.city ?? '';
  const locationLabel = locationStr ? `${locationStr}, Poland` : 'Poland';
  const city = locationStr || null;

  const description = raw.description ?? raw.summary
    ? stripHtml(raw.description ?? raw.summary ?? '')
    : '';
  const text = `${title} ${description}`.toLowerCase();

  const dateStr = raw.datePosted ?? raw.publishedAt ?? raw.date;
  const publishedAt = dateStr ? new Date(dateStr) : new Date();
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
    countryCode: inferCountryCode(locationLabel) || 'PL',
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
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote', 'praca zdalna', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybryda', 'hybrydowy', 'praca hybrydowa', 'partial remote', 'work from home'])) return 'hybrid';
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
