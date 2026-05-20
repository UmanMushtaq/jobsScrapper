import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

const SOURCE = 'news.ycombinator.com';
const ALGOLIA = 'https://hn.algolia.com/api/v1';

const RELEVANT_KEYWORDS = [
  'node.js', 'nodejs', 'node ', 'typescript', 'nestjs', 'express',
  'backend', 'back-end', 'postgresql', 'postgres',
];

interface AlgoliaHit {
  objectID: string;
  comment_text?: string;
  parent_id?: number;
  created_at: string;
  author: string;
}

interface AlgoliaStoryHit {
  objectID: string;
  title?: string;
  created_at: string;
}

interface AlgoliaResponse<T> {
  hits: T[];
}

// In-memory cache: re-fetch when the month changes or on first run
let cache: { monthKey: string; storyId: string; jobs: JobPosting[] } | null = null;

export class HackerNewsJobsSource implements JobSource {
  name = SOURCE;
  priority = 7;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    try {
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${now.getMonth()}`;

      if (cache && cache.monthKey === monthKey) {
        return cache.jobs;
      }

      const storyRes = await fetch(
        `${ALGOLIA}/search?query=Ask+HN%3A+Who+is+Hiring%3F&tags=story%2Cauthor_whoishiring&hitsPerPage=1`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-search-bot/1.0)' } },
      );
      if (!storyRes.ok) return [];

      const storyData = (await storyRes.json()) as AlgoliaResponse<AlgoliaStoryHit>;
      const story = storyData.hits[0];
      if (!story) return [];

      const storyId = story.objectID;
      console.log(`[hackernews] fetching "${story.title ?? 'Who is Hiring'}" (${storyId})`);

      // Fetch top-level comments only (direct replies to the story)
      const commentsRes = await fetch(
        `${ALGOLIA}/search?tags=comment%2Cstory_${storyId}&hitsPerPage=1000`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-search-bot/1.0)' } },
      );
      if (!commentsRes.ok) return [];

      const commentsData = (await commentsRes.json()) as AlgoliaResponse<AlgoliaHit>;
      const topLevel = commentsData.hits.filter((h) => String(h.parent_id) === storyId);

      const jobs = topLevel
        .map(parseComment)
        .filter((j): j is JobPosting => j !== null);

      cache = { monthKey, storyId, jobs };
      console.log(`[hackernews] ${jobs.length} relevant jobs from ${topLevel.length} total comments`);
      return jobs;
    } catch (error) {
      console.error('[hackernews] error:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

function parseComment(hit: AlgoliaHit): JobPosting | null {
  const html = hit.comment_text ?? '';
  if (!html || html.length < 40) return null;

  const plain = stripHtml(html).trim();
  const lower = plain.toLowerCase();

  if (!RELEVANT_KEYWORDS.some((kw) => lower.includes(kw))) return null;

  const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const firstLine = lines[0];

  // Common format: "Company | Location | Remote | $salary | Stack"
  const parts = firstLine.includes('|')
    ? firstLine.split('|').map((p) => p.trim())
    : [firstLine];

  // Company is first part, strip annotations like "(YC S21)"
  let company = (parts[0] ?? '').replace(/\([^)]*\)/g, '').replace(/^(we are|at|join|hiring at)\s+/i, '').trim();
  // Some posts start with "Company Name - Job Title" or "Company Name, description"
  company = company.split(' - ')[0].trim();
  // Strip comma-separated description that follows the actual company name
  // e.g. "LearnerShape, AI-driven workforce skills startup" → "LearnerShape"
  const commaIdx = company.indexOf(',');
  if (commaIdx > 1) company = company.slice(0, commaIdx).trim();
  if (!company || company.length < 2 || company.length > 80) return null;

  const workMode: 'remote' | 'hybrid' | 'on-site' =
    lower.includes('remote') ? 'remote'
    : lower.includes('hybrid') ? 'hybrid'
    : 'on-site';

  // Location: second part if it exists and doesn't look like a flag
  const rawLocation = parts[1] ?? (workMode === 'remote' ? 'Remote' : '');
  const locationLabel = rawLocation.length > 0 && rawLocation.length < 60 ? rawLocation : (workMode === 'remote' ? 'Remote' : 'Unknown');

  // Set countryCode even for remote jobs so the location filter can enforce usaJobs:false
  const countryCode = guessCountryCode(locationLabel);

  // Extract apply URL from HTML (first non-HN link). HN encodes slashes as &#x2F; inside href attributes.
  const urlMatches = [...html.matchAll(/href="([^"]+)"/g)];
  const applyUrl =
    urlMatches.map((m) => decodeUrlEntities(m[1])).find((u) => u.startsWith('http') && !u.includes('news.ycombinator.com'))
    ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;

  // Title: look for role keywords in the text
  const titleMatch =
    plain.match(/\b(?:backend|full.?stack|software|node\.?js|typescript)\s+engineer\b/i) ??
    plain.match(/\b(?:senior\s+)?(?:backend|software|fullstack)\s+developer\b/i) ??
    parts[2] ?? null;
  const title = titleMatch
    ? (typeof titleMatch === 'string' ? titleMatch : titleMatch[0])
    : 'Backend Engineer';

  // Salary: "$100k-$150k" or "$100,000-$150,000"
  const salaryMatch = plain.match(/\$\s*([\d,]+)\s*[kK]?\s*(?:[-–])\s*\$?\s*([\d,]+)\s*[kK]?/);
  let salaryMinimum: number | null = null;
  let salaryMaximum: number | null = null;
  if (salaryMatch) {
    const parse = (s: string) => {
      const n = parseInt(s.replace(/,/g, ''));
      return n < 1000 ? n * 1000 : n;
    };
    salaryMinimum = parse(salaryMatch[1]);
    salaryMaximum = parse(salaryMatch[2]);
  }

  // Set publishedAt to now so it always passes the maxAgeHours filter
  // (HN thread is monthly; dedup via seen_urls prevents re-sending)
  const publishedAtTimestamp = Math.floor(Date.now() / 1000);

  return {
    source: SOURCE,
    sourcePriority: 7,
    canonicalUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title: capitalize(typeof title === 'string' ? title : title[0]),
    company,
    companySummary: plain.slice(0, 400),
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode,
    city: null,
    workMode,
    language: 'en',
    description: plain,
    keyMissions: [],
    experienceLevelMinimum: extractExperience(plain),
    salaryCurrency: salaryMinimum !== null ? 'USD' : null,
    salaryPeriod: salaryMinimum !== null ? 'yearly' : null,
    salaryMinimum,
    salaryMaximum,
    salaryYearlyMinimum: salaryMinimum,
    publishedAt: new Date(publishedAtTimestamp * 1000).toISOString(),
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl,
    offersRelocation: lower.includes('relocation') || lower.includes('visa sponsor'),
    isStartup: lower.includes('startup') || lower.includes('seed') || lower.includes('series a') || lower.includes('yc'),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function extractExperience(text: string): number | null {
  const lower = text.toLowerCase();
  const plusMatch = lower.match(/(\d+)\+\s*years?/);
  if (plusMatch) return parseInt(plusMatch[1]) + 1;
  const rangeMatch = lower.match(/(\d+)\s*(?:to|-)\s*\d+\s+years?/);
  if (rangeMatch) return parseInt(rangeMatch[1]);
  const yearsMatch = lower.match(/(\d+)\s+years?\s+(?:of\s+)?(?:experience|exp)/);
  if (yearsMatch) return parseInt(yearsMatch[1]);
  return null;
}

function guessCountryCode(location: string): string | null {
  const l = location.toUpperCase();
  if (l.includes('USA') || l.includes('UNITED STATES') || l.includes(', CA') || l.includes(', NY') || l.includes(', TX')) return 'US';
  if (l.includes('UK') || l.includes('UNITED KINGDOM') || l.includes('LONDON')) return 'GB';
  if (l.includes('GERMANY') || l.includes('BERLIN') || l.includes('MUNICH')) return 'DE';
  if (l.includes('FRANCE') || l.includes('PARIS')) return 'FR';
  if (l.includes('NETHERLANDS') || l.includes('AMSTERDAM')) return 'NL';
  if (l.includes('POLAND') || l.includes('WARSAW') || l.includes('KRAKOW')) return 'PL';
  if (l.includes('SWEDEN') || l.includes('STOCKHOLM')) return 'SE';
  if (l.includes('SPAIN') || l.includes('MADRID') || l.includes('BARCELONA')) return 'ES';
  if (l.includes('IRELAND') || l.includes('DUBLIN')) return 'IE';
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeUrlEntities(url: string): string {
  return url.replace(/&#x2F;/gi, '/').replace(/&amp;/g, '&');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
