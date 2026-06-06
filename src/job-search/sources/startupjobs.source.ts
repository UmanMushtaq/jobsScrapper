import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'startup.jobs';

// startup.jobs RSS feeds by category
const FEED_URLS = [
  'https://startup.jobs/backend-jobs.rss',
  'https://startup.jobs/node-jobs.rss',
];

export class StartupJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

    for (const feedUrl of FEED_URLS) {
      try {
        const results = await fetchFeed(feedUrl, settings);
        for (const job of results) {
          jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('fetch failed') && !msg.includes('403') && !msg.includes('530')) {
          console.error(`[startup.jobs] error for ${feedUrl}: ${msg}`);
        }
      }
    }

    if (jobs.size === 0) {
      console.log('[startup.jobs] 0 jobs — feed blocked or no results');
    } else {
      console.log(`[startup.jobs] ${jobs.size} jobs from RSS feeds`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchFeed(feedUrl: string, settings: SearchSettings): Promise<JobPosting[]> {
  const response = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml',
    },
  });

  if (response.status === 403 || response.status === 429 || response.status === 530) {
    console.log(`[startup.jobs] blocked by ${response.status}`);
    return [];
  }
  if (!response.ok) throw new Error(`startup.jobs feed ${response.status}`);

  const xml = await response.text();
  const items = parseRssItems(xml);
  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  return items
    .filter((item) => item.pubDate >= cutoff)
    .filter((item) => isRelevant(item.title))
    .map(mapItem)
    .filter((j): j is JobPosting => j !== null);
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: number;
  location: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = cleanCdata(extractTag(block, 'title'));
    const link = cleanCdata(extractTag(block, 'link') || extractTag(block, 'guid'));
    const description = cleanCdata(extractTag(block, 'description'));
    const pubDateStr = extractTag(block, 'pubDate');
    const location = cleanCdata(extractTag(block, 'location') || extractTag(block, 'category'));

    if (!title || !link) continue;

    const pubDate = pubDateStr ? new Date(pubDateStr).getTime() : Date.now();
    if (isNaN(pubDate)) continue;

    items.push({ title, link, description, pubDate, location });
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(regex);
  return m ? m[1].trim() : '';
}

function cleanCdata(str: string): string {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function isRelevant(title: string): boolean {
  const t = title.toLowerCase();
  const relevant = ['backend', 'back-end', 'node', 'typescript', 'javascript', 'software engineer', 'fullstack', 'full stack', 'full-stack', 'api engineer'];
  const excluded = ['frontend', 'front-end', 'react', 'vue', 'angular', 'ios', 'android', 'mobile', 'devops', 'data engineer', 'machine learning', 'ai engineer', 'site reliability', 'sre'];
  if (excluded.some((k) => t.includes(k))) return false;
  return relevant.some((k) => t.includes(k));
}

function mapItem(item: RssItem): JobPosting | null {
  if (!item.link || !item.title) return null;

  // startup.jobs titles: "Job Title at Company" or "Job Title — Company"
  let jobTitle = item.title;
  let companyName = 'Unknown';

  const atIdx = item.title.lastIndexOf(' at ');
  if (atIdx > 0) {
    jobTitle = item.title.slice(0, atIdx).trim();
    companyName = item.title.slice(atIdx + 4).trim();
  }

  const description = stripHtml(item.description);
  const text = `${jobTitle} ${description} ${item.location}`.toLowerCase();
  const countryCode = inferCountryCode(item.location);

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl: item.link,
    title: jobTitle,
    company: companyName,
    companySummary: '',
    companySlug: companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: item.location || 'Remote',
    countryCode,
    city: null,
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
    publishedAt: new Date(item.pubDate).toISOString(),
    publishedAtTimestamp: Math.floor(item.pubDate / 1000),
    startupSignals: ['startup'],
    applyUrl: item.link,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsorship', 'visa sponsor', 'work permit']),
    isStartup: true,
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferCountryCode(location: string): string | null {
  const l = location.toLowerCase();
  if (l.includes('france') || l.includes('paris')) return 'FR';
  if (l.includes('germany') || l.includes('berlin') || l.includes('munich') || l.includes('hamburg')) return 'DE';
  if (l.includes('belgium') || l.includes('brussels')) return 'BE';
  if (l.includes('luxembourg')) return 'LU';
  if (l.includes('netherlands') || l.includes('amsterdam')) return 'NL';
  if (l.includes('uk') || l.includes('united kingdom') || l.includes('london')) return 'GB';
  if (l.includes('poland') || l.includes('warsaw') || l.includes('warszawa') || l.includes('krakow') || l.includes('kraków') || l.includes('wroclaw') || l.includes('gdansk') || l.includes('poznan')) return 'PL';
  if (l.includes('sweden') || l.includes('stockholm') || l.includes('gothenburg') || l.includes('göteborg') || l.includes('malmo') || l.includes('malmö')) return 'SE';
  if (l.includes('spain') || l.includes('madrid') || l.includes('barcelona')) return 'ES';
  if (l.includes('portugal') || l.includes('lisbon')) return 'PT';
  if (l.includes('ireland') || l.includes('dublin')) return 'IE';
  if (l.includes('denmark') || l.includes('copenhagen')) return 'DK';
  if (l.includes('finland') || l.includes('helsinki')) return 'FI';
  if (l.includes('norway') || l.includes('oslo')) return 'NO';
  if (l.includes('switzerland') || l.includes('zurich') || l.includes('zürich')) return 'CH';
  if (l.includes('czechia') || l.includes('czech') || l.includes('prague')) return 'CZ';
  if (l.includes('europe') || l.includes('eu') || l.includes('worldwide') || l.includes('anywhere') || l.includes('remote') || l === '') return 'FR';
  return null;
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

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
