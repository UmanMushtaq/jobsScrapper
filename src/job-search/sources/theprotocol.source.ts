import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';
import { getNextKey, buildScraperUrl } from '../../common/utils/scraper-api.util';
import { RELOCATION_KEYWORDS, resolveUrl } from './shared-scraper';
import { CORE_KEYWORDS_MINIMAL } from '../keywords';

const SOURCE = 'theprotocol.it';
const BASE_URL = 'https://theprotocol.it/filtry/';

// ScraperAPI-credit source — capped at 3 highest-yield queries to limit credit burn
// (July 13 2026 keyword consolidation).
const SEARCH_QUERIES = CORE_KEYWORDS_MINIMAL;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
};

interface RawJob {
  id?: string | number;
  url?: string;
  link?: string;
  slug?: string;
  title?: string;
  name?: string;
  positionName?: string;
  company?: string | { name?: string; displayName?: string };
  employer?: string | { name?: string };
  location?: string | { name?: string; city?: string };
  city?: string;
  cities?: Array<{ name?: string }>;
  description?: string;
  summary?: string;
  datePosted?: string;
  publishedAt?: string;
  publicationDate?: string;
  date?: string;
}

export class TheProtocolSource implements JobSource {
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
          console.error(`[theprotocol] error for "${query}": ${msg}`);
        }
      }
    }

    console.log(`[theprotocol] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number): Promise<JobPosting[]> {
  const targetUrl = `${BASE_URL}${encodeURIComponent(query)};t`;
  const apiKey = await getNextKey();
  const url = apiKey ? buildScraperUrl(targetUrl, apiKey) : targetUrl;
  const res = await axios.get(url, {
    headers: HEADERS,
    timeout: 60_000,
    validateStatus: (s) => s < 500,
  });

  if (res.status === 403 || res.status === 429) {
    console.log(`[theprotocol] blocked ${res.status} for "${query}"`);
    return [];
  }

  const data = res.data;

  // Try to extract job list from JSON response
  const rawJobs = extractJobs(data);

  return rawJobs
    .filter((j) => {
      const dateStr = j.datePosted ?? j.publishedAt ?? j.publicationDate ?? j.date;
      if (!dateStr) return true;
      return new Date(dateStr).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

function extractJobs(data: unknown): RawJob[] {
  // JSON response path
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const list =
      obj['offers'] ??
      obj['jobs'] ??
      obj['items'] ??
      obj['results'] ??
      obj['data'];
    if (Array.isArray(list) && list.length > 0) return list as RawJob[];
  }
  if (Array.isArray(data) && data.length > 0) return data as RawJob[];

  // HTML fallback — try JSON-LD
  if (typeof data === 'string') {
    const jsonLdJobs: RawJob[] = [];
    const ldMatches = (data as string).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of ldMatches) {
      try {
        const parsed = JSON.parse(match[1]);
        const items = Array.isArray(parsed) ? parsed : [parsed];
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

    // HTML card fallback
    const cardPattern = /<(?:article|li|div)[^>]*class="[^"]*(?:offer|job)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|li|div)>/gi;
    const jobs: RawJob[] = [];
    let m: RegExpExecArray | null;
    while ((m = cardPattern.exec(data as string)) !== null) {
      const block = m[1];
      const titleMatch = block.match(/<h[1-4][^>]*>([^<]{5,120})<\/h[1-4]>/i);
      const linkMatch = block.match(/href="(https?:\/\/theprotocol\.it\/[^"]+)"/i)
        ?? block.match(/href="(\/[^"]+)"/i);
      const title = titleMatch ? titleMatch[1].trim() : null;
      const rawUrl = linkMatch ? linkMatch[1] : null;
      const url = rawUrl ? resolveUrl('https://theprotocol.it', rawUrl) : null;
      if (title && url) jobs.push({ title, url });
    }
    return jobs;
  }

  return [];
}

function mapJob(raw: RawJob): JobPosting | null {
  const title = raw.title ?? raw.name ?? raw.positionName;
  if (!title) return null;

  let url = raw.url ?? raw.link;
  if (!url && raw.slug) url = `https://theprotocol.it/oferty/${raw.slug}`;
  if (!url) return null;

  const canonicalUrl = resolveUrl('https://theprotocol.it', url);

  const companyRaw = raw.company;
  const company = typeof companyRaw === 'string'
    ? companyRaw
    : (companyRaw as { displayName?: string; name?: string })?.displayName
      ?? (companyRaw as { name?: string })?.name
      ?? (typeof raw.employer === 'string' ? raw.employer : (raw.employer as { name?: string })?.name)
      ?? 'Unknown';

  // Location: may be cities array or single location
  let locationStr = '';
  if (raw.cities && raw.cities.length > 0) {
    locationStr = raw.cities[0]?.name ?? '';
  } else {
    const locationRaw = raw.location ?? raw.city;
    locationStr = typeof locationRaw === 'string'
      ? locationRaw
      : (locationRaw as { name?: string; city?: string })?.name ?? (locationRaw as { city?: string })?.city ?? '';
  }
  const locationLabel = locationStr ? `${locationStr}, Poland` : 'Poland';
  const city = locationStr || null;

  const description = raw.description ?? raw.summary
    ? stripHtml(raw.description ?? raw.summary ?? '')
    : '';
  const text = `${title} ${description}`.toLowerCase();

  const dateStr = raw.datePosted ?? raw.publishedAt ?? raw.publicationDate ?? raw.date;
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
    offersRelocation: containsAny(text, RELOCATION_KEYWORDS),
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
