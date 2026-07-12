import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { RawJob, extractJobsFromHtml, mapRawJob, sleep } from './shared-scraper';
import { ENGLISH_KEYWORDS } from '../keywords';

const SOURCE = 'vacancy.nl';
const BASE_URL = 'https://www.vacancy.nl';
// July 13 2026 keyword consolidation — full English set.
const SEARCH_QUERIES = ENGLISH_KEYWORDS;

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

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    console.warn('[vacancy-nl] disabled — URL structure changed, returns 404 on all queries');
    return [];
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
