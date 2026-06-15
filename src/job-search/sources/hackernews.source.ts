import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

const SOURCE = 'news.ycombinator.com';
const ALGOLIA = 'https://hn.algolia.com/api/v1';

const HN_CURRENT_THREAD_ID = '48357725';

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

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Resolved once at startup, reused for the entire session
let resolvedThreadId: string | null = null;

// In-memory cache: re-fetch when the month changes or on first run
let cache: { monthKey: string; storyId: string; jobs: JobPosting[] } | null = null;

async function getCurrentHNThreadId(): Promise<string> {
  try {
    const now = new Date();
    const month = MONTHS[now.getMonth()];
    const year = now.getFullYear();
    const pattern = new RegExp(`Ask HN: Who is hiring\\? \\(${month} ${year}\\)`, 'i');

    const res = await fetch(
      'https://hn.algolia.com/api/v1/search?query=Ask+HN+Who+is+hiring&tags=ask_hn&hitsPerPage=5',
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-search-bot/1.0)' } },
    );
    if (res.ok) {
      const data = (await res.json()) as AlgoliaResponse<AlgoliaStoryHit>;
      const hit = data.hits.find((h) => pattern.test(h.title ?? ''));
      if (hit) {
        console.log(`[hackernews] HN thread resolved: ${hit.objectID} (${month} ${year})`);
        return hit.objectID;
      }
    }
  } catch (err) {
    console.error('[hackernews] thread auto-detect failed:', err instanceof Error ? err.message : String(err));
  }

  const now = new Date();
  const month = MONTHS[now.getMonth()];
  const year = now.getFullYear();
  console.log(`[hackernews] HN thread resolved: ${HN_CURRENT_THREAD_ID} (${month} ${year}) [fallback]`);
  return HN_CURRENT_THREAD_ID;
}

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

      if (!resolvedThreadId) {
        resolvedThreadId = await getCurrentHNThreadId();
      }
      const storyId = resolvedThreadId;
      console.log(`[hackernews] fetching thread ${storyId}`);

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

  // Reject if the extracted URL looks like a blog/article rather than a job listing
  const BLOG_PATH_SIGNALS = ['/blog/', '/engineering/', '/news/', '/article/', '/post/', '/announcement/'];
  const JOB_PATH_SIGNALS = ['/jobs/', '/careers/', '/apply/', '/opening/', '/position/'];
  if (!applyUrl.includes('news.ycombinator.com')) {
    try {
      const urlPath = new URL(applyUrl).pathname.toLowerCase();
      const isBlogPath = BLOG_PATH_SIGNALS.some((s) => urlPath.includes(s));
      const isJobPath = JOB_PATH_SIGNALS.some((s) => urlPath.includes(s));
      if (isBlogPath && !isJobPath) {
        console.log(`[hackernews] FILTERED: ${company}, URL is blog/article not job listing (${applyUrl})`);
        return null;
      }
    } catch { /* invalid URL — let it through */ }
  }

  // Title: scan full text for any recognizable engineer/developer role first
  const titleRegexMatch =
    plain.match(/\b(?:backend|back-end|full.?stack|fullstack|software|node\.?js|typescript|api|platform|data)\s+engineer\b/i) ??
    plain.match(/\b(?:site\s+reliability|devops|cloud|infrastructure|security)\s+engineer\b/i) ??
    plain.match(/\b(?:backend|back-end|full.?stack|fullstack|software|web|frontend|front-end)\s+developer\b/i) ??
    plain.match(/\bsoftware\s+architect\b/i) ??
    null;

  let extractedTitle: string | null = titleRegexMatch
    ? (typeof titleRegexMatch === 'string' ? titleRegexMatch : titleRegexMatch[0])
    : null;

  // If no regex match, scan pipe-parts for a part that looks like a job title
  if (!extractedTitle) {
    for (let i = 1; i < Math.min(parts.length, 5); i++) {
      const part = parts[i].trim();
      if (part.length > 2 && part.length < 60 && /\b(?:engineer|developer|architect|programmer|analyst|designer|sre|devops)\b/i.test(part)) {
        extractedTitle = part;
        break;
      }
    }
  }

  const title = extractedTitle ?? 'Backend Engineer';

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
  if (plusMatch) return parseInt(plusMatch[1]);
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
