import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { postDateFrom } from './post-date';

// FAJIG Strategy 1 ("Numbers Game") Google-search sub-guide, implemented as a real
// source instead of a manual technique. Saved reference:
// https://docs.google.com/document/d/1xF-jimaPYT7AK8_hZbCNKxKOWYRSesH752F0RvpSLrY/edit
//
// The course's template is a literal Google search string:
//   job name inurl:ats_platform intext:country_name
// e.g. "node.js developer inurl:personio intext:germany"
//
// This can't be a page scrape (there's no listing page to crawl, it's a live Google
// search), so it goes through the Google Custom Search JSON API instead — the same
// query template, issued programmatically, four ATS domains x Uman's keyword set.
// Needs GOOGLE_CSE_API_KEY and GOOGLE_CSE_CX (a Programmable Search Engine configured
// to search the open web, not restricted to specific sites — the inurl:/intext:
// operators do the restricting). Free tier is 100 queries/day; this source issues
// JOB_NAME_QUERIES.length x ATS_PLATFORMS.length queries per run (20 at the set below)
// and is deliberately kept off the fast/Playwright schedules — see SLOW_SCHEDULER_ONLY
// in run.ts — so three runs/day (480min interval) stays at 60/day, under budget.

const SOURCE = 'google-ats-search.de';
const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';

// Verbatim job-name terms captured from the FAJIG lesson and Uman's own adapted
// examples (both saved in the Drive doc above) — not the bot's general CORE_KEYWORDS
// list, since the course specifically recommends playing with these exact phrasings
// against each ATS rather than every keyword variant used elsewhere in the bot.
const JOB_NAME_QUERIES = [
  'node.js developer',
  'nestjs developer',
  'backend developer',
  'backend engineer',
  'node.js typescript postgresql',
];

// The four ATS platforms named in the FAJIG lesson. inurl: terms match the course's own
// examples exactly (bare "personio"/"lever", full domain for join.com/workable.com).
const ATS_PLATFORMS = [
  { name: 'personio', inurlTerm: 'personio' },
  { name: 'join', inurlTerm: 'join.com' },
  { name: 'lever', inurlTerm: 'lever' },
  { name: 'workable', inurlTerm: 'workable.com' },
];

// Country-locked to Germany — the only country the FAJIG course demonstrated this
// technique for. Widening to other ALLOWED_COUNTRIES (see allowed-countries.ts) is a
// separate follow-up, not yet actioned.
const INTEXT_COUNTRY = 'germany';
const COUNTRY_LABEL = 'Germany';
const COUNTRY_CODE = 'DE';

interface GoogleCseItem {
  title: string;
  link: string;
  snippet?: string;
  displayLink?: string;
}

interface GoogleCseResponse {
  items?: GoogleCseItem[];
  error?: { code: number; message: string };
}

export class GoogleAtsSearchSource implements JobSource {
  name = SOURCE;
  priority = 6;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    const apiKey = process.env.GOOGLE_CSE_API_KEY;
    const cx = process.env.GOOGLE_CSE_CX;

    if (!apiKey || !cx) {
      console.log('[google-ats-search] skipped: GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX not set');
      return [];
    }

    const jobs = new Map<string, JobPosting>();

    for (const jobName of JOB_NAME_QUERIES) {
      for (const ats of ATS_PLATFORMS) {
        const q = `${jobName} inurl:${ats.inurlTerm} intext:${INTEXT_COUNTRY}`;
        try {
          const results = await fetchQuery(apiKey, cx, q, ats.name);
          for (const job of results) {
            jobs.set(job.canonicalUrl, job);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[google-ats-search] error for "${q}": ${msg}`);
        }
      }
    }

    if (jobs.size === 0) {
      console.log('[google-ats-search] 0 relevant jobs found');
    } else {
      console.log(`[google-ats-search] ${jobs.size} unique relevant results`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchQuery(
  apiKey: string,
  cx: string,
  q: string,
  atsName: string,
): Promise<JobPosting[]> {
  const params = new URLSearchParams({ key: apiKey, cx, q, num: '10' });

  const response = await fetch(`${GOOGLE_CSE_URL}?${params.toString()}`);

  if (response.status === 429) {
    console.log(`[google-ats-search] 429 quota exceeded for "${q}" — stopping this run`);
    return [];
  }
  if (!response.ok) {
    throw new Error(`Google CSE API ${response.status}`);
  }

  const data = (await response.json()) as GoogleCseResponse;
  if (data.error) {
    throw new Error(`Google CSE API error: ${data.error.message}`);
  }

  const items = data.items ?? [];
  return items.map((item) => mapItem(item, atsName)).filter((j): j is JobPosting => j !== null);
}

export function mapItem(item: GoogleCseItem, atsName: string): JobPosting | null {
  if (!item.link || !item.title) return null;

  const snippet = item.snippet ?? '';
  const company = companyFromUrl(item.link, atsName) ?? 'Unknown';
  const text = `${item.title} ${snippet}`.toLowerCase();

  // Google doesn't return a reliable posting date for these results — treated as
  // no-post-date (same handling as any other source with no date signal, via run.ts's
  // noDateSeenUrls tracking), rather than guessed from the scrape time.
  const postDate = postDateFrom(null);

  return {
    source: SOURCE,
    sourcePriority: 6,
    canonicalUrl: item.link,
    title: item.title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: COUNTRY_LABEL,
    countryCode: COUNTRY_CODE,
    city: null,
    workMode: 'on-site',
    language: detectLanguage(`${item.title} ${snippet}`),
    description: snippet,
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    ...postDate,
    startupSignals: [],
    applyUrl: item.link,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsorship', 'visa sponsor', 'work permit']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
    // A search-result snippet, never the full JD — same signal as Adzuna/Jooble
    // truncation, so the language filter and scorer both know this one needs a second
    // look rather than being scored as if it were complete.
    descriptionPartial: true,
  };
}

// Heuristic company-name extraction from the ATS's own URL shape. Each ATS has a
// different pattern, and this is a best-effort guess, not authoritative — the human
// reviewing the dashboard card is the actual verification step.
function companyFromUrl(url: string, atsName: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname.split('/').filter(Boolean);

    switch (atsName) {
      case 'personio':
        // company.personio.de / company.jobs.personio.de
        return titleCase(host.split('.')[0]);
      case 'join':
        // company.join.com or join.com/companies/company-slug/...
        if (host !== 'join.com' && host.endsWith('join.com')) {
          return titleCase(host.split('.')[0]);
        }
        if (path[0] === 'companies' && path[1]) return titleCase(path[1]);
        return null;
      case 'lever':
        // jobs.lever.co/company-slug/...
        return path[0] ? titleCase(path[0]) : null;
      case 'workable':
        // apply.workable.com/company-slug/... or company.workable.com
        if (host !== 'apply.workable.com' && host.endsWith('workable.com')) {
          return titleCase(host.split('.')[0]);
        }
        return path[0] ? titleCase(path[0]) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function titleCase(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
