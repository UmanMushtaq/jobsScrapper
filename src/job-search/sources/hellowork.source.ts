import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { getNextKey, buildScraperUrl } from '../../common/utils/scraper-api.util';
import { RawJob, extractJobsFromHtml, mapRawJob, sleep } from './shared-scraper';

const SOURCE = 'hellowork.com';
const BASE_URL = 'https://www.hellowork.com';
const SEARCH_QUERIES = ['nodejs', 'node.js', 'NestJS', 'nestjs', 'typescript'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

export class HelloWorkSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchPage(query, cutoff);
        for (const job of fetched) jobs.set(job.canonicalUrl, job);
        await sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[hellowork] error for "${query}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) console.log(`[hellowork] 0 jobs — may be blocked`);
    else console.log(`[hellowork] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number): Promise<JobPosting[]> {
  const targetUrl = `${BASE_URL}/fr-fr/emploi/recherche.html?k=${encodeURIComponent(query)}&l=France`;
  const apiKey = await getNextKey();
  const url = apiKey ? buildScraperUrl(targetUrl, apiKey) : targetUrl;

  let res;
  try {
    res = await axios.get<string>(url, { headers: HEADERS, timeout: 60_000, responseType: 'text', validateStatus: (s) => s < 500 });
  } catch { return []; }

  if (res.status === 403 || res.status === 429) {
    console.log(`[hellowork] blocked ${res.status} for "${query}"`);
    return [];
  }

  const rawJobs: RawJob[] = extractJobsFromHtml(res.data, BASE_URL);
  return rawJobs
    .filter((j) => { const d = j.datePosted ?? j.publishedAt; return !d || new Date(d).getTime() >= cutoff; })
    .map((j) => mapRawJob(j, SOURCE, 4, 'FR', 'France', BASE_URL))
    .filter((j): j is JobPosting => j !== null);
}
