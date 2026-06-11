import { JobPosting, SearchSettings } from '../types';
import { proxyFetch } from '../proxy-fetch';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'indeed.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

export class IndeedJobsSource implements JobSource {
  name = SOURCE;
  priority = 8;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;
    const fromage = String(Math.ceil(settings.maxAgeHours / 24) + 1);

    // All searches use www.indeed.com/rss — fr.indeed.com does not have an /rss endpoint (404).
    // France searches use "Paris, France" as location.
    const searches: Array<{ q: string; l: string; label: string; countryCode: string | null }> = [
      { q: 'nodejs backend engineer', l: 'Paris, France', label: 'FR', countryCode: 'FR' },
      { q: 'typescript backend developer', l: 'Paris, France', label: 'FR', countryCode: 'FR' },
      { q: 'nestjs developer', l: 'Paris, France', label: 'FR', countryCode: 'FR' },
      { q: 'nodejs backend remote', l: 'Europe', label: 'EU', countryCode: null },
    ];

    // Preflight: visit the indeed.com homepage to get session cookies (CTK, JSESSIONID, LC).
    // Including these makes subsequent RSS requests look like a real browser session.
    const sessionCookie = await fetchSessionCookie();

    for (const search of searches) {
      try {
        const params = new URLSearchParams({ q: search.q, l: search.l, sort: 'date', fromage });
        const url = `https://www.indeed.com/rss?${params}`;
        const headers: Record<string, string> = {
          'User-Agent': BROWSER_UA,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          'Referer': 'https://www.indeed.com/',
        };
        if (sessionCookie) headers['Cookie'] = sessionCookie;

        let response = await proxyFetch(url, { headers, signal: AbortSignal.timeout(12_000) });

        // On rate limit, wait and retry once
        if (response.status === 429) {
          console.warn(`[indeed] ${search.label} 429 — waiting 20s before retry`);
          await sleep(20_000);
          response = await proxyFetch(url, { headers, signal: AbortSignal.timeout(12_000) });
        }

        if (!response.ok) {
          console.warn(`[indeed] ${search.q}/${search.label}: HTTP ${response.status}`);
          continue;
        }

        const xml = await response.text();
        // If indeed returns an HTML page (bot challenge) instead of XML, skip silently
        if (!xml.includes('<item>') && xml.trim().startsWith('<html')) {
          console.warn(`[indeed] ${search.label}: got HTML instead of RSS (bot challenge)`);
          continue;
        }

        const items = extractRssItems(xml, cutoff);
        console.log(`[indeed] ${search.label}: ${items.length} items`);
        for (const item of items) {
          const posting = mapRssItem(item, search.countryCode);
          if (posting) jobs.set(posting.canonicalUrl, posting);
        }
        await sleep(3000);
      } catch (err) {
        console.error(`[indeed] ${search.q}/${search.label}:`, err instanceof Error ? err.message : String(err));
      }
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
      signal: AbortSignal.timeout(10_000),
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
    console.log(`[indeed] session cookies: [${names}]`);
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

// Indeed sometimes puts the link in a bare <link> tag without a closing tag
function extractLinkAfterTag(xml: string): string {
  const m = xml.match(/<link>\s*(https?:\/\/[^\s<]+)/i);
  return m?.[1]?.trim() || '';
}

function mapRssItem(item: RssItem, defaultCountryCode: string | null): JobPosting | null {
  // Indeed title format: "Job Title - Company Name"
  const dashIdx = item.title.lastIndexOf(' - ');
  const title = dashIdx > 0 ? item.title.slice(0, dashIdx).trim() : item.title.trim();
  const company = dashIdx > 0 ? item.title.slice(dashIdx + 3).trim() : 'Unknown';

  if (!title || title.length < 4 || !item.link.startsWith('http')) return null;

  const description = stripHtml(item.description);
  const text = `${title} ${description}`.toLowerCase();
  const publishedAt = item.pubDate ? new Date(item.pubDate) : new Date();

  return {
    source: SOURCE,
    sourcePriority: 8,
    canonicalUrl: item.link,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: defaultCountryCode === 'FR' ? 'France' : 'Europe',
    countryCode: defaultCountryCode,
    city: null,
    workMode: inferWorkMode(text),
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
    offersRelocation: text.includes('relocation') || text.includes('visa sponsor'),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['full remote', 'fully remote', 'remote only', 'remote-first', '100% remote', 'télétravail complet', 'fully distributed'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'flexible working', 'partial remote', 'work from home', 'remote/on-site'])) return 'hybrid';
  return 'on-site';
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
