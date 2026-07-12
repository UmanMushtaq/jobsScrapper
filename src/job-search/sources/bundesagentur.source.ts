import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { sleep } from './shared-scraper';
import { ENGLISH_KEYWORDS, GERMAN_KEYWORDS } from '../keywords';

const SOURCE = 'arbeitsagentur.de';

// Germany's Federal Employment Agency — free public API, no key required. v6 is tried
// first (per Bundesagentur's own migration guidance); any error — network, schema, or
// non-2xx — falls back to v4, which is the version already confirmed working in
// production, so a v6 outage or shape change can never take this source to zero.
const BASE_URL_V6 = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';
const BASE_URL_V4 = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs';
const DETAIL_URL_V4 = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails';
const API_KEY = 'jobboerse-jobsuche';

// Hard cap on detail-page fetches per run — the search endpoint alone can return
// hundreds of hits across all queries, and fetching a full description for every single
// one would both hammer the API and blow past a reasonable run duration on Render's free
// tier. 150 is generous relative to the actual match volume this source produces.
const MAX_DETAIL_FETCHES = 150;
let detailFetchesThisRun = 0;

export interface BaJob {
  refnr: string;
  titel: string;
  beruf: string;
  arbeitgeber: string;
  arbeitsort: {
    ort?: string;
    plz?: string;
    land?: string;
    region?: string;
    koordinaten?: { lat: number; lon: number };
  };
  eintrittsdatum?: string;
  veroeffentlicht?: string;
  modifikationsTimestamp?: string;
  aktuelleVeroeffentlichungsdatum?: string;
  arbeitszeitmodelle?: string[];
  befristung?: number;
  externeUrl?: string;
}

interface BaResponse {
  stellenangebote?: BaJob[];
  maxErgebnisse?: number;
}

// Free public API, no rate limit — full English + German combined set for maximum
// recall (July 13 2026 keyword consolidation).
const QUERIES = [...ENGLISH_KEYWORDS, ...GERMAN_KEYWORDS];

// Debug-level logging (raw status + body shape) fires once per run, on the first query
// only — enough to diagnose a silent 0-results run from the Render log without spamming
// it on every one of the 6 queries. See the July 12 2026 registry-audit report for why
// this was added: a source can run "successfully" (200 OK, no thrown error) while still
// returning zero jobs because of a wrong parameter name or an unexpected response shape,
// and that failure mode is invisible without seeing the actual raw response at least once.
let debugLoggedThisRun = false;

