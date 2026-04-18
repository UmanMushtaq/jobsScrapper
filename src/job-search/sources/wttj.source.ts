import { JobPosting } from '../types';
import { JobSource } from './registry';
import { SearchSettings } from '../types';
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
  };
}

interface WttjResponse {
  hits: WttjHit[];
  page: number;
  nbPages: number;
}

const ALGOLIA_APP_ID = 'CSEKHVMS53';
const ALGOLIA_API_KEY = '4bd8f6215d0cc52b26430765769e65a0';
const INDEX_NAME = 'wttj_jobs_production_en_published_at_desc';
const SOURCE = 'welcometothejungle.com';

const CONFIG = {
  requiredKeywords: ["Node.js", "TypeScript", "Express.js", "PostgreSQL", "Sequelize", "Docker", "microservices", "backend", "fintech", "crypto", "trading platform", "API", "RESTful", "CI/CD"],
  excludedTitleKeywords: ["intern", "internship", "apprentice", "apprenticeship", "student", "senior", "staff", "lead", "principal", "head of", "manager"],
  minExperience: 3,
  maxExperience: 6,
  minimumSalaryMonthlyEur: 3000,
  acceptRemote: true,
  acceptHybrid: true,
  acceptOnSite: true,
  maxAgeHours: 168,
  preferredCountries: ["FR"] as string[],
  europeCountryCodes: ["AL","AD","AT","BE","BA","CH","CZ","DE","DK","EE","ES","FI","FR","GB","GR","HU","IE","IS","IT","LI","LU","ME","MK","MT","NL","NO","PL","PT","RS","SE","SI","SK"] as string[],
  language: "en",
  maxResults: 30,
};

export async function fetchWttjJobs(queries: string[], maxPages = 3): Promise<JobPosting[]> {
  const jobs = new Map<string, JobPosting>();
  const searchTerms = "Node.js backend";   // ← very broad for testing

  console.log(`[WTTJ DEBUG] Starting search with: "${searchTerms}"`);

  let totalRaw = 0;
  let passedFilter = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await runQuery(searchTerms, page);
    totalRaw += response.hits.length;

    for (const hit of response.hits) {
      const job = mapHit(hit);
      if (shouldKeepJob(job)) {
        passedFilter++;
        jobs.set(job.canonicalUrl, job);
      }
    }
    if (page + 1 >= response.nbPages) break;
  }

  console.log(`[WTTJ DEBUG] Raw jobs from Algolia: ${totalRaw} | Passed filters: ${passedFilter} | Final jobs: ${jobs.size}`);

  return Array.from(jobs.values()).slice(0, CONFIG.maxResults);
}

async function runQuery(query: string, page: number): Promise<WttjResponse> {
  const params = new URLSearchParams({
    query,
    hitsPerPage: '50',
    page: String(page),
    filters: `language:${CONFIG.language}`,
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
    }
  );

  if (!response.ok) throw new Error(`WTTJ query failed: ${response.status}`);
  return (await response.json()) as WttjResponse;
}

function mapHit(hit: WttjHit): JobPosting {
  const primaryOffice = hit.offices[0] ?? {};
  const city = primaryOffice.city ?? null;
  const countryCode = primaryOffice.country_code?.toUpperCase() ?? null;
  const workMode = hit.remote === 'full' ? 'remote' : hit.has_remote ? 'hybrid' : 'on-site';

  const canonicalUrl = `https://www.welcometothejungle.com/en/companies/${hit.organization.slug}/jobs/${hit.slug}`;

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl,
    title: hit.name,
    company: hit.organization.name,
    companySummary: hit.organization.summary ?? hit.organization.description ?? '',
    companySlug: hit.organization.slug,
    locationLabel: city ? `${city}, ${primaryOffice.country ?? 'Unknown'}` : primaryOffice.country ?? 'Unknown',
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
    offersRelocation: false,
    isStartup: false,
  };
}

function shouldKeepJob(job: JobPosting): boolean {
  const titleLower = job.title.toLowerCase();
  const descLower = job.description.toLowerCase();

  const matched = CONFIG.requiredKeywords.filter(kw => 
    titleLower.includes(kw.toLowerCase()) || descLower.includes(kw.toLowerCase())
  );
  if (matched.length < 1) return false;

  if (CONFIG.excludedTitleKeywords.some(kw => titleLower.includes(kw))) return false;

  if (job.experienceLevelMinimum !== null) {
    if (job.experienceLevelMinimum < CONFIG.minExperience || job.experienceLevelMinimum > CONFIG.maxExperience) return false;
  }

  if (!CONFIG.acceptRemote && job.workMode === 'remote') return false;
  if (!CONFIG.acceptHybrid && job.workMode === 'hybrid') return false;
  if (!CONFIG.acceptOnSite && job.workMode === 'on-site') return false;

  const countryCode = job.countryCode ?? '';
  if (countryCode && 
      !CONFIG.preferredCountries.includes(countryCode) &&
      !CONFIG.europeCountryCodes.includes(countryCode)) return false;

  return true;
}

function stripMarkup(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}


export class WttjJobsSource implements JobSource {
  name = 'wttj';
  priority = 3;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    return fetchWttjJobs(queries, 3);
  }
}