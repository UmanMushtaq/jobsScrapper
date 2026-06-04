import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'jobs.lever.co';

// French and European startups/scale-ups using Lever ATS
// Slugs come from jobs.lever.co/{slug} — 404s are silently skipped
const DEFAULT_COMPANIES = [
  // French startups & scale-ups
  'qonto', 'alan', 'back-market', 'ledger', 'blablacar',
  'dataiku', 'livestorm', 'meilisearch', 'ankorstore', 'shine',
  'joko', 'finary', 'luko', 'october', 'lydia',
  'spendesk', 'pennylane', 'payfit', 'swile', 'aircall',
  'contentsquare', 'mirakl', 'doctrine', 'pigment', 'nabla',
  'labellereste', 'ecotree', 'payplug', 'indy', 'yousign',
  // European startups with Paris/remote presence
  'remote', 'pleo', 'personio', 'sumup', 'n26',
  'wise', 'revolut', 'monzo', 'tide', 'moonpay',
  'factorial', 'factorial-hr', 'hibob', 'chargebee', 'paddle',
  'contentful', 'personio', 'getdbt', 'linear', 'vercel',
];

interface LeverPosting {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  hostedUrl: string;
  applyUrl: string;
  description: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  categories: {
    commitment?: string;
    location?: string;
    team?: string;
    department?: string;
  };
  tags?: string[];
}

export class LeverJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const envCompanies = process.env.LEVER_COMPANIES;
    const companies = envCompanies
      ? envCompanies.split(',').map((c) => c.trim().toLowerCase())
      : DEFAULT_COMPANIES;

    const jobs = new Map<string, JobPosting>();
    const queryTerms = queries.map((q) => q.toLowerCase());
    let companiesWithJobs = 0;
    let totalFound = 0;

    for (const company of companies) {
      try {
        const results = await fetchCompanyJobs(company, settings);
        const relevant = results.filter((job) => isRelevant(job.title, queryTerms));
        if (relevant.length > 0) companiesWithJobs++;
        totalFound += relevant.length;
        for (const job of relevant) {
          jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('404') && !msg.includes('fetch failed')) {
          console.error(`[lever] error for "${company}": ${msg}`);
        }
      }
    }

    if (totalFound === 0) {
      console.log(`[lever] 0 relevant jobs across ${companies.length} companies within ${settings.maxAgeHours}h window`);
    } else {
      console.log(`[lever] ${totalFound} relevant jobs from ${companiesWithJobs}/${companies.length} companies`);
    }

    return Array.from(jobs.values());
  }
}

async function fetchCompanyJobs(company: string, settings: SearchSettings): Promise<JobPosting[]> {
  const response = await fetch(
    `https://api.lever.co/v0/postings/${company}?mode=json`,
    { headers: { Accept: 'application/json' } },
  );

  if (response.status === 404 || response.status === 400) return [];
  if (!response.ok) throw new Error(`Lever API ${response.status} for ${company}`);

  const data = (await response.json()) as LeverPosting[];
  if (!Array.isArray(data)) return [];

  const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

  return data
    .filter((p) => (p.updatedAt ?? p.createdAt) >= cutoff)
    .map((p) => mapPosting(p, company));
}

function mapPosting(posting: LeverPosting, company: string): JobPosting {
  const description = posting.descriptionPlain ?? stripHtml(posting.description ?? '');
  const additional = posting.additionalPlain ?? stripHtml(posting.additional ?? '');
  const fullText = `${posting.text} ${description} ${additional}`.toLowerCase();
  const locationRaw = posting.categories?.location ?? '';
  const companyName = toCompanyName(company);

  const publishedAt = new Date(posting.updatedAt ?? posting.createdAt);

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl: posting.hostedUrl,
    title: posting.text,
    company: companyName,
    companySummary: '',
    companySlug: company,
    locationLabel: locationRaw || 'Europe',
    countryCode: inferCountryCode(locationRaw),
    city: inferCity(locationRaw),
    workMode: inferWorkMode(fullText, locationRaw),
    language: detectLanguage(`${posting.text} ${description}`),
    description: `${description}\n\n${additional}`.trim(),
    keyMissions: [],
    experienceLevelMinimum: extractExperienceMinimum(fullText),
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [],
    applyUrl: posting.applyUrl,
    offersRelocation: containsAny(fullText, ['relocation', 'visa sponsorship', 'visa sponsor', 'relocation assistance']),
    isStartup: containsAny(fullText, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function isRelevant(title: string, queryTerms: string[]): boolean {
  const t = title.toLowerCase();
  const backendTerms = [
    'backend', 'back-end', 'node', 'typescript', 'software engineer',
    'fullstack', 'full stack', 'full-stack', 'api', 'platform engineer',
    'software developer', 'web developer',
  ];
  return (
    queryTerms.some((q) => t.includes(q)) ||
    backendTerms.some((term) => t.includes(term))
  );
}

function inferWorkMode(text: string, location: string): 'remote' | 'hybrid' | 'on-site' {
  const loc = location.toLowerCase();
  if (
    containsAny(text, ['fully remote', 'full remote', '100% remote', 'remote only', 'work from anywhere', 'remote-first', 'remote first']) ||
    loc.includes('remote') || loc.includes('anywhere')
  ) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail partiel', 'partial remote', 'remote friendly'])) return 'hybrid';
  return 'on-site';
}

function inferCountryCode(location: string): string | null {
  const l = location.toLowerCase();
  if (l.includes('france') || l.includes('paris')) return 'FR';
  if (l.includes('germany') || l.includes('berlin') || l.includes('munich')) return 'DE';
  if (l.includes('uk') || l.includes('london') || l.includes('united kingdom') || l.includes('england')) return 'GB';
  if (l.includes('netherlands') || l.includes('amsterdam')) return 'NL';
  if (l.includes('spain') || l.includes('madrid') || l.includes('barcelona')) return 'ES';
  if (l.includes('ireland') || l.includes('dublin')) return 'IE';
  if (l.includes('portugal') || l.includes('lisbon')) return 'PT';
  if (l.includes('remote') || l.includes('europe') || l.includes('eu') || l.includes('anywhere')) return 'FR';
  return null;
}

function inferCity(location: string): string | null {
  const known = ['Paris', 'London', 'Berlin', 'Amsterdam', 'Barcelona', 'Madrid', 'Dublin', 'Lisbon', 'Munich', 'Hamburg'];
  for (const city of known) {
    if (location.toLowerCase().includes(city.toLowerCase())) return city;
  }
  return null;
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

function toCompanyName(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
