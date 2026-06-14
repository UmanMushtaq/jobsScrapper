import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'nofluffjobs.com';

interface NfLocation {
  places?: Array<{ city?: string; country?: { code?: string; name?: string } }>;
  fullyRemote?: boolean;
}

interface NfSalary {
  from?: number;
  to?: number;
  currency?: string;
  type?: string; // 'b2b' | 'permanent'
}

interface NfPosting {
  id?: string;
  name?: string;       // URL slug
  title?: string;
  company?: { name?: string };
  location?: NfLocation;
  salary?: NfSalary;
  technology?: string;
  category?: string;
  seniority?: string[];
  essentialSkills?: string[];
  niceToHaveSkills?: string[];
  english?: string;    // e.g. 'b2', 'c1' — present when English is required
  posted?: string;     // ISO 8601
}

interface NfResponse {
  postings?: NfPosting[];
  totalCount?: number;
}

const RELEVANT_TAGS = ['node', 'node.js', 'nodejs', 'nestjs', 'typescript', 'javascript', 'backend', 'express', 'postgresql'];

const ENGLISH_SIGNALS = [
  'english', 'anglais', 'język angielski', 'english required', 'english mandatory',
  'english speaking', 'b2', 'c1', 'c2', 'fluent english', 'working in english',
];

const SEARCH_URLS = [
  'https://nofluffjobs.com/api/search/posting?criteria=requirement%3Dnode.js&salaryCurrency=PLN&salaryPeriod=month',
  'https://nofluffjobs.com/api/search/posting?criteria=requirement%3Dtypescript&salaryCurrency=PLN&salaryPeriod=month',
  'https://nofluffjobs.com/api/search/posting?criteria=requirement%3Dnestjs',
];

export class NoFluffJobsSource implements JobSource {
  name = SOURCE;
  priority = 5;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

    for (const url of SEARCH_URLS) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

        if (response.status === 403 || response.status === 429) {
          console.log(`[nofluffjobs] blocked ${response.status} — skipping`);
          continue;
        }
        if (!response.ok) {
          console.warn(`[nofluffjobs] HTTP ${response.status} for ${url}`);
          continue;
        }

        const data = (await response.json()) as NfResponse;
        const postings = data.postings ?? [];

        const relevant = postings.filter((p) => {
          if (p.posted && new Date(p.posted).getTime() < cutoff) return false;
          return isRelevant(p);
        });

        for (const posting of relevant) {
          const mapped = mapPosting(posting);
          if (mapped) jobs.set(mapped.canonicalUrl, mapped);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED')) {
          console.error(`[nofluffjobs] error: ${msg}`);
        }
      }
    }

    if (jobs.size === 0) {
      console.log('[nofluffjobs] 0 relevant jobs found');
    } else {
      console.log(`[nofluffjobs] ${jobs.size} unique relevant jobs`);
    }

    return Array.from(jobs.values());
  }
}

function isRelevant(p: NfPosting): boolean {
  const skills = [...(p.essentialSkills ?? []), ...(p.niceToHaveSkills ?? [])].map((s) => s.toLowerCase());
  const title = (p.title ?? '').toLowerCase();
  const tech = (p.technology ?? '').toLowerCase();
  const category = (p.category ?? '').toLowerCase();

  const tagMatch = RELEVANT_TAGS.some((t) => skills.includes(t) || title.includes(t) || tech.includes(t) || category.includes(t));
  if (!tagMatch) return false;

  // Require English: either the `english` field is set or description/skills mention English signals
  if (p.english) return true;
  const allText = [...skills, title].join(' ');
  return ENGLISH_SIGNALS.some((s) => allText.includes(s));
}

function mapPosting(p: NfPosting): JobPosting | null {
  if (!p.title || !p.name) return null;

  const canonicalUrl = `https://nofluffjobs.com/job/${p.name}`;
  const company = p.company?.name ?? 'Unknown';
  const location = p.location;
  const fullyRemote = location?.fullyRemote ?? false;
  const firstPlace = location?.places?.[0];
  const city = firstPlace?.city ?? null;
  const countryCode = firstPlace?.country?.code ?? 'PL';
  const locationLabel = city ? `${city}, ${firstPlace?.country?.name ?? 'Poland'}` : (fullyRemote ? 'Remote' : 'Poland');

  const salary = p.salary;
  const salaryMin = salary?.from ?? null;
  const salaryMax = salary?.to ?? null;
  const salaryCurrency = salary?.currency ?? null;

  // Convert monthly PLN to yearly for consistent comparison
  const salaryYearlyMinimum = salaryMin !== null && salaryCurrency === 'PLN' ? salaryMin * 12 : salaryMin;

  const skills = [...(p.essentialSkills ?? []), ...(p.niceToHaveSkills ?? [])].join(' ');
  const fullText = `${p.title} ${skills}`.toLowerCase();

  const publishedAt = p.posted ? new Date(p.posted) : new Date();
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);

  return {
    source: SOURCE,
    sourcePriority: 5,
    canonicalUrl,
    title: p.title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode,
    city,
    workMode: fullyRemote ? 'remote' : 'on-site',
    language: detectLanguage(fullText),
    description: skills,
    keyMissions: [],
    experienceLevelMinimum: mapSeniority(p.seniority),
    salaryCurrency,
    salaryPeriod: salaryMin !== null ? 'monthly' : null,
    salaryMinimum: salaryMin,
    salaryMaximum: salaryMax,
    salaryYearlyMinimum,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: false,
    isStartup: containsAny(fullText, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function mapSeniority(levels: string[] | undefined): number | null {
  if (!levels?.length) return null;
  if (levels.includes('junior')) return 1;
  if (levels.includes('mid')) return 3;
  if (levels.includes('senior')) return 5;
  return null;
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
