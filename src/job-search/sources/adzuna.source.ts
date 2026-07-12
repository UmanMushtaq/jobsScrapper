import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { RELOCATION_KEYWORDS } from './shared-scraper';
import { CORE_KEYWORDS_MINIMAL } from '../keywords';

const ADZUNA_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';
const SOURCE = 'adzuna.com';

interface AdzunaResult {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  created: string;
  company: { display_name: string };
  location: { display_name: string; area: string[] };
  salary_min?: number;
  salary_max?: number;
}

interface AdzunaResponse {
  results: AdzunaResult[];
}

const COUNTRY_CURRENCY: Record<string, string> = {
  fr: 'EUR', de: 'EUR', nl: 'EUR', be: 'EUR', lu: 'EUR', ie: 'EUR',
  ch: 'CHF', at: 'EUR', it: 'EUR', es: 'EUR',
  pl: 'EUR', se: 'SEK', no: 'NOK', gb: 'GBP',
};

const COUNTRY_CODE_MAP: Record<string, string> = {
  fr: 'FR', de: 'DE', nl: 'NL', be: 'BE', lu: 'LU', ie: 'IE',
  ch: 'CH', at: 'AT', it: 'IT', es: 'ES',
  pl: 'PL', se: 'SE', no: 'NO', gb: 'GB',
};

export class AdzunaJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    if (!appId || !appKey) {
      console.log('[adzuna] skipped: ADZUNA_APP_ID or ADZUNA_APP_KEY not set');
      return [];
    }

    const countries = (process.env.ADZUNA_COUNTRIES ?? 'fr,gb,de,nl,be,lu,ie,at,pl,it,es,se')
      .split(',')
      .map((c) => c.trim().toLowerCase());
    const maxPages = Number(process.env.ADZUNA_MAX_PAGES ?? 2);
    const jobs = new Map<string, JobPosting>();

    // Rate-limited (12 countries x maxPages) — highest-signal minimal set only
    // (July 13 2026 keyword consolidation), not the passed-in profile queries.
    for (const country of countries) {
      for (const query of CORE_KEYWORDS_MINIMAL) {
        for (let page = 1; page <= maxPages; page++) {
          try {
            const results = await fetchPage(appId, appKey, country, query, page, settings);
            for (const job of results) {
              jobs.set(job.canonicalUrl, job);
            }
            if (results.length < 50) break;
          } catch (error) {
            console.error(
              `[adzuna] error ${country}/${query} page ${page}:`,
              error instanceof Error ? error.message : String(error),
            );
            break;
          }
        }
      }
    }

    return Array.from(jobs.values());
  }
}

async function fetchPage(
  appId: string,
  appKey: string,
  country: string,
  query: string,
  page: number,
  settings: SearchSettings,
): Promise<JobPosting[]> {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: '50',
    what: query,
    sort_by: 'date',
    max_days_old: String(Math.ceil(settings.maxAgeHours / 24)),
  });

  const response = await fetch(`${ADZUNA_BASE_URL}/${country}/search/${page}?${params.toString()}`, {
    headers: { 'content-type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Adzuna API error: ${response.status}`);
  }

  const data = (await response.json()) as AdzunaResponse;
  return data.results.map((result) => mapResult(result, country));
}

// Adzuna descriptions are truncated to ~500 chars. Below this length the language
// filter and stack filter can't make a confident call on a shortened snippet — flagged
// via descriptionPartial rather than silently scored as if it were the full JD.
const SHORT_DESCRIPTION_THRESHOLD = 120;

function mapResult(result: AdzunaResult, country: string): JobPosting {
  const countryCode = COUNTRY_CODE_MAP[country] ?? country.toUpperCase();
  const currency = COUNTRY_CURRENCY[country] ?? 'EUR';
  const area = result.location?.area ?? [];
  const city = area.length > 1 ? area[area.length - 1] : null;
  const companyName = result.company?.display_name ?? 'Unknown';
  const text = `${result.title} ${result.description}`.toLowerCase();
  const salaryMin = result.salary_min ?? null;
  const descriptionPartial = (result.description ?? '').length > 0 && (result.description ?? '').length < SHORT_DESCRIPTION_THRESHOLD;

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl: result.redirect_url,
    title: result.title,
    company: companyName,
    companySummary: '',
    companySlug: companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: result.location?.display_name ?? country.toUpperCase(),
    countryCode,
    city,
    workMode: inferWorkMode(text),
    language: detectLanguage(`${result.title} ${result.description ?? ''}`),
    description: result.description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(result.description ?? ''),
    salaryCurrency: salaryMin !== null ? currency : null,
    salaryPeriod: salaryMin !== null ? 'yearly' : null,
    salaryMinimum: salaryMin,
    salaryMaximum: result.salary_max ?? null,
    salaryYearlyMinimum: salaryMin,
    publishedAt: result.created,
    publishedAtTimestamp: Math.floor(new Date(result.created).getTime() / 1000),
    startupSignals: [],
    applyUrl: result.redirect_url,
    offersRelocation: containsAny(text, RELOCATION_KEYWORDS),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
    descriptionPartial,
  };
}

function extractExperienceMinimum(text: string): number | null {
  const lower = text.toLowerCase();

  const plusMatch = lower.match(/(\d+)\+\s*years?/i);
  if (plusMatch) {
    return parseInt(plusMatch[1], 10);
  }

  // "5 to 10 years" or "5-10 years" — use the lower bound
  const rangeMatch = lower.match(/(\d+)\s*(?:to|-)\s*\d+\s+years?/i);
  if (rangeMatch) {
    return parseInt(rangeMatch[1], 10);
  }

  const patterns: RegExp[] = [
    /(?:minimum|at\s+least|min\.?)\s+(\d+)\s+years?/i,
    /(\d+)\s+years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
    /experience\s*(?:of\s+)?(\d+)\s+years?/i,
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, [
    'fully remote', 'full remote', '100% remote', 'remote only', 'work from anywhere',
    'remote position', 'remote role', 'remote job', 'remote-first', 'remote first',
    'work from home', 'working from home', 'home working', 'wfh',
    'distributed team', 'location: remote', 'location:remote',
  ])) {
    return 'remote';
  }
  if (containsAny(text, [
    'hybrid', 'hybride', 'partial remote', 'flexible remote', 'télétravail partiel',
    'remote friendly', 'remote-friendly', 'occasionally remote',
  ])) {
    return 'hybrid';
  }
  return 'on-site';
}


function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}
