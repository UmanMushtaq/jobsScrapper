import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

const SOURCE = 'arbeitnow.com';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
  visa_sponsorship: boolean;
}

interface ArbeitnowResponse {
  data: ArbeitnowJob[];
  meta: { current_page: number; last_page: number };
}

const RELEVANT_TAGS = ['node', 'nodejs', 'node.js', 'typescript', 'javascript', 'backend', 'nestjs', 'express', 'postgresql', 'api'];

export class ArbeitnowJobsSource implements JobSource {
  name = SOURCE;
  priority = 6;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const maxPages = Number(process.env.ARBEITNOW_MAX_PAGES ?? 3);
    const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

    for (let page = 1; page <= maxPages; page++) {
      try {
        const response = await fetch(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);

        if (!response.ok) {
          throw new Error(`Arbeitnow API error: ${response.status}`);
        }

        const data = (await response.json()) as ArbeitnowResponse;
        const relevant = data.data
          .filter((job) => job.created_at * 1000 >= cutoff)
          .filter((job) => isRelevant(job));

        for (const job of relevant) {
          const mapped = mapJob(job);
          jobs.set(mapped.canonicalUrl, mapped);
        }

        if (page >= data.meta.last_page) break;
      } catch (error) {
        console.error(`[arbeitnow] error page ${page}:`, error instanceof Error ? error.message : String(error));
        break;
      }
    }

    return Array.from(jobs.values());
  }
}

function isRelevant(job: ArbeitnowJob): boolean {
  const tags = (job.tags ?? []).map((t) => t.toLowerCase());
  const title = (job.title ?? '').toLowerCase();
  const desc = (job.description ?? '').toLowerCase();
  return (
    RELEVANT_TAGS.some((tag) => tags.includes(tag)) ||
    RELEVANT_TAGS.some((tag) => title.includes(tag)) ||
    (desc.includes('node') && desc.includes('backend'))
  );
}

function mapJob(job: ArbeitnowJob): JobPosting {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const countryCode = inferCountryCode(job.location);

  return {
    source: SOURCE,
    sourcePriority: 6,
    canonicalUrl: job.url,
    title: job.title,
    company: job.company_name,
    companySummary: '',
    companySlug: job.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: job.location || 'Europe',
    countryCode,
    city: null,
    workMode: job.remote ? 'remote' : 'on-site',
    language: inferLanguage(text),
    description: stripHtml(job.description),
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: new Date(job.created_at * 1000).toISOString(),
    publishedAtTimestamp: job.created_at,
    startupSignals: [],
    applyUrl: job.url,
    offersRelocation: job.visa_sponsorship || containsAny(text, ['relocation', 'visa sponsorship']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function inferCountryCode(location: string): string | null {
  const loc = (location ?? '').toLowerCase();
  if (loc.includes('france') || loc.includes('paris')) return 'FR';
  if (loc.includes('germany') || loc.includes('berlin') || loc.includes('munich') || loc.includes('münchen')) return 'DE';
  if (loc.includes('netherlands') || loc.includes('amsterdam')) return 'NL';
  if (loc.includes('switzerland') || loc.includes('zürich') || loc.includes('zurich')) return 'CH';
  if (loc.includes('austria') || loc.includes('vienna') || loc.includes('wien')) return 'AT';
  if (loc.includes('belgium') || loc.includes('brussels')) return 'BE';
  if (loc.includes('luxembourg')) return 'LU';
  if (loc.includes('uk') || loc.includes('london')) return 'GB';
  if (loc.includes('poland') || loc.includes('warsaw') || loc.includes('warszawa') || loc.includes('krakow') || loc.includes('kraków') || loc.includes('wroclaw') || loc.includes('wrocław') || loc.includes('gdansk') || loc.includes('gdańsk') || loc.includes('poznan') || loc.includes('poznań')) return 'PL';
  if (loc.includes('sweden') || loc.includes('stockholm') || loc.includes('gothenburg') || loc.includes('göteborg') || loc.includes('malmo') || loc.includes('malmö') || loc.includes('uppsala')) return 'SE';
  if (loc.includes('spain') || loc.includes('madrid') || loc.includes('barcelona')) return 'ES';
  if (loc.includes('portugal') || loc.includes('lisbon') || loc.includes('lisboa')) return 'PT';
  if (loc.includes('ireland') || loc.includes('dublin')) return 'IE';
  if (loc.includes('denmark') || loc.includes('copenhagen')) return 'DK';
  if (loc.includes('finland') || loc.includes('helsinki')) return 'FI';
  if (loc.includes('norway') || loc.includes('oslo')) return 'NO';
  if (loc.includes('czechia') || loc.includes('czech') || loc.includes('prague') || loc.includes('praha')) return 'CZ';
  return 'DE';
}

function inferLanguage(text: string): string {
  const germanSignals = ['wir suchen', 'stellenangebote', 'kenntnisse', 'erfahrung', 'anforderungen', 'aufgaben'];
  const frenchSignals = ['rejoignez', 'nous recherchons', 'expérience', 'compétences'];
  if (germanSignals.filter((t) => text.includes(t)).length >= 2) return 'de';
  if (frenchSignals.filter((t) => text.includes(t)).length >= 2) return 'fr';
  return 'en';
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
