import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { RawJob, extractJobsFromHtml, mapRawJob, sleep } from './shared-scraper';
import { ENGLISH_KEYWORDS } from '../keywords';

const SOURCE = 'moovijob.com';
const BASE_URL = 'https://moovijob.com';
// July 13 2026 keyword consolidation — full English set.
const SEARCH_QUERIES = ENGLISH_KEYWORDS;

// Direct fetch with Windows Chrome UA — ScraperAPI returns 200 but renders a JS shell with 0 jobs
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-LU,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

export class MoovijobSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;
    let loggedPreview = false;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchPage(query, cutoff, !loggedPreview);
        if (fetched.preview && !loggedPreview) {
          console.log(`[moovijob] HTML preview for "${query}": ${fetched.preview}`);
          loggedPreview = true;
        }
        for (const job of fetched.jobs) jobs.set(job.canonicalUrl, job);
        await sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[moovijob] error for "${query}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) console.log(`[moovijob] 0 jobs — may be blocked or structure changed`);
    else console.log(`[moovijob] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number, capturePreview: boolean): Promise<{ jobs: JobPosting[]; preview: string | null }> {
  const url = `${BASE_URL}/emploi?q=${encodeURIComponent(query)}&pays=luxembourg`;

  let res;
  try {
    res = await axios.get<string>(url, { headers: HEADERS, timeout: 20_000, responseType: 'text', validateStatus: (s) => s < 500 });
  } catch { return { jobs: [], preview: null }; }

  if (res.status === 403 || res.status === 429) {
    console.log(`[moovijob] blocked ${res.status} for "${query}"`);
    return { jobs: [], preview: null };
  }

  const html: string = res.data;
  const preview = capturePreview ? html.slice(0, 500).replace(/\s+/g, ' ') : null;

  const rawJobs: RawJob[] = extractJobsFromHtml(html, BASE_URL);
  const jobs = rawJobs
    .filter((j) => { const d = j.datePosted ?? j.publishedAt; return !d || new Date(d).getTime() >= cutoff; })
    .map((j) => mapRawJob(j, SOURCE, 4, 'LU', 'Luxembourg', BASE_URL))
    .filter((j): j is JobPosting => j !== null);

  return { jobs, preview };
}
