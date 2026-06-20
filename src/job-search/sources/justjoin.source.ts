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
  slug?: string;
  title?: string;
  companyName?: string;
  company_name?: string;
  city?: string;
  countryCode?: string;
  country_code?: string;
  workplaceType?: string;
  workplace_type?: string; // 'remote' | 'hybrid' | 'office'
  categoryId?: string;
  marker_icon?: string;    // category: 'javascript' | 'node.js' | 'typescript' | etc.
  experienceLevel?: string;
  experience_level?: string; // 'junior' | 'mid' | 'senior'
  publishedAt?: string;
  published_at?: string;
  employmentTypes?: JjEmploymentType[];
  employment_types?: JjEmploymentType[];
  requiredSkills?: JjSkill[];
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

    const SEARCH_KEYWORDS = ['nodejs', 'typescript', 'nestjs'];

    for (const keyword of SEARCH_KEYWORDS) {
      try {
        const url = `https://api.justjoin.it/v2/user-panel/offers?keywords=${encodeURIComponent(keyword)}&page=1&pageSize=50`;
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

        if (response.status === 403 || response.status === 429 || response.status === 530) {
          console.log(`[justjoin] blocked ${response.status} — skipping`);
          continue;
        }
        if (!response.ok) {
          console.warn(`[justjoin] HTTP ${response.status} for keyword "${keyword}"`);
          continue;
        }

        const body = (await response.json()) as { data?: JjOffer[]; meta?: { total?: number } } | JjOffer[];
        const data: JjOffer[] = Array.isArray(body) ? body : (body as { data?: JjOffer[] }).data ?? [];

        if (!Array.isArray(data)) {
          console.warn('[justjoin] unexpected response shape');
          continue;
        }

        const relevant = data.filter((offer) => {
          const publishedAt = offer.publishedAt ?? offer.published_at;
          if (publishedAt && new Date(publishedAt).getTime() < cutoff) return false;
          return isRelevant(offer);
        });

        for (const offer of relevant) {
          const mapped = mapOffer(offer);
          if (mapped) jobs.set(mapped.canonicalUrl, mapped);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED')) {
          console.error(`[justjoin] error for "${keyword}": ${msg}`);
        }
      }
    }

    console.log(`[justjoin] ${jobs.size} jobs fetched`);
    return Array.from(jobs.values());
  }
}

function isRelevant(offer: JjOffer): boolean {
  const category = (offer.marker_icon ?? offer.categoryId ?? '').toLowerCase();
  if (RELEVANT_CATEGORIES.has(category)) return true;

  const skills = [...(offer.skills ?? []), ...(offer.requiredSkills ?? [])].map((s) => (s.name ?? '').toLowerCase());
  const title = (offer.title ?? '').toLowerCase();
  return RELEVANT_SKILL_TAGS.some((t) => skills.some((s) => s.includes(t)) || title.includes(t));
}

function mapOffer(offer: JjOffer): JobPosting | null {
  if (!offer.title) return null;
  const id = offer.slug ?? offer.id;
  if (!id) return null;

  const canonicalUrl = `https://justjoin.it/offers/${id}`;
  const company = offer.companyName ?? offer.company_name ?? 'Unknown';
  const city = offer.city ?? null;
  const countryCode = offer.countryCode ?? offer.country_code ?? 'PL';
  const locationLabel = city ? `${city}, Poland` : 'Poland';

  const workplaceType = (offer.workplaceType ?? offer.workplace_type ?? '').toLowerCase();
  const workMode: 'remote' | 'hybrid' | 'on-site' =
    workplaceType === 'remote' ? 'remote'
    : workplaceType === 'hybrid' ? 'hybrid'
    : 'on-site';

  // Pick the best salary from employment types (prefer b2b, then permanent)
  const types = offer.employmentTypes ?? offer.employment_types ?? [];
  const b2b = types.find((t) => t.type === 'b2b' && t.salary?.from);
  const permanent = types.find((t) => t.type === 'permanent' && t.salary?.from);
  const best = b2b ?? permanent ?? types.find((t) => t.salary?.from);
  const salaryMin = best?.salary?.from ?? null;
  const salaryMax = best?.salary?.to ?? null;
  const salaryCurrency = best?.salary?.currency ?? null;
  const salaryYearlyMinimum = salaryMin !== null && salaryCurrency === 'PLN' ? salaryMin * 12 : salaryMin;

  const skills = [...(offer.skills ?? []), ...(offer.requiredSkills ?? [])].map((s) => s.name ?? '').join(', ');
  const fullText = `${offer.title} ${skills}`.toLowerCase();

  const publishedAtRaw = offer.publishedAt ?? offer.published_at;
  const publishedAt = publishedAtRaw ? new Date(publishedAtRaw) : new Date();
  const publishedAtTimestamp = Math.floor(publishedAt.getTime() / 1000);

  const experienceLevel = offer.experienceLevel ?? offer.experience_level;

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
    experienceLevelMinimum: mapLevel(experienceLevel),
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
