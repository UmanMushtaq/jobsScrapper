import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'justjoin.it';

interface JjSalary {
  from?: number;
  to?: number;
  currency?: string;
}

interface JjEmploymentType {
  type?: string; // 'b2b' | 'permanent' | 'mandate_contract'
  salary?: JjSalary | null;
}

interface JjSkill {
  name?: string;
  level?: number;
}

interface JjOffer {
  id?: string;
  title?: string;
  company_name?: string;
  city?: string;
  country_code?: string;
  workplace_type?: string; // 'remote' | 'hybrid' | 'office'
  marker_icon?: string;    // category: 'javascript' | 'node.js' | 'typescript' | etc.
  experience_level?: string; // 'junior' | 'mid' | 'senior'
  published_at?: string;
  employment_types?: JjEmploymentType[];
  skills?: JjSkill[];
  remote_interview?: boolean;
  open_to_hire_ukrainians?: boolean;
}

const RELEVANT_CATEGORIES = new Set(['javascript', 'node.js', 'typescript', 'backend', 'devops']);
const RELEVANT_SKILL_TAGS = ['node', 'node.js', 'nodejs', 'nestjs', 'typescript', 'javascript', 'backend', 'express', 'postgresql', 'postgres'];

export class JustJoinSource implements JobSource {
  name = SOURCE;
  priority = 5;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

    try {
      const response = await fetch('https://justjoin.it/api/offers', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (response.status === 403 || response.status === 429 || response.status === 530) {
        console.log(`[justjoin] blocked ${response.status} — skipping`);
        return [];
      }
      if (!response.ok) {
        console.warn(`[justjoin] HTTP ${response.status}`);
        return [];
      }

      const data = (await response.json()) as JjOffer[];
      if (!Array.isArray(data)) {
        console.warn('[justjoin] unexpected response shape');
        return [];
      }

      const relevant = data.filter((offer) => {
        if (offer.published_at && new Date(offer.published_at).getTime() < cutoff) return false;
        return isRelevant(offer);
      });

      for (const offer of relevant) {
        const mapped = mapOffer(offer);
        if (mapped) jobs.set(mapped.canonicalUrl, mapped);
      }

      if (jobs.size === 0) {
        console.log('[justjoin] 0 relevant jobs found');
      } else {
        console.log(`[justjoin] ${jobs.size} relevant jobs from ${data.length} total`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED')) {
        console.error(`[justjoin] error: ${msg}`);
      }
    }

    return Array.from(jobs.values());
  }
}

function isRelevant(offer: JjOffer): boolean {
  const category = (offer.marker_icon ?? '').toLowerCase();
  if (RELEVANT_CATEGORIES.has(category)) return true;

  const skills = (offer.skills ?? []).map((s) => (s.name ?? '').toLowerCase());
  const title = (offer.title ?? '').toLowerCase();
  return RELEVANT_SKILL_TAGS.some((t) => skills.some((s) => s.includes(t)) || title.includes(t));
}

function mapOffer(offer: JjOffer): JobPosting | null {
  if (!offer.title || !offer.id) return null;

  const canonicalUrl = `https://justjoin.it/offers/${offer.id}`;
  const company = offer.company_name ?? 'Unknown';
  const city = offer.city ?? null;
  const countryCode = offer.country_code ?? 'PL';
  const locationLabel = city ? `${city}, Poland` : 'Poland';

  const workplaceType = (offer.workplace_type ?? '').toLowerCase();
  const workMode: 'remote' | 'hybrid' | 'on-site' =
    workplaceType === 'remote' ? 'remote'
    : workplaceType === 'hybrid' ? 'hybrid'
    : 'on-site';

  // Pick the best salary from employment types (prefer b2b, then permanent)
  const types = offer.employment_types ?? [];
  const b2b = types.find((t) => t.type === 'b2b' && t.salary?.from);
  const permanent = types.find((t) => t.type === 'permanent' && t.salary?.from);
  const best = b2b ?? permanent ?? types.find((t) => t.salary?.from);
  const salaryMin = best?.salary?.from ?? null;
  const salaryMax = best?.salary?.to ?? null;
  const salaryCurrency = best?.salary?.currency ?? null;
  const salaryYearlyMinimum = salaryMin !== null && salaryCurrency === 'PLN' ? salaryMin * 12 : salaryMin;

  const skills = (offer.skills ?? []).map((s) => s.name ?? '').join(', ');
  const fullText = `${offer.title} ${skills}`.toLowerCase();

  const publishedAt = offer.published_at ? new Date(offer.published_at) : new Date();
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);

  return {
    source: SOURCE,
    sourcePriority: 5,
    canonicalUrl,
    title: offer.title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode,
    city,
    workMode,
    language: detectLanguage(fullText),
    description: skills,
    keyMissions: [],
    experienceLevelMinimum: mapLevel(offer.experience_level),
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
    isStartup: false,
    employeeCount: null,
    companyCreationYear: null,
  };
}

function mapLevel(level: string | undefined): number | null {
  switch (level) {
    case 'junior': return 1;
    case 'mid': return 3;
    case 'senior': return 5;
    default: return null;
  }
}
