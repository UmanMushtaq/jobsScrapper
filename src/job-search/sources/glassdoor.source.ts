// EXPERIMENTAL: Glassdoor is Cloudflare-protected like stepstone; if this consistently 403s
// even through ScraperAPI render, move it to the blocked-cluster comment list and unregister.
//
// Budget note: render-mode ScraperAPI requests cost ~10x normal credits. With 2 queries on
// the 8h slow scheduler that is ~6 render requests/day — acceptable, do not exceed.
import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';
import { getNextKey, buildScraperUrl } from '../../common/utils/scraper-api.util';
import { RELOCATION_KEYWORDS, resolveUrl } from './shared-scraper';
import { CORE_KEYWORDS_MINIMAL } from '../keywords';

const SOURCE = 'glassdoor.com';
const BASE_URL = 'https://www.glassdoor.com/Job/jobs.htm';

// Capped at 2 queries — render-mode ScraperAPI credits are expensive (see budget note
// above), tighter than the standard CORE_KEYWORDS_MINIMAL 3-query set, so only the
// first 2 (highest-yield) entries are used here (July 13 2026 keyword consolidation).
const SEARCH_QUERIES = CORE_KEYWORDS_MINIMAL.slice(0, 2);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

interface RawJob {
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  description?: string;
  datePosted?: string;
}

export class GlassdoorSource implements JobSource {
  name = SOURCE;
  priority = 6;

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
        // Silent-graceful: Glassdoor's Cloudflare protection is expected to block this
        // sometimes (or always). Never throw — log one line and move to the next query.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[glassdoor] fetch failed for "${query}": ${msg}`);
      }
    }

    if (jobs.size === 0) console.log('[glassdoor] 0 jobs — likely Cloudflare-blocked even via ScraperAPI render');
    else console.log(`[glassdoor] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number): Promise<JobPosting[]> {
  const apiKey = await getNextKey();
  if (!apiKey) {
    console.log('[glassdoor] no ScraperAPI key/credits available — skipping');
    return [];
  }

  const targetUrl = `${BASE_URL}?${new URLSearchParams({ 'sc.keyword': query })}`;
  const proxiedUrl = buildScraperUrl(targetUrl, apiKey);

  const res = await axios.get<string>(proxiedUrl, {
    headers: HEADERS,
    timeout: 60_000,
    responseType: 'text',
    validateStatus: (s) => s < 500,
  });

  if (res.status === 403 || res.status === 429) {
    console.warn(`[glassdoor] blocked ${res.status} for "${query}" (via ScraperAPI render — Cloudflare)`);
    return [];
  }

  const rawJobs = extractJobs(res.data);

  return rawJobs
    .filter((j) => {
      if (!j.datePosted) return true;
      return new Date(j.datePosted).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

function extractJobs(html: string): RawJob[] {
  // 1. JSON-LD JobPosting schema — Glassdoor search pages typically embed this.
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
            url: item.url ?? item.mainEntityOfPage?.['@id'],
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

  // 2. Fallback: generic job-card HTML parsing.
  const jobs: RawJob[] = [];
  const cardPattern = /<(?:li|div)[^>]*data-test="jobListing"[^>]*>([\s\S]*?)(?=<(?:li|div)[^>]*data-test="jobListing"|<\/ul>)/gi;
  let m: RegExpExecArray | null;
  while ((m = cardPattern.exec(html)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/data-test="job-title"[^>]*>([^<]{3,120})/i) ?? block.match(/<a[^>]*>([^<]{3,120})<\/a>/i);
    const companyMatch = block.match(/data-test="employer-name"[^>]*>([^<]+)/i);
    const locationMatch = block.match(/data-test="emp-location"[^>]*>([^<]+)/i);
    const linkMatch = block.match(/href="(https?:\/\/(?:www\.)?glassdoor\.com\/[^"]+)"/i) ?? block.match(/href="(\/[^"]+)"/i);

    const title = titleMatch?.[1]?.trim();
    const rawUrl = linkMatch?.[1];
    if (!title || !rawUrl) continue;
    const url = resolveUrl('https://www.glassdoor.com', rawUrl);

    jobs.push({
      title,
      url,
      company: companyMatch?.[1]?.trim(),
      location: locationMatch?.[1]?.trim(),
    });
  }

  if (jobs.length === 0) {
    console.log(`[glassdoor] 0 cards found — preview: ${html.slice(0, 300).replace(/\s+/g, ' ')}`);
  }

  return jobs;
}

function mapJob(raw: RawJob): JobPosting | null {
  if (!raw.title || !raw.url) return null;

  const canonicalUrl = raw.url;
  const company = raw.company ?? 'Unknown';
  const locationLabel = raw.location ?? 'Unknown';
  const description = stripHtml(raw.description ?? '');
  const text = `${raw.title} ${description}`.toLowerCase();

  const publishedAt = raw.datePosted ? new Date(raw.datePosted) : new Date();
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);
  if (isNaN(publishedAtTimestamp)) return null;

  return {
    source: SOURCE,
    sourcePriority: 6,
    canonicalUrl,
    title: raw.title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: inferCountryCode(locationLabel),
    city: raw.location ?? null,
    workMode: inferWorkMode(text),
    language: detectLanguage(`${raw.title} ${description.slice(0, 400)}`),
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
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'partial remote', 'work from home'])) return 'hybrid';
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
