import axios from 'axios';
import { load as cheerioLoad } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { RELOCATION_KEYWORDS } from './shared-scraper';

const SOURCE = 'berlinstartupjobs.com';
const PAGE_URL = 'https://berlinstartupjobs.com/engineering/';

const RELEVANT_KEYWORDS = [
  'engineer', 'developer', 'software', 'backend', 'back-end', 'node', 'typescript',
  'javascript', 'fullstack', 'full stack', 'full-stack', 'platform', 'api',
];

const EXCLUDED_KEYWORDS = [
  'frontend', 'front-end', 'react', 'vue', 'angular', 'ios', 'android', 'mobile',
  'devops', 'data engineer', 'machine learning', 'ai engineer', 'site reliability', 'sre',
];

export class BerlinStartupJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    try {
      const results = await scrapePage();
      console.log(`[berlinstartupjobs] ${results.length} relevant jobs`);
      return results;
    } catch (error) {
      console.error('[berlinstartupjobs] fetch error:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

async function scrapePage(): Promise<JobPosting[]> {
  const response = await axios.get<string>(PAGE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 20000,
  });

  const $ = cheerioLoad(response.data);
  const jobs: JobPosting[] = [];

  // BSJ engineering page: job cards are <li class="bsj-list-item"> or <article> elements.
  // Try multiple selectors to stay resilient across theme changes.
  const candidates = $('li.bsj-list-item, article.type-job_listing, li.job-listings-item, .jobs-list li, ul.jobs li').toArray();

  for (const el of candidates) {
    const job = extractJob($, el);
    if (job) jobs.push(job);
  }

  // Fallback: scan all <li> elements that contain a job-looking link
  if (jobs.length === 0) {
    $('li').each((_i, el) => {
      const job = extractJob($, el);
      if (job) jobs.push(job);
    });
  }

  return jobs;
}

function extractJob($: ReturnType<typeof cheerioLoad>, el: AnyNode): JobPosting | null {
  const $el = $(el);

  // Title + URL: look for a heading link or any prominent anchor
  const titleAnchor = $el.find('h1 a, h2 a, h3 a, h4 a, .job-title a, a.job-listing-loop__title').first();
  const fallbackAnchor = $el.find('a').first();
  const anchor = titleAnchor.length ? titleAnchor : fallbackAnchor;

  const rawTitle = anchor.text().trim() || $el.find('h1, h2, h3, h4').first().text().trim();
  const jobUrl = anchor.attr('href') || '';

  if (!rawTitle || !jobUrl || !jobUrl.startsWith('http')) return null;

  // Company: look for dedicated company element, else parse "Title at Company"
  let jobTitle = rawTitle;
  let companyName = 'Unknown';

  const companyEl = $el.find('.company, .company-name, .job-listing-company, .employer').first().text().trim();
  if (companyEl) {
    companyName = companyEl;
  } else {
    const atIdx = rawTitle.lastIndexOf(' at ');
    const dashIdx = rawTitle.lastIndexOf(' – ');
    const hyphenIdx = rawTitle.lastIndexOf(' - ');
    if (atIdx > 0) {
      jobTitle = rawTitle.slice(0, atIdx).trim();
      companyName = rawTitle.slice(atIdx + 4).trim();
    } else if (dashIdx > 0) {
      jobTitle = rawTitle.slice(0, dashIdx).trim();
      companyName = rawTitle.slice(dashIdx + 3).trim();
    } else if (hyphenIdx > 0 && hyphenIdx > rawTitle.length / 2) {
      jobTitle = rawTitle.slice(0, hyphenIdx).trim();
      companyName = rawTitle.slice(hyphenIdx + 3).trim();
    }
  }

  if (!isRelevant(jobTitle)) return null;

  const locationRaw = $el.find('.location, .job-location, .job-listing-location').first().text().trim();
  const locationLabel = locationRaw || 'Berlin, Germany';

  const description = $el.find('.job-listing-description, .description, p').first().text().trim();
  const text = `${jobTitle} ${description}`.toLowerCase();

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl: jobUrl,
    title: jobTitle,
    company: companyName,
    companySummary: '',
    companySlug: companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: 'DE',
    city: 'Berlin',
    workMode: inferWorkMode(text),
    language: detectLanguage(`${jobTitle} ${description}`),
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
    startupSignals: ['startup'],
    applyUrl: jobUrl,
    offersRelocation: containsAny(text, RELOCATION_KEYWORDS),
    isStartup: true,
    employeeCount: null,
    companyCreationYear: null,
  };
}

function isRelevant(title: string): boolean {
  const t = title.toLowerCase();
  if (EXCLUDED_KEYWORDS.some((k) => t.includes(k))) return false;
  return RELEVANT_KEYWORDS.some((k) => t.includes(k));
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (text.includes('fully remote') || text.includes('100% remote') || text.includes('remote only')) return 'remote';
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
