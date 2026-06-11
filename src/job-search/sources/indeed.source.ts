import { JobPosting, SearchSettings } from '../types';
import { proxyFetch } from '../proxy-fetch';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'indeed.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

// European countries to search — each gets its own countryCode so the location filter
// can decide: FR = preferred (on-site/hybrid/remote OK), other EU = relocation required
// for on-site/hybrid, remote always OK.
const EU_SEARCHES: Array<{ q: string; l: string; label: string; countryCode: string | null }> = [
  { q: 'nodejs backend developer',    l: 'France',      label: 'FR', countryCode: 'FR' },
  { q: 'nestjs developer',            l: 'France',      label: 'FR-nestjs', countryCode: 'FR' },
  { q: 'nodejs backend developer',    l: 'Germany',     label: 'DE', countryCode: 'DE' },
  { q: 'nodejs backend developer',    l: 'Netherlands', label: 'NL', countryCode: 'NL' },
  { q: 'nodejs backend developer',    l: 'Poland',      label: 'PL', countryCode: 'PL' },
  { q: 'nodejs backend developer',    l: 'Sweden',      label: 'SE', countryCode: 'SE' },
  { q: 'nodejs backend developer',    l: 'Spain',       label: 'ES', countryCode: 'ES' },
  // Broad EU remote — null countryCode means location filter will accept remote only
  { q: 'nodejs backend remote',       l: 'Europe',      label: 'EU-remote', countryCode: null },
];

export class IndeedJobsSource implements JobSource {
  name = SOURCE;
  priority = 8;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;
    const fromage = String(Math.ceil(settings.maxAgeHours / 24) + 1);

    // Preflight to indeed.com to obtain session cookies — increases chance of
    // passing Indeed's rate limiter vs. a completely cookieless request.
    const sessionCookie = await fetchSessionCookie();

    let successCount = 0;
    let rateLimitedCount = 0;

    for (const search of EU_SEARCHES) {
      try {
        const params = new URLSearchParams({ q: search.q, l: search.l, sort: 'date', fromage });
        const url = `https://www.indeed.com/rss?${params}`;
        const headers: Record<string, string> = {
          'User-Agent': BROWSER_UA,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://www.indeed.com/',
        };
        if (sessionCookie) headers['Cookie'] = sessionCookie;

        let response = await proxyFetch(url, { headers, signal: AbortSignal.timeout(15_000) });

        if (response.status === 429) {
          rateLimitedCount++;
          console.warn(`[indeed] ${search.label} 429 — waiting 30s before retry`);
          await sleep(30_000);
          response = await proxyFetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        }

        if (!response.ok) {
          console.warn(`[indeed] ${search.label}: HTTP ${response.status}`);
          continue;
        }

        const xml = await response.text();
        if (!xml.includes('<item>')) {
          if (xml.trim().startsWith('<html')) {
            console.warn(`[indeed] ${search.label}: got HTML bot-challenge page`);
          }
          continue;
        }

        const items = extractRssItems(xml, cutoff);
        if (items.length > 0) {
          successCount++;
          console.log(`[indeed] ${search.label}: ${items.length} items`);
        }
        for (const item of items) {
          const posting = mapRssItem(item, search.countryCode, search.label);
          if (posting) jobs.set(posting.canonicalUrl, posting);
        }
        await sleep(4000);
      } catch (err) {
        console.error(`[indeed] ${search.label}:`, err instanceof Error ? err.message : String(err));
      }
    }

    if (rateLimitedCount > 0 && successCount === 0) {
      console.warn(`[indeed] all ${rateLimitedCount} searches rate-limited (429) — IP may be flagged, will retry next run`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchSessionCookie(): Promise<string> {
  try {
    const res = await proxyFetch('https://www.indeed.com/', {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      },
      signal: AbortSignal.timeout(12_000),
    });
    const raw = res.headers.get('x-set-cookie') ?? '';
    if (!raw) return '';
    const pairs = raw
      .split(',')
      .map((c) => c.split(';')[0].trim())
      .filter((p) => {
        if (!p.includes('=')) return false;
        const name = p.split('=')[0].trim();
        return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name);
      });
    const cookieStr = pairs.join('; ');
    const names = pairs.map((p) => p.split('=')[0]).join(', ');
    if (names) console.log(`[indeed] session cookies: [${names}]`);
    return cookieStr;
  } catch {
    return '';
  }
}

function extractRssItems(xml: string, cutoff: number): RssItem[] {
  const items: RssItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractLinkAfterTag(block);
    const description = extractTag(block, 'description');
    const pubDate = extractTag(block, 'pubDate');
    if (!title || !link) continue;
    const publishedMs = pubDate ? new Date(pubDate).getTime() : Date.now();
    if (isNaN(publishedMs) || publishedMs < cutoff) continue;
    items.push({ title, link, description: description || '', pubDate: pubDate || '' });
  }
  return items;
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m?.[1]?.trim() || '';
}

function extractLinkAfterTag(xml: string): string {
  const m = xml.match(/<link>\s*(https?:\/\/[^\s<]+)/i);
  return m?.[1]?.trim() || '';
}

// Infer work mode from the full job text
function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['full remote', 'fully remote', 'remote only', 'remote-first', '100% remote', 'télétravail complet', 'fully distributed', 'remote position', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'flexible working', 'partial remote', 'work from home', 'remote/on-site', 'télétravail partiel'])) return 'hybrid';
  // If "remote" appears anywhere in a EU-wide search, lean toward remote
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function mapRssItem(item: RssItem, defaultCountryCode: string | null, label: string): JobPosting | null {
  // Indeed title format: "Job Title - Company Name"
  const dashIdx = item.title.lastIndexOf(' - ');
  const title = dashIdx > 0 ? item.title.slice(0, dashIdx).trim() : item.title.trim();
  const company = dashIdx > 0 ? item.title.slice(dashIdx + 3).trim() : 'Unknown';

  if (!title || title.length < 4 || !item.link.startsWith('http')) return null;

  const description = stripHtml(item.description);
  const text = `${title} ${description}`.toLowerCase();
  const publishedAt = item.pubDate ? new Date(item.pubDate) : new Date();
  const workMode = inferWorkMode(text);

  // For the broad EU-remote search (countryCode=null), if the job isn't actually remote,
  // skip it — on-site with unknown country code would be rejected by the location filter anyway.
  if (defaultCountryCode === null && workMode === 'on-site') return null;

  const locationLabel = defaultCountryCode === 'FR' ? 'France'
    : defaultCountryCode === 'DE' ? 'Germany'
    : defaultCountryCode === 'NL' ? 'Netherlands'
    : defaultCountryCode === 'PL' ? 'Poland'
    : defaultCountryCode === 'SE' ? 'Sweden'
    : defaultCountryCode === 'ES' ? 'Spain'
    : 'Europe';

  return {
    source: SOURCE,
    sourcePriority: 8,
    canonicalUrl: item.link,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: defaultCountryCode,
    city: null,
    workMode,
    language: detectLanguage(`${title} ${description.slice(0, 500)}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: item.link,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsor', 'visa support', 'work permit', 'sponsorship', 'relocate']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
