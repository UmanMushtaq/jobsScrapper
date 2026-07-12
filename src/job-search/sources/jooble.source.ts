import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';
import { RELOCATION_KEYWORDS } from './shared-scraper';
import { CORE_KEYWORDS_MINIMAL } from '../keywords';

const SOURCE = 'jooble.org';

// Free API key from https://jooble.org/api/about — Uman must register and set
// JOOBLE_API_KEY in Render's environment variables. No-ops cleanly (logs once, returns
// no jobs) when the key is absent, exactly like adzuna.source.ts does for its own keys.
// Paid-per-call API — highest-signal minimal set only (July 13 2026 keyword consolidation).
const QUERIES = CORE_KEYWORDS_MINIMAL;

export interface JoobleResult {
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
  id?: string | number;
}

interface JoobleResponse {
  totalCount?: number;
  jobs?: JoobleResult[];
}

// Below this length a snippet is too short for the language-requirement filter or the
// stack filter to make a confident call — flagged via descriptionPartial rather than
// silently treated as a full, clean description.
const SHORT_DESCRIPTION_THRESHOLD = 120;

export class JoobleJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const apiKey = process.env.JOOBLE_API_KEY;
    if (!apiKey) {
      console.log('[jooble] skipped: JOOBLE_API_KEY not set — register a free key at https://jooble.org/api/about');
      return [];
    }

    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of QUERIES) {
      try {
        const results = await fetchQuery(apiKey, query, cutoff);
        for (const job of results) {
          jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        console.error(`[jooble] error for "${query}":`, error instanceof Error ? error.message : String(error));
      }
      await sleep(1000);
    }

    console.log(`[jooble] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchQuery(apiKey: string, keywords: string, cutoff: number): Promise<JobPosting[]> {
  const response = await fetch(`https://jooble.org/api/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords, location: 'Deutschland' }),
  });

  if (response.status === 403 || response.status === 429) {
    console.log(`[jooble] blocked ${response.status} for "${keywords}"`);
    return [];
  }
  if (!response.ok) throw new Error(`Jooble API ${response.status}`);

  const data = (await response.json()) as JoobleResponse;
  const list = data.jobs ?? [];
  if (!Array.isArray(list)) return [];

  return list
    .filter((job) => {
      if (!job.updated) return true;
      return new Date(job.updated).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

export function mapJob(raw: JoobleResult): JobPosting | null {
  if (!raw.title || !raw.link) return null;

  const title = raw.title;
  const company = raw.company?.trim() || 'Unknown';
  const description = stripHtml(raw.snippet ?? '');
  const descriptionPartial = description.length > 0 && description.length < SHORT_DESCRIPTION_THRESHOLD;
  const text = `${title} ${description}`.toLowerCase();
  const locationLabel = raw.location?.trim() || 'Germany';
  const countryCode = inferCountryCode(locationLabel) || 'DE';

  const publishedAt = raw.updated ? new Date(raw.updated) : new Date();
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);
  if (isNaN(publishedAtTimestamp)) return null;

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl: raw.link,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode,
    city: null,
    workMode: inferWorkMode(text),
    language: detectLanguage(text),
    description,
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: raw.link,
    offersRelocation: RELOCATION_KEYWORDS.some((k) => text.includes(k)),
    isStartup: text.includes('startup') || text.includes('seed'),
    employeeCount: null,
    companyCreationYear: null,
    descriptionPartial,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (text.includes('fully remote') || text.includes('100% remote') || text.includes('remote only') || text.includes('homeoffice möglich')) return 'remote';
  if (text.includes('hybrid') || text.includes('homeoffice')) return 'hybrid';
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
