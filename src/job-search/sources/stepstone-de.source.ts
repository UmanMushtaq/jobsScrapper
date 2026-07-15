import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';
import { RELOCATION_KEYWORDS, resolveUrl } from './shared-scraper';
import { getNextKey, buildScraperUrl } from '../../common/utils/scraper-api.util';
import { CORE_KEYWORDS_MINIMAL } from '../keywords';

const SOURCE = 'stepstone.de';
const BASE_URL = 'https://www.stepstone.de/jobs/';

// StepStone returns 0 jobs on a direct fetch — its bot protection blocks plain requests
// (confirmed: direct axios.get with browser-like headers below still yields nothing in
// production). StepStone is the ONLY source authorized to consume ScraperAPI credits in
// this pass; every other source added/fixed alongside it uses plain fetch/cheerio.
// Hard-capped at 10 ScraperAPI requests/run (shared 3-key x 100/day budget across the
// whole app) — sourced from the canonical CORE_KEYWORDS_MINIMAL plus the two German
// phrase variants confirmed to surface results on this German site, so a render=false +
// render=true fallback pair per query still fits under the cap (July 13 2026 keyword
// consolidation — kept the German variants rather than dropping to the plain minimal
// set, since this is a German-only site and they were deliberately added and verified).
const SEARCH_QUERIES = [...CORE_KEYWORDS_MINIMAL, 'Node.js Entwickler', 'NestJS Entwickler'];

const MAX_SCRAPERAPI_REQUESTS_PER_RUN = 10;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};


export interface RawJob {
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

export class StepstoneGermanySource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;
    let requestsUsed = 0;
    let totalFetched = 0;

    for (const query of SEARCH_QUERIES) {
      if (requestsUsed >= MAX_SCRAPERAPI_REQUESTS_PER_RUN) {
        console.log('[stepstone-de] ScraperAPI request cap reached for this run — stopping early');
        break;
      }
      try {
        const { jobs: fetched, requestsMade, rawCount } = await fetchPage(query, cutoff, MAX_SCRAPERAPI_REQUESTS_PER_RUN - requestsUsed);
        requestsUsed += requestsMade;
        totalFetched += rawCount;
        for (const job of fetched) {
          jobs.set(job.canonicalUrl, job);
        }
        await sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[stepstone-de] error for "${query}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) {
      console.log(`[stepstone-de] 0 jobs — disabled cleanly for this run (ScraperAPI budget or blocked)`);
    } else {
      console.log(`[stepstone-de] ${jobs.size} unique jobs fetched (${requestsUsed} ScraperAPI requests)`);
    }
    console.log(`[stepstone-de] fetched=${totalFetched}, passed_filters=${jobs.size}`);
    return Array.from(jobs.values());
  }
}

export function buildSearchUrl(query: string): string {
  return `${BASE_URL}${encodeURIComponent(query)}?radius=30&sort=2`;
}

