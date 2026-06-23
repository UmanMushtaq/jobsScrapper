import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';

const SOURCE = 'jobbird.nl';
const BASE_URL = 'https://www.jobbird.com/nl/vacature';
const AJAX_URL = 'https://www.jobbird.com/nl/ajax/job';

const SEARCH_QUERIES = [
  'nodejs',
  'node.js',
  'node js',
  'NodeJS',
  'Node.js',
  'nestjs',
  'nest.js',
  'NestJS',
  'backend typescript',
  'backend node',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
};


export class JobbirdNlSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchPage(query, cutoff);
        for (const job of fetched) {
          jobs.set(job.canonicalUrl, job);
        }
        await sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[jobbird] error for "${query}": ${msg}`);
        }
      }
    }

    console.log(`[jobbird] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

interface AjaxJob {
  id?: string | number;
  title?: string;
  url?: string;
  description?: string;
  dateRefreshed?: string;
  publishedAt?: string;
  company?: string | { name?: string };
  location?: string;
  city?: string;
}

async function fetchPage(query: string, cutoff: number): Promise<JobPosting[]> {
  // Step 1: fetch listing page to extract job IDs
  const listUrl = `${BASE_URL}?s=${encodeURIComponent(query)}`;
  let html = '';
  try {
    const res = await axios.get<string>(listUrl, {
      headers: HEADERS,
      timeout: 15_000,
      responseType: 'text',
      validateStatus: (s) => s < 500,
    });
    if (res.status === 403 || res.status === 429) {
      console.log(`[jobbird] blocked ${res.status} for "${query}"`);
      return [];
    }
    html = res.data as string;
  } catch {
    return [];
  }

  // Extract job IDs from href patterns like /nl/vacature/{id}-slug
  const idSet = new Set<string>();
  const idPattern = /\/nl\/vacature\/(\d+)-/g;
  let m: RegExpExecArray | null;
  while ((m = idPattern.exec(html)) !== null) idSet.add(m[1]);

  if (idSet.size === 0) return [];

  // Step 2: fetch each job via AJAX endpoint
  const results: JobPosting[] = [];
  for (const id of idSet) {
    try {
      const ajaxRes = await axios.get<AjaxJob>(`${AJAX_URL}/${id}`, {
        headers: { ...HEADERS, Accept: 'application/json' },
        timeout: 10_000,
        validateStatus: (s) => s < 500,
      });
      if (ajaxRes.status !== 200) continue;
      const raw = ajaxRes.data;
      const dateStr = raw.dateRefreshed ?? raw.publishedAt;
      if (dateStr && new Date(dateStr).getTime() < cutoff) continue;
      const job = mapAjaxJob(raw, id);
      if (job) results.push(job);
    } catch { /* skip individual failures */ }
  }
  return results;
}

function mapAjaxJob(raw: AjaxJob, id: string): JobPosting | null {
  const title = raw.title;
  if (!title) return null;

  const TECH_TITLE_KEYWORDS = [
    'developer', 'engineer', 'backend', 'frontend', 'fullstack', 'full-stack',
    'full stack', 'software', 'node', 'typescript', 'javascript', 'devops',
    'cloud', 'architect', 'data', 'python', 'java', 'php', 'programmer',
    'ontwikkelaar',
    'ingenieur',
  ];

  const titleLower = title.toLowerCase();
  const isTechJob = TECH_TITLE_KEYWORDS.some(kw => titleLower.includes(kw));
  if (!isTechJob) return null;

  const canonicalUrl = raw.url
    ? (raw.url.startsWith('http') ? raw.url : `https://www.jobbird.com${raw.url}`)
    : `https://www.jobbird.com/nl/vacature/${id}`;

  const companyRaw = raw.company;
  const company = typeof companyRaw === 'string' ? companyRaw : companyRaw?.name ?? 'Unknown';
  const locationStr = raw.location ?? raw.city ?? '';
  const locationLabel = locationStr ? `${locationStr}, Netherlands` : 'Netherlands';
  const description = raw.description ? stripHtml(raw.description) : '';
  const text = `${title} ${description}`.toLowerCase();
  const dateStr = raw.dateRefreshed ?? raw.publishedAt;
  const publishedAt = dateStr ? new Date(dateStr) : new Date();

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: inferCountryCode(locationLabel) || 'NL',
    city: locationStr || null,
    workMode: inferWorkMode(text),
    language: detectLanguage(`${title} ${description.slice(0, 400)}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsor', 'visa support', 'work permit', 'sponsorship']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'thuiswerken', 'partial remote', 'work from home'])) return 'hybrid';
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
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
