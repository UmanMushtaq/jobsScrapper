import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

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
  fr: 'EUR', de: 'EUR', nl: 'EUR', be: 'EUR',
  ch: 'CHF', at: 'EUR', it: 'EUR', es: 'EUR',
  pl: 'EUR', se: 'SEK', no: 'NOK', gb: 'GBP',
};

const COUNTRY_CODE_MAP: Record<string, string> = {
  fr: 'FR', de: 'DE', nl: 'NL', be: 'BE',
  ch: 'CH', at: 'AT', it: 'IT', es: 'ES',
  pl: 'PL', se: 'SE', no: 'NO', gb: 'GB',
};

export class AdzunaJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    if (!appId || !appKey) {
      console.log('[adzuna] skipped: ADZUNA_APP_ID or ADZUNA_APP_KEY not set');
      return [];
    }

    const countries = (process.env.ADZUNA_COUNTRIES ?? 'fr')
      .split(',')
      .map((c) => c.trim().toLowerCase());
    const maxPages = Number(process.env.ADZUNA_MAX_PAGES ?? 2);
    const jobs = new Map<string, JobPosting>();

    for (const country of countries) {
      for (const query of queries) {
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

function mapResult(result: AdzunaResult, country: string): JobPosting {
  const countryCode = COUNTRY_CODE_MAP[country] ?? country.toUpperCase();
  const currency = COUNTRY_CURRENCY[country] ?? 'EUR';
  const area = result.location?.area ?? [];
  const city = area.length > 1 ? area[area.length - 1] : null;
  const companyName = result.company?.display_name ?? 'Unknown';
  const text = `${result.title} ${result.description}`.toLowerCase();
  const salaryMin = result.salary_min ?? null;

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
    language: inferLanguage(text),
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
    offersRelocation: containsAny(text, ['relocation', 'visa sponsorship', 'visa sponsor', 'relocation assistance']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function extractExperienceMinimum(text: string): number | null {
  const lower = text.toLowerCase();

  // "5+ years" means strictly more than 5 — add 1 so it exceeds the max and gets filtered
  const plusMatch = lower.match(/(\d+)\+\s*years?/i);
  if (plusMatch) {
    return parseInt(plusMatch[1], 10) + 1;
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
  if (containsAny(text, ['full remote', 'fully remote', '100% remote', 'remote only', 'work from anywhere', 'remote position'])) {
    return 'remote';
  }
  if (containsAny(text, ['hybrid', 'hybride', 'partial remote', 'flexible remote', 'télétravail partiel'])) {
    return 'hybrid';
  }
  return 'on-site';
}

function inferLanguage(text: string): string {
  const frenchSignals = [
    'rejoignez', 'nous recherchons', 'vous êtes', 'compétences',
    'expérience requise', 'vos missions', 'votre profil', 'télétravail',
    'rémunération', 'candidature', 'développeur', 'ingénieur',
  ];
  return frenchSignals.filter((token) => text.includes(token)).length >= 1 ? 'fr' : 'en';
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}
