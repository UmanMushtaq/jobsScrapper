import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { RawJob, extractJobsFromHtml, mapRawJob, sleep } from './shared-scraper';

const SOURCE = 'vacancy.nl';
const BASE_URL = 'https://www.vacancy.nl';
const SEARCH_QUERIES = ['nodejs', 'node.js', 'NestJS', 'nestjs', 'typescript'];

// Direct fetch with realistic Windows Chrome headers — no ScraperAPI (returns 500)
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

export class VacancyNlSource implements JobSource {
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
          console.error(`[vacancy-nl] error for "${query}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) console.log(`[vacancy-nl] 0 jobs — may be blocked`);
    else console.log(`[vacancy-nl] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number): Promise<JobPosting[]> {
  const url = `${BASE_URL}/vacatures/?query=${encodeURIComponent(query)}`;

  let res;
  try {
    res = await axios.get<string>(url, { headers: HEADERS, timeout: 20_000, responseType: 'text', validateStatus: (s) => s < 500 });
  } catch { return []; }

  if (res.status === 403 || res.status === 429) {
    console.log(`[vacancy-nl] blocked ${res.status} for "${query}"`);
    return [];
  }

  const html: string = res.data;
  const rawJobs: RawJob[] = extractJobsFromHtml(html, BASE_URL);

  if (rawJobs.length === 0) {
    const preview = html.slice(0, 500).replace(/\s+/g, ' ');
    console.log(`[vacancy-nl] 0 jobs parsed for "${query}" (status ${res.status}) — preview: ${preview}`);
  }

  return rawJobs
    .filter((j) => { const d = j.datePosted ?? j.publishedAt; return !d || new Date(d).getTime() >= cutoff; })
    .map((j) => mapRawJob(j, SOURCE, 4, 'NL', 'Netherlands', BASE_URL))
    .filter((j): j is JobPosting => j !== null);
}
