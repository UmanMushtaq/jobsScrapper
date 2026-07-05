// EXPERIMENTAL: Finland is a new tertiary target country. This scrapes duunitori.fi search
// results directly (no ScraperAPI, no Playwright — kept at zero memory/credit cost per the
// "decide later whether it earns credits" policy). Live behavior against duunitori.fi is
// UNVERIFIED: this sandbox's egress proxy rejects CONNECT to duunitori.fi and tyomarkkinatori.fi
// with a 403 policy denial (confirmed via the proxy status endpoint), the same restriction that
// blocked glassdoor.com and justjoin.it in earlier sessions — that says nothing about Render's
// network access. If this consistently returns 0 jobs once deployed, check the logged HTML
// preview below; if the site structure doesn't match the generic extractor, either fix the
// selectors or move this to the blocked-cluster comment list and unregister.
import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { RawJob, extractJobsFromHtml, mapRawJob, sleep } from './shared-scraper';

const SOURCE = 'duunitori.fi';
const BASE_URL = 'https://duunitori.fi';
const SEARCH_QUERIES = ['nodejs', 'node.js', 'typescript'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,fi;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

export class DuunitoriSource implements JobSource {
  name = SOURCE;
  priority = 6;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;
    let loggedPreview = false;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchPage(query, cutoff, !loggedPreview);
        if (fetched.preview && !loggedPreview) {
          console.log(`[duunitori] HTML preview for "${query}": ${fetched.preview}`);
          loggedPreview = true;
        }
        for (const job of fetched.jobs) jobs.set(job.canonicalUrl, job);
      } catch (err) {
        // Silent-graceful: never let a Finland-source failure interrupt the rest of the run.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[duunitori] fetch failed for "${query}": ${msg}`);
      }
      await sleep(2000);
    }

    if (jobs.size === 0) console.log('[duunitori] 0 jobs — may be blocked, unreachable, or structure changed');
    else console.log(`[duunitori] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchPage(query: string, cutoff: number, capturePreview: boolean): Promise<{ jobs: JobPosting[]; preview: string | null }> {
  const url = `${BASE_URL}/haku?haku=${encodeURIComponent(query)}`;

  const res = await axios.get<string>(url, {
    headers: HEADERS,
    timeout: 20_000,
    responseType: 'text',
    validateStatus: (s) => s < 500,
  });

  if (res.status === 403 || res.status === 429) {
    console.warn(`[duunitori] blocked ${res.status} for "${query}"`);
    return { jobs: [], preview: null };
  }

  const html: string = res.data;
  const preview = capturePreview ? html.slice(0, 500).replace(/\s+/g, ' ') : null;

  const rawJobs: RawJob[] = extractJobsFromHtml(html, BASE_URL);
  const jobs = rawJobs
    .filter((j) => {
      const d = j.datePosted ?? j.publishedAt;
      return !d || new Date(d).getTime() >= cutoff;
    })
    .map((j) => mapRawJob(j, SOURCE, 6, 'FI', 'Finland', BASE_URL))
    .filter((j): j is JobPosting => j !== null);

  return { jobs, preview };
}
