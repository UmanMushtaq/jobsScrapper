import { JobPosting, SearchSettings } from '../types';
import { inferCountryCode } from './country-codes';
import { detectLanguage } from './language-detect';
import { proxyFetch } from '../proxy-fetch';
import { JobSource } from './registry';

const SOURCE = 'himalayas.app';

interface HimalayasCompany {
  name: string;
  slug?: string;
  website?: string;
}

interface HimalayasJob {
  id: string | number;
  title: string;
  company: HimalayasCompany;
  description?: string;
  url: string;
  applicationUrl?: string;
  location?: string;
  countries?: string[];
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  postedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
}

interface HimalayasResponse {
  jobs?: HimalayasJob[];
  data?: HimalayasJob[];
}

const RELEVANT_TAGS = [
  'node.js', 'nodejs', 'node', 'nestjs', 'typescript', 'javascript',
  'backend', 'back-end', 'express', 'postgresql', 'postgres',
];

export class HimalayasJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    try {
      // Two skill-filtered passes to avoid a too-broad API call; deduplicate by URL.
      const apiUrls = [
        'https://himalayas.app/jobs/api?limit=100&skills=node.js,typescript,nestjs,express',
        'https://himalayas.app/jobs/api?limit=100&skills=backend,node.js',
      ];
      const allJobResults: HimalayasJob[] = [];
      for (const apiUrl of apiUrls) {
        const r = await proxyFetch(apiUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            'Accept': 'application/json',
          },
        });
        if (!r.ok) {
          console.log(`[himalayas] API ${r.status} for ${apiUrl}`);
          continue;
        }
        const d = (await r.json()) as HimalayasResponse;
        allJobResults.push(...(d.jobs ?? d.data ?? []));
      }

      const seenUrls = new Set<string>();
      const jobs = allJobResults.filter((j) => {
        const k = j.url ?? String(j.id);
        if (seenUrls.has(k)) return false;
        seenUrls.add(k);
        return true;
      });

      if (jobs.length === 0) {
        console.log('[himalayas] empty or unexpected response format');
        return [];
      }

      const lookbackHours = Math.max(settings.maxAgeHours, 168);
      const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
      const fresh = jobs.filter((job) => {
        const dateStr = job.postedAt ?? job.createdAt ?? job.updatedAt;
        if (!dateStr) return true;
        return new Date(dateStr).getTime() >= cutoff;
      });

      const relevant = fresh.filter((job) => isRelevant(job));

      if (fresh.length === 0) {
        console.log(`[himalayas] ${jobs.length} total jobs but none within ${lookbackHours}h`);
      } else if (relevant.length === 0) {
        console.log(`[himalayas] ${fresh.length} fresh jobs but none match Node.js/TS/backend tags`);
      } else {
        console.log(`[himalayas] ${relevant.length} relevant from ${fresh.length} fresh / ${jobs.length} total`);
      }

      return relevant.map(mapJob);
    } catch (error) {
      console.error('[himalayas] error:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

function isRelevant(job: HimalayasJob): boolean {
  const title = (job.title ?? '').toLowerCase();
  const tags = (job.tags ?? []).map((t) => t.toLowerCase());
  return (
    RELEVANT_TAGS.some((t) => title.includes(t)) ||
    RELEVANT_TAGS.some((t) => tags.some((tag) => tag.includes(t)))
  );
}

function mapJob(job: HimalayasJob): JobPosting {
  const description = stripHtml(job.description ?? '');
  const text = `${job.title} ${description}`.toLowerCase();
  const location = job.location ?? '';
  const companyName = job.company?.name ?? 'Unknown';

  const dateStr = job.postedAt ?? job.createdAt ?? job.updatedAt ?? new Date().toISOString();
  const publishedAt = new Date(dateStr);
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);

  const salaryMin = job.salaryMin ?? null;
  const salaryMax = job.salaryMax ?? null;
  const currency = job.salaryCurrency ?? null;

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl: job.url,
    title: job.title,
    company: companyName,
    companySummary: '',
    companySlug: (job.company?.slug ?? companyName).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: location || 'Remote',
    countryCode: inferCountryCodeFromHimalayas(location, job.countries),
    city: null,
    workMode: 'remote',
    language: detectLanguage(`${job.title} ${description}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: salaryMin !== null ? (currency ?? 'USD') : null,
    salaryPeriod: salaryMin !== null ? 'yearly' : null,
    salaryMinimum: salaryMin,
    salaryMaximum: salaryMax,
    salaryYearlyMinimum: salaryMin,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: isNaN(publishedAtTimestamp) ? Math.floor(Date.now() / 1000) : publishedAtTimestamp,
    startupSignals: [],
    applyUrl: job.applicationUrl ?? job.url,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsorship', 'visa sponsor']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferCountryCodeFromHimalayas(location: string, countries?: string[]): string | null {
  const preferred = ['FR','DE','BE','NL','IE','LU','PL','SE','ES','PT','DK','FI','NO','CZ','CH','AT','GB','IT','GR','HU','SK','SI','EE','IS'];
  for (const cc of preferred) {
    if (countries?.includes(cc)) return cc;
  }
  return inferCountryCode(location);
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
