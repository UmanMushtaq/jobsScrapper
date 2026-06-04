import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

interface WttjHit {
  name: string;
  summary: string | null;
  profile: string | null;
  language: string | null;
  remote: 'full' | 'partial' | 'punctual' | null;
  has_remote: boolean;
  slug: string;
  published_at: string;
  published_at_timestamp: number;
  experience_level_minimum: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  salary_minimum: number | null;
  salary_maximum: number | null;
  salary_yearly_minimum: number | null;
  key_missions: string[];
  offices: Array<{
    city?: string;
    country?: string;
    country_code?: string;
  }>;
  organization: {
    name: string;
    slug: string;
    summary?: string;
    description?: string;
    nb_employees?: number | null;
    creation_year?: number | null;
  };
}

interface WttjResponse {
  hits: WttjHit[];
  nbPages: number;
}

const ALGOLIA_APP_ID = 'CSEKHVMS53';
const ALGOLIA_API_KEY = '4bd8f6215d0cc52b26430765769e65a0';
const INDEX_NAME = 'wttj_jobs_production_en_published_at_desc';
const SOURCE = 'welcometothejungle.com';

export class WttjJobsSource implements JobSource {
  name = SOURCE;
  priority = 2;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const effectiveQueries = queries.length > 0 ? queries : settings.queries;
    const maxPages = Number(process.env.WTTJ_MAX_PAGES ?? 2);

    for (const query of effectiveQueries) {
      for (let page = 0; page < maxPages; page += 1) {
        try {
          const response = await runQuery(query, page, settings.language);
          for (const hit of response.hits) {
            const job = mapHit(hit);
            jobs.set(job.canonicalUrl, job);
          }

          if (page + 1 >= response.nbPages) {
            break;
          }
        } catch (error) {
          console.error(
            `[wttj] error for "${query}" page ${page}:`,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
      }
    }

    return Array.from(jobs.values());
  }
}

async function runQuery(
  query: string,
  page: number,
  language: string,
): Promise<WttjResponse> {
  const params = new URLSearchParams({
    query,
    hitsPerPage: '50',
    page: String(page),
    filters: `language:${language}`,
  });

  const response = await fetch(
    `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${INDEX_NAME}/query`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-algolia-application-id': ALGOLIA_APP_ID,
        'x-algolia-api-key': ALGOLIA_API_KEY,
        referer: 'https://www.welcometothejungle.com/',
      },
      body: JSON.stringify({ params: params.toString() }),
    },
  );

  if (!response.ok) {
    throw new Error(`WTTJ query failed: ${response.status}`);
  }

  return (await response.json()) as WttjResponse;
}

const USA_OFFICE_CITIES = [
  'san francisco', 'new york', 'new york city', 'austin', 'seattle',
  'boston', 'chicago', 'los angeles', 'denver', 'miami', 'portland',
  'atlanta', 'dallas', 'san jose', 'silicon valley',
];

function mapHit(hit: WttjHit): JobPosting {
  const primaryOffice = hit.offices[0] ?? {};
  const city = primaryOffice.city ?? null;
  const country = primaryOffice.country ?? 'Unknown';
  let countryCode = primaryOffice.country_code?.toUpperCase() ?? null;
  const workMode =
    hit.remote === 'full' ? 'remote' : hit.has_remote ? 'hybrid' : 'on-site';

  // For non-remote jobs: if any listed office is US-based, treat as US job.
  // Catches companies (e.g. Finch, Crunchyroll) that list a Paris entity on WTTJ
  // but whose job description requires physical presence in a US office.
  if (workMode !== 'remote') {
    const hasUsaOffice = hit.offices.some(
      (o) => o.country_code?.toLowerCase() === 'us',
    );
    if (!hasUsaOffice) {
      // Also scan description text for US city + office/in-person context
      const descText = `${hit.summary ?? ''} ${hit.profile ?? ''}`.toLowerCase();
      const mentionsUsaOffice = USA_OFFICE_CITIES.some((cityName) => {
        const idx = descText.indexOf(cityName);
        if (idx === -1) return false;
        const surrounding = descText.slice(Math.max(0, idx - 120), idx + 120);
        return /office|per week|days?\s+a\s+week|in[- ]person|on[- ]site/.test(surrounding);
      });
      if (mentionsUsaOffice) countryCode = 'US';
    } else {
      countryCode = 'US';
    }
  }

  const canonicalUrl = `https://www.welcometothejungle.com/en/companies/${hit.organization.slug}/jobs/${hit.slug}`;

  return {
    source: SOURCE,
    sourcePriority: 2,
    canonicalUrl,
    title: hit.name,
    company: hit.organization.name,
    companySummary: hit.organization.summary ?? hit.organization.description ?? '',
    companySlug: hit.organization.slug,
    locationLabel: city ? `${city}, ${country}` : country,
    countryCode,
    city,
    workMode,
    language: hit.language,
    description: [hit.summary ?? '', stripMarkup(hit.profile)].join(' ').trim(),
    keyMissions: hit.key_missions ?? [],
    experienceLevelMinimum: hit.experience_level_minimum,
    salaryCurrency: hit.salary_currency,
    salaryPeriod: hit.salary_period,
    salaryMinimum: hit.salary_minimum,
    salaryMaximum: hit.salary_maximum,
    salaryYearlyMinimum: hit.salary_yearly_minimum,
    publishedAt: hit.published_at,
    publishedAtTimestamp: hit.published_at_timestamp,
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: containsAny(
      `${hit.summary ?? ''} ${stripMarkup(hit.profile)} ${hit.organization.summary ?? ''}`.toLowerCase(),
      ['relocation', 'visa sponsorship', 'visa sponsor', 'sponsorship'],
    ),
    isStartup: isLikelyStartup(hit),
    employeeCount: hit.organization.nb_employees ?? null,
    companyCreationYear: hit.organization.creation_year ?? null,
  };
}

function stripMarkup(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function isLikelyStartup(hit: WttjHit): boolean {
  const text = `${hit.organization.summary ?? ''} ${hit.organization.description ?? ''} ${hit.summary ?? ''}`.toLowerCase();
  const employeeCount = hit.organization.nb_employees ?? null;
  const creationYear = hit.organization.creation_year ?? null;

  return (
    containsAny(text, ['startup', 'startup studio', 'seed', 'series a', 'early-stage', 'founding']) ||
    (employeeCount !== null && employeeCount <= 300) ||
    (creationYear !== null && creationYear >= new Date().getUTCFullYear() - 10)
  );
}
