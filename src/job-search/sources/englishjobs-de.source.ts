import axios from 'axios';
import { load as cheerioLoad } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { RELOCATION_KEYWORDS, resolveUrl, sleep, stripHtml } from './shared-scraper';

const SOURCE = 'englishjobs.de';
const BASE_URL = 'https://englishjobs.de';

// Slug candidates unverified against the live site (this sandbox cannot reach
// englishjobs.de — see the network-blocked note in the Germany-coverage report). Every
// job on this site is already tagged as English-speaking by definition, but the language
// filter still runs on the fetched description below since the site's own tagging isn't
// guaranteed accurate.
const LISTING_PATHS = ['/jobs/developer', '/jobs/backend', '/jobs/node-js', '/jobs/javascript'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const RELEVANT_KEYWORDS = [
  'engineer', 'developer', 'software', 'backend', 'back-end', 'node', 'typescript',
  'javascript', 'fullstack', 'full stack', 'full-stack', 'platform', 'api',
];

const EXCLUDED_KEYWORDS = [
  'frontend', 'front-end', 'react native', 'ios', 'android', 'mobile',
  'devops', 'data engineer', 'machine learning', 'ai engineer', 'site reliability', 'sre',
];

// Detail pages fetched to get the full description — listing-card snippets are too short
// for the language/stack filters to make a confident call. Kept small since this is a
// small niche site, not a high-volume aggregator.
const MAX_DETAIL_FETCHES = 40;

export interface RawListingJob {
  title: string;
  company: string;
  locationLabel: string;
  detailUrl: string;
}

export class EnglishJobsDeSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    let detailFetches = 0;

    for (const path of LISTING_PATHS) {
      try {
        const listings = await scrapeListing(path);
        for (const listing of listings) {
          if (jobs.has(listing.detailUrl)) continue;

          let description = '';
          let descriptionPartial = true;
          if (detailFetches < MAX_DETAIL_FETCHES) {
            detailFetches++;
            try {
              description = await scrapeDetailDescription(listing.detailUrl);
              descriptionPartial = description.length < 120;
            } catch {
              /* keep description empty, flagged partial below */
            }
            await sleep(500);
          }

          const job = mapJob(listing, description, descriptionPartial);
          if (job) jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        console.error(`[englishjobs-de] error for "${path}":`, error instanceof Error ? error.message : String(error));
      }
      await sleep(1000);
    }

    console.log(`[englishjobs-de] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function scrapeListing(path: string): Promise<RawListingJob[]> {
  let res;
  try {
    res = await axios.get<string>(`${BASE_URL}${path}`, {
      headers: HEADERS,
      timeout: 20_000,
      validateStatus: (s) => s < 500,
    });
  } catch {
    return [];
  }

  if (res.status === 403 || res.status === 404 || res.status === 429) {
    console.log(`[englishjobs-de] ${res.status} for "${path}"`);
    return [];
  }

  const $ = cheerioLoad(res.data);
  const listings: RawListingJob[] = [];

  // Selector list defensively broad — exact theme/markup unverified live, so multiple
  // candidates are tried in order and the first that yields results wins.
  const candidates = $(
    'li.job-listing, article.job, .job-list-item, .job-card, ul.jobs li, .jobs-list li',
  ).toArray();

  for (const el of candidates) {
    const listing = extractListing($, el);
    if (listing) listings.push(listing);
  }

  if (listings.length === 0) {
    $('li, article').each((_i, el) => {
      const listing = extractListing($, el);
      if (listing) listings.push(listing);
    });
  }

  return listings;
}

function extractListing($: ReturnType<typeof cheerioLoad>, el: AnyNode): RawListingJob | null {
  const $el = $(el);

  const titleAnchor = $el.find('h1 a, h2 a, h3 a, h4 a, .job-title a, a.job-title').first();
  const fallbackAnchor = $el.find('a').first();
  const anchor = titleAnchor.length ? titleAnchor : fallbackAnchor;

  const rawTitle = anchor.text().trim() || $el.find('h1, h2, h3, h4').first().text().trim();
  const href = anchor.attr('href') || '';
  if (!rawTitle || !href) return null;

  const detailUrl = resolveUrl(`${BASE_URL}/`, href);
  if (!detailUrl.startsWith(BASE_URL)) return null;

  if (!isRelevant(rawTitle)) return null;

  const companyRaw = $el.find('.company, .company-name, .employer').first().text().trim();
  const locationRaw = $el.find('.location, .job-location').first().text().trim();

  return {
    title: rawTitle,
    company: companyRaw || 'Unknown',
    locationLabel: locationRaw || 'Germany',
    detailUrl,
  };
}

async function scrapeDetailDescription(detailUrl: string): Promise<string> {
  const res = await axios.get<string>(detailUrl, {
    headers: HEADERS,
    timeout: 20_000,
    validateStatus: (s) => s < 500,
  });
  if (res.status !== 200) return '';

  const $ = cheerioLoad(res.data);
  const body = $('.job-description, .description, article, main').first().text().trim();
  return stripHtml(body).slice(0, 5000);
}

export function mapJob(listing: RawListingJob, description: string, descriptionPartial: boolean): JobPosting | null {
  const text = `${listing.title} ${description}`.toLowerCase();
  const city = listing.locationLabel.split(',')[0].trim() || null;

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl: listing.detailUrl,
    title: listing.title,
    company: listing.company,
    companySummary: '',
    companySlug: listing.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: listing.locationLabel,
    countryCode: 'DE',
    city,
    workMode: inferWorkMode(text),
    language: detectLanguage(`${listing.title} ${description}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: new Date().toISOString(),
    publishedAtTimestamp: Math.floor(Date.now() / 1000),
    startupSignals: [],
    applyUrl: listing.detailUrl,
    offersRelocation: containsAny(text, RELOCATION_KEYWORDS),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
    employeeCount: null,
    companyCreationYear: null,
    descriptionPartial,
  };
}

export function isRelevant(title: string): boolean {
  const t = title.toLowerCase();
  if (EXCLUDED_KEYWORDS.some((k) => t.includes(k))) return false;
  return RELEVANT_KEYWORDS.some((k) => t.includes(k));
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote'])) return 'remote';
  if (text.includes('remote') && text.includes('hybrid')) return 'hybrid';
  if (text.includes('hybrid')) return 'hybrid';
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function extractExperienceMinimum(text: string): number | null {
  const plusMatch = text.match(/(\d+)\+\s*years?/i);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const rangeMatch = text.match(/(\d+)\s*(?:to|-)\s*\d+\s+years?/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);
  const patterns = [
    /(?:minimum|at\s+least|min\.?)\s+(\d+)\s+years?/i,
    /(\d+)\s+years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
    /experience\s*(?:of\s+)?(\d+)\s+years?/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