async function fetchPage(
  query: string,
  cutoff: number,
  requestBudget: number,
): Promise<{ jobs: JobPosting[]; requestsMade: number; rawCount: number }> {
  const targetUrl = buildSearchUrl(query);
  const apiKey = await getNextKey();
  if (!apiKey) {
    console.log('[stepstone-de] ScraperAPI keys exhausted or unconfigured — disabling cleanly for this run');
    return { jobs: [], requestsMade: 0, rawCount: 0 };
  }
  if (requestBudget <= 0) return { jobs: [], requestsMade: 0, rawCount: 0 };

  let requestsMade = 0;

  // render=false first — cheaper ScraperAPI credit cost. Only escalate to render=true
  // (full headless browser, needed if StepStone's listing is JS-hydrated) when the cheap
  // attempt comes back empty and there's still budget left in this run.
  let html = await fetchViaScraperApi(targetUrl, apiKey, false);
  requestsMade++;
  let jobs = html ? extractJobs(html) : [];

  if (jobs.length === 0 && requestBudget > requestsMade) {
    html = await fetchViaScraperApi(targetUrl, apiKey, true);
    requestsMade++;
    jobs = html ? extractJobs(html) : [];
  }

  const mapped = jobs
    .filter((j) => {
      const dateStr = j.datePosted ?? j.publishedAt;
      if (!dateStr) return true;
      return new Date(dateStr).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);

  return { jobs: mapped, requestsMade, rawCount: jobs.length };
}

async function fetchViaScraperApi(targetUrl: string, apiKey: string, render: boolean): Promise<string | null> {
  const url = buildScraperUrl(targetUrl, apiKey, false, { render, residential: false });
  let res;
  try {
    res = await axios.get<string>(url, {
      headers: HEADERS,
      timeout: 60_000,
      responseType: 'text',
      validateStatus: (s) => s < 500,
    });
  } catch {
    return null;
  }

  if (res.status === 403 || res.status === 429) {
    console.log(`[stepstone-de] blocked ${res.status} via ScraperAPI (render=${render})`);
    return null;
  }
  if (res.status >= 400) return null;

  return res.data;
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

  // 2. Try JSON-LD blocks (Stepstone uses JobPosting schema)
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

  // 3. Try application/json script blocks
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

  // 4. Parse job cards from HTML
  return parseJobCardsFromHtml(html);
}

function parseJobCardsFromHtml(html: string): RawJob[] {
  const jobs: RawJob[] = [];

  // Stepstone renders job cards with data-jobid attributes
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
    const url = linkMatch ? resolveUrl('https://www.stepstone.de', linkMatch[1]) : null;

    if (title && url) {
      jobs.push({ id, title, url, company: companyMatch?.[1].trim(), location: locationMatch?.[1].trim() });
    }
  }

  return jobs;
}

export function mapJob(raw: RawJob): JobPosting | null {
  const title = raw.title ?? raw.name;
  if (!title) return null;

  const url = raw.url ?? raw.jobUrl;
  if (!url) return null;

  const canonicalUrl = resolveUrl('https://www.stepstone.de', url);

  const companyRaw = raw.company;
  const company = typeof companyRaw === 'string'
    ? companyRaw
    : companyRaw?.name ?? (typeof raw.employer === 'string' ? raw.employer : raw.employer?.name) ?? 'Unknown';

  const locationRaw = raw.location;
  const locationStr = typeof locationRaw === 'string'
    ? locationRaw
    : locationRaw?.name ?? locationRaw?.city ?? '';
  const locationLabel = locationStr ? `${locationStr}, Germany` : 'Germany';
  const city = locationStr || null;

  const description = raw.description ? stripHtml(raw.description) : '';
  const text = `${title} ${description}`.toLowerCase();

  const publishedAt = raw.datePosted ?? raw.publishedAt
    ? new Date(raw.datePosted ?? raw.publishedAt!)
    : new Date();
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
    countryCode: inferCountryCode(locationLabel) || 'DE',
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
    offersRelocation: containsAny(text, [...RELOCATION_KEYWORDS, 'umzug']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote', 'vollständig remote', 'homeoffice möglich', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybrides arbeiten', 'teilweise remote', 'partial remote', 'work from home', 'homeoffice'])) return 'hybrid';
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function extractExperienceMinimum(text: string): number | null {
  const plusMatch = text.match(/(\d+)\+\s*(?:years?|jahre?)/i);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const rangeMatch = text.match(/(\d+)\s*(?:to|-|bis)\s*\d+\s+(?:years?|jahre?)/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);
  const patterns = [
    /(?:minimum|mindestens|mind\.?|at\s+least|min\.?)\s+(\d+)\s+(?:years?|jahre?)/i,
    /(\d+)\s+(?:years?|jahre?)\s+(?:of\s+)?(?:professional\s+)?(?:experience|erfahrung)/i,
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
