import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { getNextKey, buildScraperUrl } from '../../common/utils/scraper-api.util';
import { RawJob, extractJobsFromHtml, stripHtml, isRelevantJob } from './shared-scraper';

const SOURCE = 'nodesk.co';
const BASE_URL = 'https://nodesk.co';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class NodeskSource implements JobSource {
  name = SOURCE;
  priority = 5;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    try {
      const jobs = await fetchPage(cutoff);
      if (jobs.length === 0) console.log(`[nodesk] 0 jobs — may be blocked`);
      else console.log(`[nodesk] ${jobs.length} unique jobs fetched`);
      return jobs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
        console.error(`[nodesk] error: ${msg}`);
      }
      return [];
    }
  }
}

async function fetchPage(_cutoff: number): Promise<JobPosting[]> {
  const targetUrl = `${BASE_URL}/remote-jobs/`;
  const apiKey = await getNextKey();
  const url = apiKey ? buildScraperUrl(targetUrl, apiKey) : targetUrl;

  let res;
  try {
    res = await axios.get<string>(url, { headers: HEADERS, timeout: 60_000, responseType: 'text', validateStatus: (s) => s < 500 });
  } catch { return []; }

  if (res.status === 403 || res.status === 429) {
    console.log(`[nodesk] blocked ${res.status}`);
    return [];
  }

  const rawJobs: RawJob[] = extractJobsFromHtml(res.data, BASE_URL);
  const seen = new Set<string>();
  const jobs: JobPosting[] = [];

  for (const raw of rawJobs) {
    const title = raw.title ?? raw.name;
    const url = raw.url ?? raw.link;
    if (!title || !url) continue;

    const canonicalUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);

    const description = stripHtml(raw.description ?? raw.summary ?? '');
    if (!isRelevantJob(title, description)) continue;

    const company = (typeof raw.company === 'string' ? raw.company : (raw.company as { name?: string })?.name) ?? 'Unknown';
    const text = `${title} ${description}`.toLowerCase();

    jobs.push({
      source: SOURCE,
      sourcePriority: 5,
      canonicalUrl,
      title,
      company,
      companySummary: '',
      companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      locationLabel: 'Remote',
      countryCode: 'REMOTE',
      city: null,
      workMode: 'remote',
      language: detectLanguage(`${title} ${description.slice(0, 400)}`),
      description,
      keyMissions: [],
      experienceLevelMinimum: null,
      salaryCurrency: null,
      salaryPeriod: null,
      salaryMinimum: null,
      salaryMaximum: null,
      salaryYearlyMinimum: null,
      publishedAt: new Date().toISOString(),
      publishedAtTimestamp: Math.floor(Date.now() / 1000),
      startupSignals: [],
      applyUrl: canonicalUrl,
      offersRelocation: false,
      isStartup: text.includes('startup') || text.includes('seed'),
      employeeCount: null,
      companyCreationYear: null,
    });
  }

  return jobs;
}
