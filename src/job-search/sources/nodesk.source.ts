import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { proxyFetch } from '../proxy-fetch';
import { JobSource } from './registry';

const SOURCE = 'nodesk.co';

// RSS feeds for remote developer jobs — development includes Node.js, backend, fullstack
const FEED_URLS = [
  'https://nodesk.co/remote-jobs/development.rss',
  'https://nodesk.co/remote-jobs/backend.rss',
];

const RELEVANT_KEYWORDS = ['backend', 'back-end', 'node', 'typescript', 'javascript', 'software engineer', 'fullstack', 'full stack', 'full-stack', 'api engineer', 'nestjs', 'express'];
const EXCLUDED_KEYWORDS = ['frontend', 'front-end', 'ios', 'android', 'mobile developer', 'data scientist', 'machine learning', 'devops engineer', 'site reliability'];

export class NodeskJobsSource implements JobSource {
  name = SOURCE;
  priority = 5;

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
        if (!msg.includes('fetch failed') && !msg.includes('403') && !msg.includes('404') && !msg.includes('530')) {
          console.error(`[nodesk] error for ${feedUrl}: ${msg}`);
        }
      }
    }

    if (jobs.size === 0) {
      console.log('[nodesk] 0 jobs — feed blocked or no relevant results');
    } else {
      console.log(`[nodesk] ${jobs.size} jobs from RSS feeds`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchFeed(feedUrl: string, settings: SearchSettings): Promise<JobPosting[]> {
  const response = await proxyFetch(feedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
  });

  if (response.status === 403 || response.status === 404 || response.status === 429 || response.status === 530) {
    console.log(`[nodesk] ${response.status} for ${feedUrl} — skipping`);
    return [];
  }
  if (!response.ok) throw new Error(`Nodesk feed ${response.status}`);

  const xml = await response.text();
  const items = parseRssItems(xml);
  const lookbackHours = Math.max(settings.maxAgeHours, 168);
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  return items
    .filter((item) => item.pubDate >= cutoff)
    .filter((item) => isRelevant(item.title, item.description))
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
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractTag(block, 'guid');
    const description = extractTag(block, 'description') || extractTag(block, 'content:encoded');
    const pubDateStr = extractTag(block, 'pubDate');

    if (!title || !link) continue;

    const pubDate = pubDateStr ? new Date(pubDateStr).getTime() : Date.now();
    if (isNaN(pubDate)) continue;

    items.push({
      title: cleanCdata(title),
      link: cleanCdata(link),
      description: cleanCdata(description),
      pubDate,
    });
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

function isRelevant(title: string, description: string): boolean {
  const t = `${title} ${description}`.toLowerCase();
  if (EXCLUDED_KEYWORDS.some((k) => t.includes(k))) return false;
  return RELEVANT_KEYWORDS.some((k) => t.includes(k));
}

function mapItem(item: RssItem): JobPosting | null {
  const rawTitle = item.title;
  let jobTitle = rawTitle;
  let companyName = 'Unknown';

  // Common RSS formats: "Job Title at Company" or "Company | Job Title" or "Company: Job Title"
  const atIdx = rawTitle.toLowerCase().lastIndexOf(' at ');
  const pipeIdx = rawTitle.indexOf('|');
  const colonIdx = rawTitle.indexOf(':');

  if (atIdx > 0 && atIdx > rawTitle.length / 2) {
    jobTitle = rawTitle.slice(0, atIdx).trim();
    companyName = rawTitle.slice(atIdx + 4).trim();
  } else if (pipeIdx > 0) {
    companyName = rawTitle.slice(0, pipeIdx).trim();
    jobTitle = rawTitle.slice(pipeIdx + 1).trim();
  } else if (colonIdx > 0 && colonIdx < 40) {
    companyName = rawTitle.slice(0, colonIdx).trim();
    jobTitle = rawTitle.slice(colonIdx + 1).trim();
  }

  const description = stripHtml(item.description);
  const text = `${jobTitle} ${description}`.toLowerCase();

  return {
    source: SOURCE,
    sourcePriority: 5,
    canonicalUrl: item.link,
    title: jobTitle,
    company: companyName,
    companySummary: '',
    companySlug: companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: 'Remote',
    countryCode: null,
    city: null,
    workMode: 'remote',
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
    startupSignals: [],
    applyUrl: item.link,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsorship', 'visa sponsor']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
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
