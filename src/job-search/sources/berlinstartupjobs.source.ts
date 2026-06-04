import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'berlinstartupjobs.com';

export class BerlinStartupJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    try {
      const results = await fetchFeed(settings);
      if (results.length === 0) {
        console.log('[berlinstartupjobs] 0 relevant jobs found');
      } else {
        console.log(`[berlinstartupjobs] ${results.length} relevant jobs`);
      }
      return results;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes('fetch failed') && !msg.includes('403')) {
        console.error(`[berlinstartupjobs] error: ${msg}`);
      }
      return [];
    }
  }
}

async function fetchFeed(settings: SearchSettings): Promise<JobPosting[]> {
  const response = await fetch('https://berlinstartupjobs.com/feed/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml',
    },
  });

  if (response.status === 403 || response.status === 429 || response.status === 530) {
    console.log(`[berlinstartupjobs] blocked by ${response.status}`);
    return [];
  }
  if (!response.ok) throw new Error(`berlinstartupjobs feed ${response.status}`);

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

    if (!title || !link) continue;

    const pubDate = pubDateStr ? new Date(pubDateStr).getTime() : Date.now();
    if (isNaN(pubDate)) continue;

    items.push({ title, link, description, pubDate });
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

  // BSJ titles are usually "Job Title at Company" or "Job Title – Company"
  let jobTitle = item.title;
  let companyName = 'Unknown';

  const atIdx = item.title.lastIndexOf(' at ');
  const dashIdx = item.title.lastIndexOf(' – ');
  const hyphenIdx = item.title.lastIndexOf(' - ');

  if (atIdx > 0) {
    jobTitle = item.title.slice(0, atIdx).trim();
    companyName = item.title.slice(atIdx + 4).trim();
  } else if (dashIdx > 0) {
    jobTitle = item.title.slice(0, dashIdx).trim();
    companyName = item.title.slice(dashIdx + 3).trim();
  } else if (hyphenIdx > 0 && hyphenIdx > item.title.length / 2) {
    jobTitle = item.title.slice(0, hyphenIdx).trim();
    companyName = item.title.slice(hyphenIdx + 3).trim();
  }

  const description = stripHtml(item.description);
  const text = `${jobTitle} ${description}`.toLowerCase();

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl: item.link,
    title: jobTitle,
    company: companyName,
    companySummary: '',
    companySlug: companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: 'Berlin, Germany',
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