export class BundesagenturJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    detailFetchesThisRun = 0;
    debugLoggedThisRun = false;
    let totalFetched = 0;

    for (const query of QUERIES) {
      try {
        const results = await fetchJobs(query, settings);
        totalFetched += results.length;
        for (const job of results) {
          jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('fetch failed') && !msg.includes('403')) {
          console.error(`[bundesagentur] error for "${query}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) {
      console.log('[bundesagentur] 0 relevant jobs found');
    } else {
      console.log(`[bundesagentur] ${jobs.size} unique relevant jobs (${detailFetchesThisRun} detail fetches)`);
    }
    console.log(`[bundesagentur] fetched=${totalFetched}, passed_filters=${jobs.size}`);

    return Array.from(jobs.values());
  }
}

async function fetchJobs(query: string, settings: SearchSettings): Promise<JobPosting[]> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'X-API-Key': API_KEY,
  };

  // v6 and v4 use DIFFERENT parameter names for page size — v6 takes `size`/`page`, v4
  // takes `maxErgebnisse`. Reusing one param set for both was the likely root cause of
  // this source's silent 0-results bug: v6 would accept the request (200 OK, since
  // unrecognized params are typically ignored rather than rejected) but return its
  // default/empty result set, and since `response.ok` was true the code never fell back
  // to the confirmed-working v4 call — it just kept whatever (empty) v6 gave it.
  const v6Params = new URLSearchParams({ was: query, angebotsart: '1', size: '100', page: '1' });
  const v4Params = new URLSearchParams({ was: query, angebotsart: '1', maxErgebnisse: '100' });

  let data: BaResponse | null = null;
  let v6Status: number | null = null;
  try {
    const response = await fetch(`${BASE_URL_V6}?${v6Params.toString()}`, { headers });
    v6Status = response.status;
    if (response.ok) {
      const text = await response.text();
      const parsed = JSON.parse(text) as BaResponse;
      if (!debugLoggedThisRun) {
        console.log(`[bundesagentur][debug] v6 status=${response.status} body(first 500)=${text.slice(0, 500)}`);
        console.log(`[bundesagentur][debug] v6 keys=${Object.keys(parsed).join(',')}`);
        debugLoggedThisRun = true;
      }
      // Only treat v6 as authoritative if it actually returned jobs — an empty
      // stellenangebote array on a 200 is indistinguishable from "wrong params" without
      // falling back, so fall back to v4 rather than trusting a suspicious empty result.
      if (Array.isArray(parsed.stellenangebote) && parsed.stellenangebote.length > 0) {
        data = parsed;
      }
    }
  } catch {
    /* fall through to v4 */
  }

  if (!data) {
    const response = await fetch(`${BASE_URL_V4}?${v4Params.toString()}`, { headers });
    if (response.status === 403 || response.status === 429) {
      console.log(`[bundesagentur] blocked by ${response.status} for "${query}" (v6 status was ${v6Status})`);
      return [];
    }
    if (!response.ok) throw new Error(`Bundesagentur API ${response.status}`);
    const text = await response.text();
    data = JSON.parse(text) as BaResponse;
    if (!debugLoggedThisRun) {
      console.log(`[bundesagentur][debug] v4 status=${response.status} body(first 500)=${text.slice(0, 500)}`);
      console.log(`[bundesagentur][debug] v4 keys=${Object.keys(data).join(',')}`);
      debugLoggedThisRun = true;
    }
  }

  const jobList = data.stellenangebote ?? [];

  if (!Array.isArray(jobList)) return [];

  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  const fresh = jobList.filter((job) => {
    const dateStr = job.aktuelleVeroeffentlichungsdatum ?? job.veroeffentlicht ?? job.modifikationsTimestamp;
    if (!dateStr) return true;
    return new Date(dateStr).getTime() >= cutoff;
  });

  const postings: JobPosting[] = [];
  for (const raw of fresh) {
    const posting = mapJob(raw);
    if (!posting) continue;

    if (detailFetchesThisRun < MAX_DETAIL_FETCHES) {
      detailFetchesThisRun++;
      try {
        const detail = await fetchDetailDescription(raw.refnr);
        if (detail) {
          posting.description = detail;
          posting.descriptionPartial = false;
          posting.language = detectLanguage(`${posting.title} ${detail}`);
        }
      } catch {
        /* leave description empty / descriptionPartial true */
      }
      await sleep(300 + Math.floor(Math.random() * 200));
    }

    postings.push(posting);
  }

  return postings;
}

// Detail endpoint takes the refnr base64-encoded (standard, not url-safe, per
// Bundesagentur's documented jobdetails contract). A 404 here just means the posting
// expired between search and detail fetch — logged as a partial description, not an error.
async function fetchDetailDescription(refnr: string): Promise<string | null> {
  const encoded = Buffer.from(refnr, 'utf-8').toString('base64');
  const response = await fetch(`${DETAIL_URL_V4}/${encoded}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'X-API-Key': API_KEY,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Bundesagentur detail API ${response.status}`);

  const data = (await response.json()) as { stellenbeschreibung?: string };
  return data.stellenbeschreibung ?? null;
}

export function mapJob(job: BaJob): JobPosting | null {
  if (!job.refnr || !job.titel) return null;

  const title = job.titel;
  const company = job.arbeitgeber ?? 'Unknown';
  const city = job.arbeitsort?.ort ?? null;
  const locationLabel = city ? `${city}, Germany` : 'Germany';

  // Bundesagentur job detail page
  const canonicalUrl = job.externeUrl ?? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${job.refnr}`;
  const applyUrl = canonicalUrl;

  const dateStr = job.aktuelleVeroeffentlichungsdatum ?? job.veroeffentlicht ?? new Date().toISOString();
  const publishedAt = new Date(dateStr);
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);
  if (isNaN(publishedAtTimestamp)) return null;

  const workMode = inferWorkMode(job);
  const text = title.toLowerCase();

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: 'DE',
    city,
    workMode,
    language: detectLanguage(title),
    description: '',
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
    applyUrl,
    offersRelocation: false,
    isStartup: false,
    employeeCount: null,
    companyCreationYear: null,
    descriptionPartial: true,
  };
}

function inferWorkMode(job: BaJob): 'remote' | 'hybrid' | 'on-site' {
  const arbeitszeitmodelle = (job.arbeitszeitmodelle ?? []).map((m) => m.toLowerCase());
  if (arbeitszeitmodelle.some((m) => m.includes('homeoffice') || m.includes('remote'))) {
    return 'hybrid';
  }
  return 'on-site';
}
