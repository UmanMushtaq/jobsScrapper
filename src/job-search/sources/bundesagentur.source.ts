import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'arbeitsagentur.de';

// Germany's Federal Employment Agency — free public API, no key required.
const BASE_URL = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs';

interface BaJob {
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

const QUERIES = ['Node.js', 'TypeScript Backend', 'NestJS', 'Backend Engineer'];

export class BundesagenturJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

    for (const query of QUERIES) {
      try {
        const results = await fetchJobs(query, settings);
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
      console.log(`[bundesagentur] ${jobs.size} unique relevant jobs`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchJobs(query: string, settings: SearchSettings): Promise<JobPosting[]> {
  const params = new URLSearchParams({
    was: query,
    angebotsart: '1',
    maxErgebnisse: '100',
  });

  const response = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'X-API-Key': 'jobboerse-jobsuche',
    },
  });

  if (response.status === 403 || response.status === 429) {
    console.log(`[bundesagentur] blocked by ${response.status} for "${query}"`);
    return [];
  }
  if (!response.ok) throw new Error(`Bundesagentur API ${response.status}`);

  const data = (await response.json()) as BaResponse;
  const jobList = data.stellenangebote ?? [];

  if (!Array.isArray(jobList)) return [];

  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  return jobList
    .filter((job) => {
      const dateStr = job.aktuelleVeroeffentlichungsdatum ?? job.veroeffentlicht ?? job.modifikationsTimestamp;
      if (!dateStr) return true;
      return new Date(dateStr).getTime() >= cutoff;
    })
    .map(mapJob)
    .filter((j): j is JobPosting => j !== null);
}

function mapJob(job: BaJob): JobPosting | null {
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
  };
}

function inferWorkMode(job: BaJob): 'remote' | 'hybrid' | 'on-site' {
  const arbeitszeitmodelle = (job.arbeitszeitmodelle ?? []).map((m) => m.toLowerCase());
  if (arbeitszeitmodelle.some((m) => m.includes('homeoffice') || m.includes('remote'))) {
    return 'hybrid';
  }
  return 'on-site';
}
