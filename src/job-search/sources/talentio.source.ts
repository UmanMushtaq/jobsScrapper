import { JobPosting, SearchSettings } from '../types';
import { proxyFetch } from '../proxy-fetch';
import { inferCountryCode } from './country-codes';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'eu.talent.io';
const API_BASE = 'https://api.eu.talent.io/api/backend/search/positions';

const QUERIES = ['Node.js', 'NestJS', 'TypeScript backend'];

interface TalentioPosition {
  id: string;
  name: string;
  slug?: string;
  company: {
    name: string;
    slug?: string;
  };
  office?: {
    city?: string;
    country?: string;
    countryCode?: string;
  };
  remote?: boolean;
  remotePolicy?: string; // 'full', 'partial', 'no'
  description?: string;
  publicationDate?: string;
  createdAt?: string;
  contractType?: string;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
}

interface TalentioResponse {
  hits?: TalentioPosition[];
  positions?: TalentioPosition[];
  data?: TalentioPosition[];
}

export class TalentioJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

    for (const query of QUERIES) {
      try {
        const results = await fetchTalentio(query, settings);
        for (const job of results) {
          jobs.set(job.canonicalUrl, job);
        }
        await sleep(800);
      } catch (error) {
        console.error(`[talentio] error for "${query}":`, error instanceof Error ? error.message : String(error));
      }
    }

    const result = Array.from(jobs.values());
    if (result.length > 0) {
      console.log(`[talentio] ${result.length} jobs across ${QUERIES.length} queries`);
    }
    return result;
  }
}

async function fetchTalentio(query: string, settings: SearchSettings): Promise<JobPosting[]> {
  const params = new URLSearchParams({
    query,
    contractTypes: 'FULL_TIME',
    page: '0',
    perPage: '50',
  });

  const response = await proxyFetch(`${API_BASE}?${params}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (compatible; jobbot/1.0)',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Talent.io API error: ${response.status}`);
  }

  const raw = (await response.json()) as TalentioResponse;
  const positions: TalentioPosition[] = raw.hits ?? raw.positions ?? raw.data ?? [];

  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  return positions
    .filter((p) => {
      const dateStr = p.publicationDate ?? p.createdAt;
      if (!dateStr) return true;
      return new Date(dateStr).getTime() >= cutoff;
    })
    .map(mapPosition)
    .filter((p): p is JobPosting => p !== null);
}

function mapPosition(pos: TalentioPosition): JobPosting | null {
  if (!pos.id || !pos.name) return null;

  const companyName = pos.company?.name ?? 'Unknown';
  const companySlug = (pos.company?.slug ?? companyName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const slug = pos.slug ?? pos.id;
  const canonicalUrl = `https://eu.talent.io/app/jobs/${slug}`;

  const city = pos.office?.city ?? null;
  const countryCode = pos.office?.countryCode ?? inferCountryCode(pos.office?.country ?? '');

  const remotePolicy = pos.remotePolicy?.toLowerCase() ?? '';
  const workMode: 'remote' | 'hybrid' | 'on-site' =
    pos.remote === true || remotePolicy === 'full' ? 'remote'
    : remotePolicy === 'partial' ? 'hybrid'
    : 'on-site';

  const locationParts = [city, pos.office?.country].filter(Boolean);
  const locationLabel = locationParts.length > 0 ? locationParts.join(', ') : workMode === 'remote' ? 'Remote' : 'Europe';

  const description = pos.description ?? '';
  const text = `${pos.name} ${description}`.toLowerCase();
  const dateStr = pos.publicationDate ?? pos.createdAt ?? new Date().toISOString();
  const publishedAt = new Date(dateStr);

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title: pos.name,
    company: companyName,
    companySummary: '',
    companySlug,
    locationLabel,
    countryCode,
    city,
    workMode,
    language: detectLanguage(`${pos.name} ${description.slice(0, 400)}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: pos.currency ?? null,
    salaryPeriod: pos.salaryMin ? 'yearly' : null,
    salaryMinimum: pos.salaryMin ?? null,
    salaryMaximum: pos.salaryMax ?? null,
    salaryYearlyMinimum: pos.salaryMin ?? null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsor', 'visa support', 'work permit', 'sponsorship']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
