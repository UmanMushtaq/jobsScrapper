import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { detectLanguage } from './language-detect';
import { RELOCATION_KEYWORDS } from './shared-scraper';
import { RequiredLanguage } from '../language-requirement-filter';
import { extractRequiredMinimumYears } from '../experience-parser';
import { ENGLISH_KEYWORDS } from '../keywords';

const SOURCE = 'eures.europa.eu';
const API_URL = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const PORTAL_URL = 'https://europa.eu/eures/portal/jv-se/jv-details';

// Gap countries only — FR/DE/PL deliberately excluded, already have strong dedicated
// coverage elsewhere; EURES fills Luxembourg/Italy/Sweden/Belgium/Netherlands instead.
const LOCATION_CODES = ['lu', 'it', 'se', 'be', 'nl'];

// specificSearchCode: 'EVERYWHERE' is broken on this API — it silently ignores the
// keyword and returns every job in the location scope (verified: 21,355 records for one
// query, first hit a Swedish train mechanic). 'TITLE' works correctly (verified: 86
// records for "nodejs"). Do not switch this back to 'EVERYWHERE'.
// July 13 2026 keyword consolidation — full English set (TITLE-scope confirmation above
// was about the search mode working at all, not this exact list being required).
const SEARCH_QUERIES = ENGLISH_KEYWORDS;

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export interface EuresJv {
  id?: string;
  title?: string;
  description?: string;
  creationDate?: number;
  lastModificationDate?: number;
  numberOfPosts?: number;
  locationMap?: Record<string, string[]>;
  employer?: { name?: string };
  availableLanguages?: string[];
  // "Job requirements > Languages" — field name UNVERIFIED. This sandbox's outbound
  // network blocks europa.eu entirely (403 at the proxy CONNECT, same restriction that
  // blocked the base search/detail endpoints during initial development — see
  // eures.source.ts.blocked.md in git history), so the real shape of this field could
  // not be curl-verified here. extractRequiredLanguages() below defensively probes
  // several plausible shapes and returns [] if none match, so a wrong guess just means
  // "no structured signal" rather than a crash — the free-text requirement-phrase
  // heuristic (language-requirement-filter.ts) still catches explicit language
  // requirements from the description regardless. Re-verify from a machine with real
  // network access and tighten this to the confirmed field/shape.
  requiredLanguages?: unknown;
  jvRequirements?: { languages?: unknown; experience?: unknown };
  // "Job requirements > Experience" — field name equally UNVERIFIED, same network
  // restriction as requiredLanguages above. Probes a few plausible numeric shapes and
  // falls back to extractRequiredMinimumYears() on the description (verified-safe,
  // EN/FR/German-aware) when none match, so this degrades to "use the text parser"
  // rather than silently guessing wrong.
  requiredExperienceYears?: unknown;
  experienceYears?: unknown;
}

interface EuresResponse {
  numberRecords?: number;
  jvs?: EuresJv[];
}

export class EuresSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const seen = new Set<string>();
    const jobs: JobPosting[] = [];
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;
    const sessionId = `jobsscrapper-${Date.now()}`;

    for (const query of SEARCH_QUERIES) {
      try {
        const fetched = await fetchQuery(query, cutoff, sessionId);
        for (const job of fetched) {
          if (!seen.has(job.canonicalUrl)) {
            seen.add(job.canonicalUrl);
            jobs.push(job);
          }
        }
      } catch (err) {
        console.warn(`[eures] query "${query}" failed:`, err instanceof Error ? err.message.slice(0, 200) : err);
      }
      await sleep(1500);
    }

    console.log(`[eures] fetched ${jobs.length} unique jobs across ${SEARCH_QUERIES.length} queries`);
    return jobs;
  }
}

async function fetchQuery(query: string, cutoff: number, sessionId: string): Promise<JobPosting[]> {
  // Page 1 only for now — 86 records for the broadest query means one page of 50,
  // sorted MOST_RECENT, comfortably covers what a several-hours scheduler needs. Add
  // page 2 later if job volume in the gap countries grows enough to justify it.
  const body = {
    resultsPerPage: 50,
    page: 1,
    sortSearch: 'MOST_RECENT',
    keywords: [{ keyword: query, specificSearchCode: 'TITLE' }],
    publicationPeriod: null,
    occupationUris: [],
    skillUris: [],
    requiredExperienceCodes: [],
    positionScheduleCodes: [],
    sectorCodes: [],
    educationAndQualificationLevelCodes: [],
    positionOfferingCodes: [],
    locationCodes: LOCATION_CODES,
    euresFlagCodes: [],
    otherBenefitsCodes: [],
    requiredLanguages: [],
    minNumberPost: null,
    sessionId,
    requestLanguage: 'en',
  };

  const response = await axios.post<EuresResponse>(API_URL, body, {
    headers: HEADERS,
    timeout: 20_000,
    validateStatus: (s) => s < 500,
  });

  if (response.status !== 200 || !response.data?.jvs) {
    console.warn(`[eures] unexpected response ${response.status} for "${query}"`);
    return [];
  }

  const out: JobPosting[] = [];
  for (const raw of response.data.jvs) {
    const mapped = mapJob(raw, cutoff);
    if (mapped) out.push(mapped);
  }
  return out;
}

