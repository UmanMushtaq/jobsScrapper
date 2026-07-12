/**
 * Shared utilities for HTML-based job scrapers.
 * Keeps per-source files thin — only URL construction and source metadata live there.
 */
import { JobPosting } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';

// Full family of Node/NestJS spellings, lowercase. Sources may need casing or format
// tweaks per their own API (most search APIs are case-insensitive, but verify per source).
// Not every source should use the full list — ScraperAPI-credit sources cap at 3 queries,
// Playwright sources cap at current+1, and sources with confirmed dead variants (e.g.
// jobware.de returning 0 for "nestjs") should keep their narrower, verified list.
export const NODE_QUERY_VARIANTS = [
  'nodejs', 'node.js', 'node js', 'node', 'nestjs', 'nest.js', 'nest js',
  'typescript backend', 'typescript',
];

export interface RawJob {
  id?: string | number;
  url?: string;
  link?: string;
  jobUrl?: string;
  title?: string;
  name?: string;
  positionName?: string;
  company?: string | { name?: string; displayName?: string };
  employer?: string | { name?: string };
  location?: string | { name?: string; city?: string; addressLocality?: string };
  city?: string;
  description?: string;
  summary?: string;
  datePosted?: string;
  publishedAt?: string;
  date?: string;
}

const EXCLUDE_PRIMARY = ['angular', 'vue.js', 'vue ', 'react ', 'react.js', 'python', ' java ', 'java,', 'php', '.net ', 'c# ', 'golang', ' go ', 'rust ', 'ruby'];
const INCLUDE_TECH = ['node', 'nest', 'typescript', 'backend', 'back-end', 'back end', 'api ', 'microservice', 'express'];

// Single canonical keyword list for detecting relocation/visa-sponsorship support in job
// text. Every source that computes offersRelocation from a text scan should import this
// instead of maintaining its own local list.
export const RELOCATION_KEYWORDS = [
  'relocation', 'relocation assistance', 'relocation package', 'relocation support',
  'visa sponsorship', 'visa sponsor', 'visa support', 'visa assistance',
  'work permit', 'sponsorship',
];

// Fintech-domain signal words — payments, wallets, KYC/AML, trading. Used as a scoring
// boost only (matcher.ts), never a filter: a job missing all of these is still fully
// eligible, it just doesn't get the positioning-alignment bump.
export const FINTECH_KEYWORDS = [
  'fintech', 'payment', 'payments', 'banking', 'wallet', 'kyc', 'aml', 'trading',
  'brokerage', 'insurtech', 'neobank', 'psp', 'acquiring', 'open banking', 'psd2',
  'financial services',
];

// Safe URL join — handles absolute hrefs, root-relative hrefs, and bare relative
// hrefs/slugs alike. Naive `baseUrl + relativePath` string concatenation breaks
// whenever the relative value lacks a leading slash (e.g. a bare "id-slug" from a
// JSON API), producing URLs like "https://example.com123-slug". Pass a base with a
// trailing slash when the relative value may be a bare slug that belongs under a
// sub-path (e.g. "https://site.com/jobs/"), otherwise a bare origin is fine.
export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

export function isRelevantJob(title: string, description: string): boolean {
  const t = title.toLowerCase();
  const d = (description ?? '').toLowerCase();
  const combined = `${t} ${d}`;
  if (!INCLUDE_TECH.some((k) => combined.includes(k))) return false;
  // Exclude if primary stack is unrelated — only if title strongly signals it
  if (EXCLUDE_PRIMARY.some((k) => t.includes(k))) return false;
  return true;
}

export function extractJobsFromHtml(html: string, baseUrl: string): RawJob[] {
  // 1. JSON-LD
  const jsonLdJobs: RawJob[] = [];
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') {
          jsonLdJobs.push({
            title: item.title,
            url: item.url ?? item.mainEntityOfPage?.['@id'],
            company: item.hiringOrganization?.name ?? item.hiringOrganization,
            location: item.jobLocation?.address?.addressLocality ?? item.jobLocation?.name ?? item.jobLocation?.address?.addressRegion,
            description: item.description,
            datePosted: item.datePosted,
          });
        }
      }
    } catch { /* continue */ }
  }
  if (jsonLdJobs.length > 0) return jsonLdJobs;

  // 2. application/json script blocks
  const scriptMatches = html.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scriptMatches) {
    try {
      const data = JSON.parse(match[1]);
      const list =
        data?.jobs ?? data?.offers ?? data?.jobList?.jobs ?? data?.results ?? data?.items ??
        data?.data?.jobs ?? data?.data?.offers ??
        (Array.isArray(data) ? data : null);
      if (Array.isArray(list) && list.length > 0) return list as RawJob[];
    } catch { /* continue */ }
  }

  // 3. __NEXT_DATA__ / React hydration blob (Next.js and similar frameworks)
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const nd = JSON.parse(nextMatch[1]);
      const pp = nd?.props?.pageProps ?? {};
      const list: unknown[] =
        pp.jobs ?? pp.offers ?? pp.vacancies ?? pp.results ?? pp.jobList?.jobs ??
        pp.data?.jobs ?? pp.data?.offers ?? pp.data?.vacancies ??
        pp.initialJobs ?? pp.jobOffers ?? pp.searchResults ?? [];
      if (Array.isArray(list) && list.length > 0) return list as RawJob[];
    } catch { /* fall through */ }
  }

  // 4. window.__INITIAL_STATE__ / window.__STORE__ hydration
  const stateMatch = html.match(/window\.__(?:INITIAL_STATE|STORE|STATE)__\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|window\.)/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const list: unknown[] =
        state?.jobs?.list ?? state?.jobs?.items ?? state?.jobList?.jobs ??
        state?.offers?.list ?? state?.vacatures?.items ?? state?.results?.items ?? state?.listings ?? [];
      if (Array.isArray(list) && list.length > 0) return list as RawJob[];
    } catch { /* fall through */ }
  }

  // 5. HTML card parsing with broad selectors
  return parseCards(html, baseUrl);
}

