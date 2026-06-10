import { JobPosting, SearchSettings } from '../types';
import { proxyFetch } from '../proxy-fetch';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'indeed.com';

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

    // France searches use fr.indeed.com — www.indeed.com (US) returns 404 for French job markets.
    // Europe-wide remote searches stay on www.indeed.com with a location parameter.
    const searches: Array<{ q: string; baseUrl: string; l: string; label: string; countryCode: string | null }> = [
      { q: 'nodejs backend engineer', baseUrl: 'https://fr.indeed.com/rss', l: 'France', label: 'FR', countryCode: 'FR' },
      { q: 'typescript backend engineer', baseUrl: 'https://fr.indeed.com/rss', l: 'France', label: 'FR', countryCode: 'FR' },
      { q: 'nestjs developer', baseUrl: 'https://fr.indeed.com/rss', l: 'France', label: 'FR', countryCode: 'FR' },
      { q: 'nodejs backend remote', baseUrl: 'https://www.indeed.com/rss', l: 'Europe', label: 'EU', countryCode: null },
    ];

    for (const search of searches) {
      try {
        const params = new URLSearchParams({ q: search.q, l: search.l, sort: 'date', fromage });
        const response = await proxyFetch(`${search.baseUrl}?${params}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
            'Referer': 'https://fr.indeed.com/',
          },
          signal: AbortSignal.timeout(12_000),
        });

        if (!response.ok) {
          console.warn(`[indeed] ${search.q}/${search.label}: HTTP ${response.status}`);
          continue;
        }

        const xml = await response.text();
        const items = extractRssItems(xml, cutoff);
        for (const item of items) {
          const posting = mapRssItem(item, search.countryCode);
          if (posting) jobs.set(posting.canonicalUrl, posting);
        }
        await sleep(1200);
      } catch (err) {
        console.error(`[indeed] ${search.q}/${search.label}:`, err instanceof Error ? err.message : String(err));
      }
    }

    return Array.from(jobs.values());
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
  // Handle CDATA and plain text content
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