function normalizeLanguageEntry(entry: unknown): RequiredLanguage | null {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { code: entry.toLowerCase() };
  }
  if (typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const code = e.isoCode ?? e.code ?? e.languageCode ?? e.iso2Code ?? e.language;
  if (!code || typeof code !== 'string') return null;
  const level = e.level ?? e.languageLevel ?? e.proficiencyLevel;
  const type = e.type ?? e.requirementType;
  const required = typeof e.mandatory === 'boolean'
    ? e.mandatory
    : typeof e.required === 'boolean'
      ? e.required
      : typeof type === 'string'
        ? !/desirable|optional|asset|nice.to.have/i.test(type)
        : undefined;
  return {
    code: code.toLowerCase(),
    level: typeof level === 'string' ? level : undefined,
    required,
  };
}

function coerceYears(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

// See the `requiredExperienceYears`/`experienceYears` comment on EuresJv above —
// unverified structured field, defensive multi-shape probe. Falls back to text-parsing
// the description when no structured field resolves, so this always has a real signal
// regardless of whether the guessed field name is ever correct.
export function extractExperienceMinimum(raw: EuresJv, description: string): number | null {
  const anyRaw = raw as unknown as Record<string, unknown>;
  const structured =
    coerceYears(anyRaw.requiredExperienceYears) ??
    coerceYears(anyRaw.experienceYears) ??
    coerceYears((anyRaw.jvRequirements as Record<string, unknown> | undefined)?.experience);
  if (structured !== null) return structured;
  return extractRequiredMinimumYears(description);
}

// See the `requiredLanguages`/`jvRequirements` comment on EuresJv above — unverified
// field name, defensive multi-shape probe, degrades to [] rather than throwing.
export function extractRequiredLanguages(raw: EuresJv): RequiredLanguage[] {
  const candidates =
    raw.requiredLanguages ??
    raw.jvRequirements?.languages ??
    [];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map(normalizeLanguageEntry)
    .filter((l): l is RequiredLanguage => l !== null);
}

export function mapJob(raw: EuresJv, cutoff: number): JobPosting | null {
  if (!raw.id || !raw.title) return null;

  const publishedRaw = raw.lastModificationDate ?? raw.creationDate;
  const publishedAtTimestamp = publishedRaw ?? Date.now();
  if (publishedAtTimestamp < cutoff) return null;

  const countryCode = Object.keys(raw.locationMap ?? {})[0] ?? null;
  const locationLabel = countryCode ?? 'EU';

  const description = stripHtml((raw.description ?? '')).slice(0, 8000);
  const title = raw.title;
  const text = `${title} ${description}`.toLowerCase();
  const workMode: JobPosting['workMode'] =
    /remote|télétravail|homeoffice|home office/.test(text)
      ? /hybrid|hybride/.test(text) ? 'hybrid' : 'remote'
      : /hybrid|hybride/.test(text) ? 'hybrid' : 'on-site';

  const canonicalUrl = `${PORTAL_URL}/${encodeURIComponent(raw.id)}?lang=en`;
  const publishedAt = new Date(publishedAtTimestamp);
  const company = raw.employer?.name ?? 'Unknown';
  const language = raw.availableLanguages?.[0] ?? detectLanguage(`${title} ${description.slice(0, 400)}`);
  const requiredLanguages = extractRequiredLanguages(raw);
  const experienceLevelMinimum = extractExperienceMinimum(raw, description);

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title,
    company,
    companySummary: '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode,
    city: null,
    workMode,
    language,
    description,
    keyMissions: [],
    experienceLevelMinimum,
    salaryCurrency: null,
    salaryPeriod: null,
    salaryMinimum: null,
    salaryMaximum: null,
    salaryYearlyMinimum: null,
    publishedAt: publishedAt.toISOString(),
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: RELOCATION_KEYWORDS.some((k) => text.includes(k)),
    isStartup: false,
    employeeCount: null,
    companyCreationYear: null,
    requiredLanguages: requiredLanguages.length ? requiredLanguages : null,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
