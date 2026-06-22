import axios from 'axios';
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
  type?: string;
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
  workplace_type?: string;
  categoryId?: string;
  marker_icon?: string;
  experienceLevel?: string;
  experience_level?: string;
  publishedAt?: string;
  published_at?: string;
  employmentTypes?: JjEmploymentType[];
  employment_types?: JjEmploymentType[];
  requiredSkills?: JjSkill[];
  skills?: JjSkill[];
}

const RELEVANT_CATEGORIES = new Set(['javascript', 'node.js', 'typescript', 'backend', 'devops']);
const RELEVANT_SKILL_TAGS = ['node', 'node.js', 'nodejs', 'nestjs', 'typescript', 'javascript', 'backend', 'express'];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

export class JustJoinSource implements JobSource {
  name = SOURCE;
  priority = 5;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - settings.maxAgeHours * 60 * 60 * 1000;

    const SEARCH_KEYWORDS = ['nodejs', 'typescript', 'nestjs'];

    for (const keyword of SEARCH_KEYWORDS) {
      try {
        const fetched = await fetchKeyword(keyword, cutoff);
        for (const job of fetched) jobs.set(job.canonicalUrl, job);
        await sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
          console.error(`[justjoin] error for "${keyword}": ${msg}`);
        }
      }
    }

    console.log(`[justjoin] ${jobs.size} jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchKeyword(keyword: string, cutoff: number): Promise<JobPosting[]> {
  const url = `https://justjoin.it/job-offers/${encodeURIComponent(keyword)}`;

  let res;
  try {
    res = await axios.get<string>(url, {
      headers: BROWSER_HEADERS,
      timeout: 30_000,
      responseType: 'text',
      validateStatus: (s) => s < 500,
    });
  } catch {
    return [];
  }

  if (res.status !== 200) {
    console.log(`[justjoin] HTML fetch returned ${res.status} for "${keyword}"`);
    return [];
  }

  const jobs = parseHtmlOffers(res.data, cutoff);
  if (jobs.length > 0) {
    console.log(`[justjoin] parsed ${jobs.length} offers for "${keyword}"`);
  }
  return jobs;
}

function parseHtmlOffers(html: string, cutoff: number): JobPosting[] {
  const jobs: JobPosting[] = [];

  // Try JSON-LD first
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') {
          const dateStr = item.datePosted;
          if (dateStr && new Date(dateStr).getTime() < cutoff) continue;
          const canonicalUrl = item.url ?? item.mainEntityOfPage?.['@id'];
          if (!canonicalUrl || !item.title) continue;
          const company = item.hiringOrganization?.name ?? 'Unknown';
          const locationStr = item.jobLocation?.address?.addressLocality ?? '';
          jobs.push(makeJobPosting({
            title: item.title,
            canonicalUrl,
            company,
            locationStr,
            description: item.description ?? '',
            dateStr,
            workplaceType: '',
          }));
        }
      }
    } catch { /* continue */ }
  }
  if (jobs.length > 0) return jobs;

  // Try embedded __NEXT_DATA__
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const offers: unknown[] =
        nextData?.props?.pageProps?.offers ??
        nextData?.props?.pageProps?.jobs ??
        nextData?.props?.pageProps?.data?.offers ??
        [];
      if (Array.isArray(offers) && offers.length > 0) {
        return offers
          .map((o) => mapOffer(o as JjOffer))
          .filter((j): j is JobPosting => j !== null)
          .filter((j) => new Date(j.publishedAt).getTime() >= cutoff);
      }
    } catch { /* fall through */ }
  }

  // HTML card fallback — look for data-index attributes or job-specific anchors
  const cardPattern = /<(?:article|div|li)[^>]*data-index=["']?\d+["']?[^>]*>([\s\S]*?)(?=<(?:article|div|li)[^>]*data-index|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = cardPattern.exec(html)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<h[1-4][^>]*>([^<]{5,120})<\/h[1-4]>/i);
    const linkMatch = block.match(/href="(\/job-offer[^"]+|\/offers\/[^"]+)"/i);
    const title = titleMatch?.[1].trim();
    const rawUrl = linkMatch?.[1];
    if (title && rawUrl) {
      const canonicalUrl = rawUrl.startsWith('http') ? rawUrl : `https://justjoin.it${rawUrl}`;
      jobs.push(makeJobPosting({ title, canonicalUrl, company: 'Unknown', locationStr: 'Poland', description: '', dateStr: undefined, workplaceType: '' }));
    }
  }

  return jobs;
}

function makeJobPosting(p: { title: string; canonicalUrl: string; company: string; locationStr: string; description: string; dateStr?: string; workplaceType: string }): JobPosting {
  const publishedAt = p.dateStr ? new Date(p.dateStr) : new Date();
  const locationLabel = p.locationStr ? `${p.locationStr}, Poland` : 'Poland';
  const text = `${p.title} ${p.description}`.toLowerCase();
  return {
    source: SOURCE, sourcePriority: 5,
    canonicalUrl: p.canonicalUrl,
    title: p.title, company: p.company, companySummary: '',
    companySlug: p.company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel, countryCode: 'PL', city: p.locationStr || null,
    workMode: p.workplaceType === 'remote' ? 'remote' : p.workplaceType === 'hybrid' ? 'hybrid' : 'on-site',
    language: detectLanguage(p.title),
    description: p.description, keyMissions: [], experienceLevelMinimum: null,
    salaryCurrency: null, salaryPeriod: null, salaryMinimum: null,
    salaryMaximum: null, salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp: Math.floor(publishedAt.getTime() / 1000),
    startupSignals: [], applyUrl: p.canonicalUrl,
    offersRelocation: text.includes('relocation') || text.includes('visa sponsor'),
    isStartup: text.includes('startup') || text.includes('seed'),
    employeeCount: null, companyCreationYear: null,
  };
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
  const locationLabel = city ? `${city}, Poland` : 'Poland';

  const workplaceType = (offer.workplaceType ?? offer.workplace_type ?? '').toLowerCase();
  const workMode: 'remote' | 'hybrid' | 'on-site' =
    workplaceType === 'remote' ? 'remote' : workplaceType === 'hybrid' ? 'hybrid' : 'on-site';

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
    source: SOURCE, sourcePriority: 5,
    canonicalUrl,
    title: offer.title, company, companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel, countryCode: offer.countryCode ?? offer.country_code ?? 'PL', city,
    workMode,
    language: detectLanguage(fullText),
    description: skills, keyMissions: [],
    experienceLevelMinimum: mapLevel(experienceLevel),
    salaryCurrency, salaryPeriod: salaryMin !== null ? 'monthly' : null,
    salaryMinimum: salaryMin, salaryMaximum: salaryMax, salaryYearlyMinimum,
    publishedAt: publishedAt.toISOString(), publishedAtTimestamp,
    startupSignals: [], applyUrl: canonicalUrl,
    offersRelocation: false, isStartup: false,
    employeeCount: null, companyCreationYear: null,
  };
}

// kept for __NEXT_DATA__ path — eslint disable to suppress unused warning
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _isRelevant = isRelevant;

function mapLevel(level: string | undefined): number | null {
  switch (level) {
    case 'junior': return 1;
    case 'mid': return 3;
    case 'senior': return 5;
    default: return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
