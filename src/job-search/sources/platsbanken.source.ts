import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { ENGLISH_KEYWORDS } from '../keywords';

const SOURCE = 'arbetsformedlingen.se';

// Sweden's Public Employment Service (Arbetsförmedlingen) — Platsbanken API
// Free public API. The JobSearch endpoint works without a key (verified July 7, 2026);
// ARBETSFORMEDLINGEN_API_KEY from https://apirequest.jobtechdev.se is optional.
// No Playwright, no ScraperAPI needed — pure JSON REST API
const BASE_URL = 'https://jobsearch.api.jobtechdev.se/search';

// July 13 2026 keyword consolidation — full English set.
const QUERIES = ENGLISH_KEYWORDS;

interface PlatsbankenHit {
  id: string;
  headline: string;
  employer: {
    name: string;
    workplace: string;
  };
  workplace_address: {
    municipality?: string;
    region?: string;
    city?: string;
    country?: string;
  };
  publication_date: string;
  last_publication_date?: string;
  description: {
    text?: string;
    text_formatted?: string;
  };
  working_hours_type?: {
    label?: string;
  };
  employment_type?: {
    label?: string;
  };
  salary_type?: {
    label?: string;
  };
  salary_description?: string;
  duration?: {
    label?: string;
  };
  webpage_url?: string;
  application_details?: {
    url?: string;
    email?: string;
  };
  must_have?: {
    skills?: Array<{ label: string }>;
    languages?: Array<{ label: string }>;
  };
  nice_to_have?: {
    skills?: Array<{ label: string }>;
  };
  remote_work_offered?: boolean;
}

interface PlatsbankenResponse {
  total: { value: number };
  hits: PlatsbankenHit[];
}

export class PlatsbankenSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    // Verified 2026-07-07: the owner ran
    //   curl -s "https://jobsearch.api.jobtechdev.se/search?q=nodejs&limit=2"
    // from his own machine (real internet access, unlike the sandbox that first tried
    // this) and got a full valid JSON response with no API key — 93 total hits for
    // "nodejs", shape matching PlatsbankenHit exactly (hits[] with id, headline,
    // webpage_url, employer, etc.). The JobSearch endpoint is confirmed open; the
    // api-key header below is now optional and only sent when the env var is set.
    const apiKey = process.env.ARBETSFORMEDLINGEN_API_KEY ?? null;
    if (!apiKey) {
      console.log('[platsbanken] no API key set — using keyless access (verified working July 7, 2026)');
    }

    const jobs = new Map<string, JobPosting>();

    for (const query of QUERIES) {
      try {
        const results = await fetchJobs(query, apiKey, settings);
        console.log(`[platsbanken] found ${results.length} jobs for "${query}"`);
        for (const job of results) {
          jobs.set(job.canonicalUrl, job);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[platsbanken] error for "${query}": ${msg}`);
      }
    }

    console.log(`[platsbanken] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchJobs(
  query: string,
  apiKey: string | null,
  settings: SearchSettings,
): Promise<JobPosting[]> {
  const params = new URLSearchParams({
    q: query,
    limit: '100',
    offset: '0',
  });

  const response = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: {
      'Accept': 'application/json',
      ...(apiKey ? { 'api-key': apiKey } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  // Fallback in case keyless access is ever restricted later.
  if (response.status === 401 || response.status === 403) {
    console.warn(
      `[platsbanken] request rejected (${response.status}) — keyless access may have been restricted; ` +
      'a key from https://apirequest.jobtechdev.se would be needed',
    );
    return [];
  }
  if (!response.ok) {
    throw new Error(`Platsbanken API ${response.status} for "${query}"`);
  }

  const data = (await response.json()) as PlatsbankenResponse;
  const hits = data.hits ?? [];

  if (!Array.isArray(hits)) return [];

  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  return hits
    .filter((hit) => {
      if (!hit.publication_date) return true;
      return new Date(hit.publication_date).getTime() >= cutoff;
    })
    .map(mapHit)
    .filter((j): j is JobPosting => j !== null);
}

function mapHit(hit: PlatsbankenHit): JobPosting | null {
  if (!hit.id || !hit.headline) return null;

  const title = hit.headline.trim();
  const company = hit.employer?.name ?? hit.employer?.workplace ?? 'Unknown';
  const city =
    hit.workplace_address?.city ??
    hit.workplace_address?.municipality ??
    hit.workplace_address?.region ??
    null;
  const locationLabel = city ? `${city}, Sweden` : 'Sweden';

  const canonicalUrl =
    hit.webpage_url ??
    hit.application_details?.url ??
    `https://arbetsformedlingen.se/platsbanken/annonser/${hit.id}`;

  const applyUrl =
    hit.application_details?.url ??
    hit.application_details?.email
      ? `mailto:${hit.application_details.email}`
      : canonicalUrl;

  const publishedAt = new Date(hit.publication_date);
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);
  if (isNaN(publishedAtTimestamp)) return null;

  const description =
    hit.description?.text ??
    hit.description?.text_formatted ??
    '';

  const skills = [
    ...(hit.must_have?.skills?.map((s) => s.label) ?? []),
    ...(hit.nice_to_have?.skills?.map((s) => s.label) ?? []),
  ].join(', ');

  const fullDescription = skills
    ? `${description}\n\nSkills: ${skills}`.trim()
    : description;

  const workMode = inferWorkMode(hit);

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: 'SE',
    city,
    workMode,
    language: detectLanguage(`${title} ${description.slice(0, 300)}`),
    description: fullDescription,
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: hit.salary_description ? 'SEK' : null,
    salaryPeriod: hit.salary_description ? 'monthly' : null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: applyUrl ?? canonicalUrl,
    offersRelocation: false,
    isStartup: false,
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferWorkMode(hit: PlatsbankenHit): 'remote' | 'hybrid' | 'on-site' {
  if (hit.remote_work_offered === true) return 'hybrid';
  const label = (hit.working_hours_type?.label ?? '').toLowerCase();
  if (label.includes('remote') || label.includes('distans')) return 'remote';
  if (label.includes('hybrid')) return 'hybrid';
  return 'on-site';
}
