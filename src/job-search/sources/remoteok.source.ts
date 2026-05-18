import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

const SOURCE = 'remoteok.com';

interface RemoteOKJob {
  slug: string;
  id: string;
  epoch: number;
  date: string;
  company: string;
  position: string;
  tags: string[];
  description: string;
  url: string;
  salary_min?: number;
  salary_max?: number;
  location?: string;
  legal?: string;
}

const RELEVANT_TAGS = ['node', 'nodejs', 'node.js', 'typescript', 'javascript', 'backend', 'nestjs', 'express', 'postgresql', 'postgres'];

export class RemoteOKJobsSource implements JobSource {
  name = SOURCE;
  priority = 5;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    try {
      const response = await fetch('https://remoteok.com/api', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://remoteok.com/',
        },
      });

      if (response.status === 403) {
        // RemoteOK blocks cloud provider IPs — fail silently, no point retrying
        return [];
      }

      if (!response.ok) {
        throw new Error(`RemoteOK API error: ${response.status}`);
      }

      const data = (await response.json()) as RemoteOKJob[];
      const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

      return data
        .filter((job) => !job.legal)
        .filter((job) => job.epoch * 1000 >= cutoff)
        .filter((job) => isRelevant(job))
        .map(mapJob);
    } catch (error) {
      console.error('[remoteok] error:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }
}

function isRelevant(job: RemoteOKJob): boolean {
  const tags = (job.tags ?? []).map((t) => t.toLowerCase());
  const position = (job.position ?? '').toLowerCase();
  return (
    RELEVANT_TAGS.some((tag) => tags.includes(tag)) ||
    RELEVANT_TAGS.some((tag) => position.includes(tag))
  );
}

function mapJob(job: RemoteOKJob): JobPosting {
  const text = `${job.position} ${job.description ?? ''}`.toLowerCase();
  const salaryMin = job.salary_min ?? null;

  return {
    source: SOURCE,
    sourcePriority: 5,
    canonicalUrl: job.url,
    title: job.position,
    company: job.company,
    companySummary: '',
    companySlug: job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: job.location || 'Remote',
    countryCode: null,
    city: null,
    workMode: 'remote',
    language: 'en',
    description: stripHtml(job.description ?? ''),
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: salaryMin !== null ? 'USD' : null,
    salaryPeriod: salaryMin !== null ? 'yearly' : null,
    salaryMinimum: salaryMin,
    salaryMaximum: job.salary_max ?? null,
    salaryYearlyMinimum: salaryMin,
    publishedAt: new Date(job.epoch * 1000).toISOString(),
    publishedAtTimestamp: job.epoch,
    startupSignals: [],
    applyUrl: job.url,
    offersRelocation: false,
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