function parseCards(html: string, baseUrl: string): RawJob[] {
  const jobs: RawJob[] = [];

  const cardPattern = /<(?:article|li|div)[^>]*class="[^"]*(?:job|offer|vacancy|position|annonce|emploi|stelle|listing|result|card|vacature|offre)[^"]*"[^>]*>([\s\S]*?)(?=<(?:article|li|div)[^>]*class="[^"]*(?:job|offer|vacancy|position|annonce|emploi|stelle|listing|result|card|vacature|offre)|<\/(?:ul|main|section|div class="jobs))/gi;
  let m: RegExpExecArray | null;

  while ((m = cardPattern.exec(html)) !== null) {
    const block = m[1];
    const titleMatch =
      block.match(/class="[^"]*(?:job[_-]?title|title[_-]?job|position[_-]?title|offer[_-]?title|annonce[_-]?title|job__title|job-title)[^"]*"[^>]*>([^<]{3,120})/i) ??
      block.match(/<h[1-4][^>]*>([^<]{5,120})<\/h[1-4]>/i);
    const companyMatch =
      block.match(/class="[^"]*(?:company|employer|entreprise|organization|firma|bedrijf)[^"]*"[^>]*>([^<]+)/i);
    const locationMatch =
      block.match(/class="[^"]*(?:location|city|lieu|stad|ort|localisation)[^"]*"[^>]*>([^<]+)/i);
    const linkMatch =
      block.match(/href="(https?:\/\/[^"]{10,})"/i) ??
      block.match(/href="(\/[^"]{3,})"/i);

    const title = titleMatch?.[1]?.trim();
    const rawUrl = linkMatch?.[1];
    if (!title || !rawUrl) continue;

    const url = resolveUrl(baseUrl, rawUrl);
    jobs.push({
      title,
      url,
      company: companyMatch?.[1]?.trim(),
      location: locationMatch?.[1]?.trim(),
    });
  }

  return jobs;
}

export function mapRawJob(
  raw: RawJob,
  source: string,
  sourcePriority: number,
  countryCode: string,
  countryLabel: string,
  baseUrl: string,
): JobPosting | null {
  const title = raw.title ?? raw.name ?? raw.positionName;
  if (!title) return null;

  const url = raw.url ?? raw.link ?? raw.jobUrl;
  if (!url) return null;
  const canonicalUrl = resolveUrl(baseUrl, url);

  const companyRaw = raw.company;
  const company = typeof companyRaw === 'string'
    ? companyRaw
    : (companyRaw as { displayName?: string; name?: string })?.displayName
      ?? (companyRaw as { name?: string })?.name
      ?? (typeof raw.employer === 'string' ? raw.employer : (raw.employer as { name?: string })?.name)
      ?? 'Unknown';

  const locRaw = raw.location ?? raw.city;
  const locationStr = typeof locRaw === 'string'
    ? locRaw
    : (locRaw as { name?: string; city?: string; addressLocality?: string })?.addressLocality
      ?? (locRaw as { name?: string })?.name
      ?? (locRaw as { city?: string })?.city
      ?? '';
  const locationLabel = locationStr ? `${locationStr}, ${countryLabel}` : countryLabel;

  const description = raw.description ?? raw.summary ?? '';
  const descClean = stripHtml(description);
  const text = `${title} ${descClean}`.toLowerCase();

  if (!isRelevantJob(title, descClean)) return null;

  const dateStr = raw.datePosted ?? raw.publishedAt ?? raw.date;
  const publishedAt = dateStr ? new Date(dateStr) : new Date();

  return {
    source,
    sourcePriority,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: inferCountryCode(locationLabel) || countryCode,
    city: locationStr || null,
    workMode: inferWorkMode(text),
    language: detectLanguage(`${title} ${descClean.slice(0, 400)}`),
    description: descClean,
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
    offersRelocation: containsAny(text, RELOCATION_KEYWORDS),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['fully remote', '100% remote', 'remote only', 'full remote', 'work from anywhere', 'télétravail complet', 'vollständig remote'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'hybrides', 'télétravail', 'partial remote', 'work from home', 'homeoffice', 'thuiswerken'])) return 'hybrid';
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function extractExperienceMinimum(text: string): number | null {
  const plusMatch = text.match(/(\d+)\+\s*(?:years?|ans?|jahre?)/i);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const rangeMatch = text.match(/(\d+)\s*(?:to|-|bis|à)\s*\d+\s+(?:years?|ans?|jahre?)/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);
  const patterns = [
    /(?:minimum|mindestens|mind\.?|at\s+least|min\.?|au\s+moins)\s+(\d+)\s+(?:years?|ans?|jahre?)/i,
    /(\d+)\s+(?:years?|ans?|jahre?)\s+(?:of\s+)?(?:professional\s+)?(?:experience|erfahrung|expérience)/i,
  ];
  for (const p of patterns) {
    const mm = text.match(p);
    if (mm) return parseInt(mm[1], 10);
  }
  return null;
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
