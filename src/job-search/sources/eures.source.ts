import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { detectLanguage } from './language-detect';
import { RELOCATION_KEYWORDS } from './shared-scraper';

const SOURCE = 'eures.europa.eu';
const API_URL = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const PORTAL_URL = 'https://europa.eu/eures/portal/jv-se/jv-details';

// Gap countries only — FR/DE/PL deliberately excluded, already have strong dedicated
// coverage elsewhere; EURES fills Luxembourg/Italy/Sweden/Belgium/Netherlands instead.
const LOCATION_CODES = ['lu', 'it', 'se', 'be', 'nl'];

// specificSearchCode: 'EVERYWHERE' is broken on this API — it silently ignores the
// keyword and returns every job in the location scope (verified: 21,355 records for one
// query, first hit a Swedish train mechanic). 'TITLE' works correctly (verified: 86
// records for "nodejs"). Do not switch this back to 'EVERYWHERE'.
const SEARCH_QUERIES = ['nodejs', 'node.js', 'node', 'nestjs', 'typescript', 'backend developer'];

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export interface EuresJv {
  id?: string;
  title?: string;
  description?: string;
  creationDate?: number;
  lastModificationDate?: number;
  numberOfPosts?: number;
  locationMap?: Record<string, string[]>;
  employer?: { name?: string };
  availableLanguages?: string[];
}

interface EuresResponse {
  numberRecords?: number;
  jvs?: EuresJv[];
}

export class EuresSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const seen = new Set<string>();
    const jobs: JobPosting[] = [];
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;
    const sessionId = `jobsscrapper-${Date.now()}`;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchQuery(query, cutoff, sessionId);
        for (const job of fetched) {
          if (!seen.has(job.canonicalUrl)) {
            seen.add(job.canonicalUrl);
            jobs.push(job);
          }
        }
      } catch (err) {
        console.warn(`[eures] query "${query}" failed:`, err instanceof Error ? err.message.slice(0, 200) : err);
      }
      await sleep(1500);
    }

    console.log(`[eures] fetched ${jobs.length} unique jobs across ${SEARCH_QUERIES.length} queries`);
    return jobs;
  }
}

async function fetchQuery(query: string, cutoff: number, sessionId: string): Promise<JobPosting[]> {
  // Page 1 only for now — 86 records for the broadest query means one page of 50,
  // sorted MOST_RECENT, comfortably covers what a several-hours scheduler needs. Add
  // page 2 later if job volume in the gap countries grows enough to justify it.
  const body = {
    resultsPerPage: 50,
    page: 1,
    sortSearch: 'MOST_RECENT',
    keywords: [{ keyword: query, specificSearchCode: 'TITLE' }],
    publicationPeriod: null,
    occupationUris: [],
    skillUris: [],
    requiredExperienceCodes: [],
    positionScheduleCodes: [],
    sectorCodes: [],
    educationAndQualificationLevelCodes: [],
    positionOfferingCodes: [],
    locationCodes: LOCATION_CODES,
    euresFlagCodes: [],
    otherBenefitsCodes: [],
    requiredLanguages: [],
    minNumberPost: null,
    sessionId,
    requestLanguage: 'en',
  };

  const response = await axios.post<EuresResponse>(API_URL, body, {
    headers: HEADERS,
    timeout: 20_000,
    validateStatus: (s) => s < 500,
  });

  if (response.status !== 200 || !response.data?.jvs) {
    console.warn(`[eures] unexpected response ${response.status} for "${query}"`);
    return [];
  }

  const out: JobPosting[] = [];
  for (const raw of response.data.jvs) {
    const mapped = mapJob(raw, cutoff);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function mapJob(raw: EuresJv, cutoff: number): JobPosting | null {
  if (!raw.id || !raw.title) return null;

  const publishedRaw = raw.lastModificationDate ?? raw.creationDate;
  const publishedAtTimestamp = publishedRaw ?? Date.now();
  if (publishedAtTimestamp < cutoff) return null;

  const countryCode = Object.keys(raw.locationMap ?? {})[0] ?? null;
  const locationLabel = countryCode ?? 'EU';

  const description = stripHtml((raw.description ?? '')).slice(0, 8000);
  const title = raw.title;
  const text = `${title} ${description}`.toLowerCase();
  const workMode: JobPosting['workMode'] =
    /remote|télétravail|homeoffice|home office/.test(text)
      ? /hybrid|hybride/.test(text) ? 'hybrid' : 'remote'
      : /hybrid|hybride/.test(text) ? 'hybrid' : 'on-site';

  const canonicalUrl = `${PORTAL_URL}/${encodeURIComponent(raw.id)}?lang=en`;
  const publishedAt = new Date(publishedAtTimestamp);
  const company = raw.employer?.name ?? 'Unknown';
  const language = raw.availableLanguages?.[0] ?? detectLanguage(`${title} ${description.slice(0, 400)}`);

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode,
    city: null,
    workMode,
    language,
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
    applyUrl: canonicalUrl,
    offersRelocation: RELOCATION_KEYWORDS.some((k) => text.includes(k)),
    isStartup: false,
    employeeCount: null,
    companyCreationYear: null,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
