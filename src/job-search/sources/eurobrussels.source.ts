import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';

const SOURCE = 'eurobrussels.com';
const BASE_URL = 'https://www.eurobrussels.com/jobs/search/';

const SEARCH_QUERIES = [
  'nodejs', 'node.js', 'NodeJS', 'nestjs', 'NestJS',
  'backend typescript', 'backend node',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class EuroBrusselsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchPage(query, cutoff);
        for (const job of fetched) jobs.set(job.canonicalUrl, job);
        await sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[eurobrussels] error for "${query}": ${msg}`);
        }
      }
    }

    console.log(`[eurobrussels] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, _cutoff: number): Promise<JobPosting[]> {
  const res = await axios.get<string>(`${BASE_URL}?q=${encodeURIComponent(query)}&cat=IT`, {
    headers: HEADERS,
    timeout: 15_000,
    responseType: 'text',
    validateStatus: (s) => s < 500,
  });

  if (res.status === 403 || res.status === 429) {
    console.log(`[eurobrussels] blocked ${res.status} for "${query}"`);
    return [];
  }

  return parseJobCards(res.data as string);
}

function parseJobCards(html: string): JobPosting[] {
  const jobs: JobPosting[] = [];

  // JSON-LD first
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') {
          const job = mapLdJob(item);
          if (job) jobs.push(job);
        }
      }
    } catch { /* continue */ }
  }
  if (jobs.length > 0) return jobs;

  // Fallback: HTML cards — eurobrussels lists jobs in <article> or <div class="job-...">
  const cardPattern = /<(?:article|div)[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div)>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardPattern.exec(html)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<h[1-4][^>]*>([^<]{5,120})<\/h[1-4]>/i)
      ?? block.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)/i);
    const linkMatch = block.match(/href="(https?:\/\/[^"]*eurobrussels[^"]+)"/i)
      ?? block.match(/href="(\/jobs\/[^"]+)"/i);
    const companyMatch = block.match(/class="[^"]*(?:company|employer|organisation)[^"]*"[^>]*>([^<]+)/i);
    const locationMatch = block.match(/class="[^"]*(?:location|city|place)[^"]*"[^>]*>([^<]+)/i);

    const title = titleMatch?.[1].trim();
    const rawUrl = linkMatch?.[1];
    if (!title || !rawUrl) continue;

    const canonicalUrl = rawUrl.startsWith('http') ? rawUrl : `https://www.eurobrussels.com${rawUrl}`;
    const company = companyMatch?.[1].trim() ?? 'Unknown';
    const locationStr = locationMatch?.[1].trim() ?? 'Brussels';
    const locationLabel = `${locationStr}, Belgium`;
    const description = '';
    const text = title.toLowerCase();

    jobs.push({
      source: SOURCE, sourcePriority: 4, canonicalUrl,
      title, company, companySummary: '',
      companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      locationLabel, countryCode: inferCountryCode(locationLabel) || 'BE',
      city: locationStr, workMode: inferWorkMode(text),
      language: detectLanguage(title),
      description, keyMissions: [], experienceLevelMinimum: null,
      salaryCurrency: null, salaryPeriod: null, salaryMinimum: null,
      salaryMaximum: null, salaryYearlyMinimum: null,
      publishedAt: new Date().toISOString(),
      publishedAtTimestamp: Math.floor(Date.now() / 1000),
      startupSignals: [], applyUrl: canonicalUrl,
      offersRelocation: false, isStartup: false,
      employeeCount: null, companyCreationYear: null,
    });
  }

  return jobs;
}

function mapLdJob(item: Record<string, unknown>): JobPosting | null {
  const title = item.title as string | undefined;
  const url = item.url as string | undefined;
  if (!title || !url) return null;

  const canonicalUrl = url.startsWith('http') ? url : `https://www.eurobrussels.com${url}`;
  const hiringOrg = item.hiringOrganization as Record<string, unknown> | undefined;
  const company = (hiringOrg?.name as string | undefined) ?? 'Unknown';
  const jobLocation = item.jobLocation as Record<string, unknown> | undefined;
  const address = jobLocation?.address as Record<string, unknown> | undefined;
  const locationStr = (address?.addressLocality as string | undefined) ?? 'Brussels';
  const locationLabel = `${locationStr}, Belgium`;
  const description = stripHtml((item.description as string | undefined) ?? '');
  const text = `${title} ${description}`.toLowerCase();
  const dateStr = item.datePosted as string | undefined;
  const publishedAt = dateStr ? new Date(dateStr) : new Date();

  return {
    source: SOURCE, sourcePriority: 4, canonicalUrl,
    title, company, companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel, countryCode: inferCountryCode(locationLabel) || 'BE',
    city: locationStr, workMode: inferWorkMode(text),
    language: detectLanguage(`${title} ${description.slice(0, 400)}`),
    description, keyMissions: [], experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: null, salaryPeriod: null, salaryMinimum: null,
    salaryMaximum: null, salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [], applyUrl: canonicalUrl,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsor', 'work permit']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a']),
    employeeCount: null, companyCreationYear: null,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail', 'work from home'])) return 'hybrid';
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function extractExperienceMinimum(text: string): number | null {
  const m = text.match(/(\d+)\+?\s*years?/i) ?? text.match(/(\d+)\s+years?\s+(?:of\s+)?experience/i);
  return m ? parseInt(m[1], 10) : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
