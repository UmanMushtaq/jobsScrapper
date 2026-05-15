import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

const SOURCE = 'greenhouse.io';
const API_BASE = 'https://boards-api.greenhouse.io/v1/boards';

// Well-known French and European tech companies using Greenhouse
const DEFAULT_COMPANIES = [
  'algolia', 'aircall', 'alan', 'ankorstore', 'back-market',
  'blablacar', 'contentsquare', 'dataiku', 'doctolib', 'doctrine',
  'ledger', 'malt', 'owkin', 'payfit', 'pennylane',
  'qonto', 'swile', 'toucan-toco', 'datadog', 'stripe',
  'deliveroo', 'revolut', 'n26', 'spendesk', 'platform-sh',
  'mirakl', 'axelor', 'cegid', 'sendinblue', 'tinyclues',
];

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at: string;
  location: { name: string };
  absolute_url: string;
  content?: string;
  departments?: Array<{ name: string }>;
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export class GreenhouseJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const envCompanies = process.env.GREENHOUSE_COMPANIES;
    const companies = envCompanies
      ? envCompanies.split(',').map((c) => c.trim().toLowerCase())
      : DEFAULT_COMPANIES;

    const jobs = new Map<string, JobPosting>();
    const queryTerms = queries.map((q) => q.toLowerCase());

    for (const company of companies) {
      try {
        const results = await fetchCompanyJobs(company, settings);
        for (const job of results) {
          if (isRelevant(job.title, queryTerms)) {
            jobs.set(job.canonicalUrl, job);
          }
        }
      } catch (error) {
        console.error(
          `[greenhouse] error for "${company}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return Array.from(jobs.values());
  }
}

async function fetchCompanyJobs(
  company: string,
  settings: SearchSettings,
): Promise<JobPosting[]> {
  const response = await fetch(`${API_BASE}/${company}/jobs?content=true`, {
    headers: { Accept: 'application/json' },
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`Greenhouse API error ${response.status} for ${company}`);
  }

  const data = (await response.json()) as GreenhouseResponse;
  const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

  return data.jobs
    .filter((job) => new Date(job.updated_at).getTime() >= cutoff)
    .map((job) => mapJob(job, company));
}

function mapJob(job: GreenhouseJob, company: string): JobPosting {
  const description = stripHtml(job.content ?? '');
  const text = `${job.title} ${description}`.toLowerCase();
  const publishedAt = new Date(job.updated_at);

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl: job.absolute_url,
    title: job.title,
    company: toCompanyName(company),
    companySummary: '',
    companySlug: company,
    locationLabel: job.location.name,
    countryCode: inferCountryCode(job.location.name),
    city: inferCity(job.location.name),
    workMode: inferWorkMode(text),
    language: inferLanguage(text),
    description,
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(text),
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: job.absolute_url,
    offersRelocation: containsAny(text, ['relocation', 'visa sponsorship', 'visa sponsor', 'relocation assistance']),
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function isRelevant(title: string, queryTerms: string[]): boolean {
  const t = title.toLowerCase();
  const backendTerms = ['backend', 'back-end', 'node', 'typescript', 'software engineer', 'fullstack', 'full stack', 'api', 'platform engineer'];
  return (
    queryTerms.some((q) => t.includes(q)) ||
    backendTerms.some((term) => t.includes(term))
  );
}

function inferLanguage(text: string): string {
  const frenchSignals = [
    'rejoignez', 'nous recherchons', 'vous serez', 'vos missions',
    'votre profil', 'profil recherché', 'expérience requise',
    'compétences', 'rémunération', 'télétravail', 'développeur', 'ingénieur',
  ];
  const germanSignals = [
    'wir suchen', 'ihre aufgaben', 'ihr profil', 'was wir bieten',
    'kenntnisse', 'erfahrung', 'entwickler', 'stellenbeschreibung',
  ];
  const englishSignals = [
    'we are looking', 'you will', 'requirements', 'responsibilities',
    'about us', 'what you', 'we offer', 'join our', 'must have',
    'nice to have', 'strong knowledge', 'experience with',
  ];

  const frCount = frenchSignals.filter((s) => text.includes(s)).length;
  const deCount = germanSignals.filter((s) => text.includes(s)).length;
  const enCount = englishSignals.filter((s) => text.includes(s)).length;

  if (frCount > enCount || deCount > enCount) return 'fr';
  return 'en';
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['full remote', 'fully remote', '100% remote', 'remote only', 'work from anywhere'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail partiel', 'partial remote'])) return 'hybrid';
  return 'on-site';
}

function inferCountryCode(location: string): string | null {
  const l = location.toLowerCase();
  if (l.includes('france') || l.includes('paris')) return 'FR';
  if (l.includes('germany') || l.includes('berlin') || l.includes('munich')) return 'DE';
  if (l.includes('uk') || l.includes('london') || l.includes('united kingdom')) return 'GB';
  if (l.includes('netherlands') || l.includes('amsterdam')) return 'NL';
  if (l.includes('remote') || l.includes('anywhere') || l.includes('worldwide')) return 'FR';
  return null;
}

function inferCity(location: string): string | null {
  const known = ['Paris', 'London', 'Berlin', 'Amsterdam', 'Barcelona', 'Madrid', 'Dublin', 'Zurich'];
  for (const city of known) {
    if (location.toLowerCase().includes(city.toLowerCase())) return city;
  }
  return null;
}

function extractExperienceMinimum(text: string): number | null {
  const plusMatch = text.match(/(\d+)\+\s*years?/i);
  if (plusMatch) return parseInt(plusMatch[1], 10) + 1;

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

function toCompanyName(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
