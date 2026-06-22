import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';

const SOURCE = 'nationalevacaturebank.nl';
const BASE_URL = 'https://www.nationalevacaturebank.nl';

const SEARCH_QUERIES = ['nodejs', 'node.js', 'nestjs', 'typescript backend'];

// NVB exposes a public search endpoint that returns JSON when Accept: application/json is sent
const JSON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  'Referer': 'https://www.nationalevacaturebank.nl/',
};

interface NvbJob {
  id?: string | number;
  title?: string;
  jobTitle?: string;
  company?: string | { name?: string };
  companyName?: string;
  location?: string | { city?: string; name?: string };
  city?: string;
  url?: string;
  applyUrl?: string;
  description?: string;
  publishedAt?: string;
  datePosted?: string;
  workingHours?: string;
}

export class NvbNlSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchQuery(query, cutoff);
        for (const job of fetched) jobs.set(job.canonicalUrl, job);
        await sleep(1500);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[nvb] error for "${query}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) console.log(`[nvb] 0 jobs — may be blocked or no results`);
    else console.log(`[nvb] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchQuery(query: string, cutoff: number): Promise<JobPosting[]> {
  // Try JSON API endpoint first
  const jsonUrl = `${BASE_URL}/vacature/zoeken?query=${encodeURIComponent(query)}&limit=20`;
  let res;
  try {
    res = await axios.get(jsonUrl, {
      headers: JSON_HEADERS,
      timeout: 20_000,
      validateStatus: (s) => s < 500,
    });
  } catch { return []; }

  if (res.status === 403 || res.status === 429) {
    console.log(`[nvb] blocked ${res.status} for "${query}"`);
    return [];
  }

  const body = res.data;

  // If we got JSON back, extract jobs from it
  if (typeof body === 'object' && body !== null) {
    const list: NvbJob[] = Array.isArray(body)
      ? body
      : (body?.vacatures ?? body?.jobs ?? body?.results ?? body?.data ?? body?.items ?? []);
    if (Array.isArray(list) && list.length > 0) {
      return list
        .filter((j) => {
          const pub = j.publishedAt ?? j.datePosted;
          return !pub || new Date(pub).getTime() >= cutoff;
        })
        .map(mapJob)
        .filter((j): j is JobPosting => j !== null);
    }
  }

  // Fallback: parse HTML response for JSON-LD or __NEXT_DATA__
  if (typeof body === 'string') {
    const preview = body.slice(0, 500).replace(/\s+/g, ' ');
    if (!body.includes('vacature') && !body.includes('job')) {
      console.log(`[nvb] unexpected response for "${query}" — preview: ${preview}`);
      return [];
    }
    return parseHtml(body, query, cutoff);
  }

  return [];
}

function parseHtml(html: string, query: string, cutoff: number): JobPosting[] {
  const jobs: JobPosting[] = [];

  // Try JSON-LD
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') {
          const pub = item.datePosted;
          if (pub && new Date(pub).getTime() < cutoff) continue;
          const url = item.url ?? item.mainEntityOfPage?.['@id'];
          if (!url || !item.title) continue;
          jobs.push(makeJob({ title: item.title, url, company: item.hiringOrganization?.name ?? 'Unknown', city: item.jobLocation?.address?.addressLocality ?? '', publishedAt: pub }));
        }
      }
    } catch { /* continue */ }
  }
  if (jobs.length > 0) return jobs;

  // Try __NEXT_DATA__
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const nd = JSON.parse(nextMatch[1]);
      const list: NvbJob[] =
        nd?.props?.pageProps?.vacatures ??
        nd?.props?.pageProps?.jobs ??
        nd?.props?.pageProps?.initialJobs ??
        nd?.props?.pageProps?.data?.vacatures ??
        [];
      if (Array.isArray(list) && list.length > 0) {
        return list
          .filter((j) => { const p = j.publishedAt ?? j.datePosted; return !p || new Date(p).getTime() >= cutoff; })
          .map(mapJob)
          .filter((j): j is JobPosting => j !== null);
      }
    } catch { /* fall through */ }
  }

  console.log(`[nvb] 0 jobs parsed from HTML for "${query}"`);
  return jobs;
}

function mapJob(raw: NvbJob): JobPosting | null {
  const title = raw.title ?? raw.jobTitle;
  if (!title) return null;
  const rawUrl = raw.url ?? raw.applyUrl;
  if (!rawUrl) return null;
  const canonicalUrl = rawUrl.startsWith('http') ? rawUrl : `${BASE_URL}${rawUrl}`;
  const companyRaw = raw.company;
  const company = typeof companyRaw === 'string' ? companyRaw : companyRaw?.name ?? raw.companyName ?? 'Unknown';
  const locRaw = raw.location;
  const locationStr = typeof locRaw === 'string' ? locRaw : locRaw?.city ?? locRaw?.name ?? raw.city ?? '';
  const locationLabel = locationStr ? `${locationStr}, Netherlands` : 'Netherlands';
  const description = raw.description ?? '';
  const text = `${title} ${description}`.toLowerCase();
  const pub = raw.publishedAt ?? raw.datePosted;
  const publishedAt = pub ? new Date(pub) : new Date();

  return {
    source: SOURCE, sourcePriority: 4, canonicalUrl,
    title, company, companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel, countryCode: inferCountryCode(locationLabel) || 'NL',
    city: locationStr || null,
    workMode: text.includes('remote') ? 'remote' : text.includes('hybrid') ? 'hybrid' : 'on-site',
    language: detectLanguage(`${title} ${description.slice(0, 400)}`),
    description, keyMissions: [], experienceLevelMinimum: null,
    salaryCurrency: null, salaryPeriod: null, salaryMinimum: null,
    salaryMaximum: null, salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [], applyUrl: canonicalUrl,
    offersRelocation: text.includes('relocation') || text.includes('visa'),
    isStartup: text.includes('startup') || text.includes('seed'),
    employeeCount: null, companyCreationYear: null,
  };
}

function makeJob(p: { title: string; url: string; company: string; city: string; publishedAt?: string }): JobPosting {
  return mapJob({ title: p.title, url: p.url, company: p.company, city: p.city, publishedAt: p.publishedAt }) as JobPosting;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
