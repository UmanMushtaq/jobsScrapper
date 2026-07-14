import axios from 'axios';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { detectLanguage } from './language-detect';
import { RELOCATION_KEYWORDS } from './shared-scraper';
import { RequiredLanguage } from '../language-requirement-filter';
import { extractRequiredMinimumYears } from '../experience-parser';
import { ENGLISH_KEYWORDS, FRENCH_KEYWORDS, GERMAN_KEYWORDS } from '../keywords';

const SOURCE = 'eures.europa.eu';
const API_URL = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const PORTAL_URL = 'https://europa.eu/eures/portal/jv-se/jv-details';

// EURES's own JD text must not be stored/displayed beyond a short excerpt — the public
// portal's terms prohibit republishing vacancy data, and this integration calls the
// frontend's own JSON API rather than scraping rendered HTML, so staying well inside an
// "aggregate + link back" footprint matters here specifically (unlike France
// Travail/APEC, which have partner-style terms that allow more). 500 chars matches the
// excerpt cap already used for applied/dismissed calibration elsewhere in the codebase
// (buildHistoryDescExcerpt in ai-enrichment.ts) — same judgment call, kept as a small
// local constant rather than importing that function directly: ai-enrichment.ts is a
// much heavier module (Gemini SDK, Postgres, Redis) and sources/ files are meant to stay
// leaf-level, so re-importing it here would be a backwards dependency for a one-line cap.
const EURES_DESC_EXCERPT_LENGTH = 500;

// July 14 2026 rebuild: previously scoped to "gap countries only" (lu/it/se/be/nl,
// deliberately excluding fr/de/pl because those already have strong dedicated coverage
// elsewhere). Expanded to the full target-country list per Uman's explicit instruction —
// cross-source overlap with France Travail/Arbeitsagentur/etc. is fine, since run.ts's
// cross-source dedup (by normalized company + title) already collapses same-job repeats
// from multiple sources.
//
// ISO-2 code (as stored in profile.search.targetCountryCodes, uppercase) → EURES's own
// lowercase locationCodes value. Covers Uman's actual target list plus Greece: a July 13
// 2026 session flagged that profile.search.targetCountryCodes currently has FI where
// Uman's real target-country rulebook says GR (see that session's Gemini hard-skip
// rulebook report) — an existing, already-flagged discrepancy this file doesn't silently
// resolve either way. Both FI and GR are mapped correctly here regardless of which one
// ends up being correct in the profile.
const EURES_LOCATION_CODES: Record<string, string> = {
  FR: 'fr', DE: 'de', BE: 'be', NL: 'nl', LU: 'lu', IT: 'it', ES: 'es',
  SE: 'se', DK: 'dk', CZ: 'cz', IE: 'ie', HU: 'hu', PL: 'pl', FI: 'fi', GR: 'gr',
};

// specificSearchCode: 'EVERYWHERE' is broken on this API — verified July 7 2026, it
// silently ignores the keyword and returns every job in the location scope (21,355
// records for one query, first hit a Swedish train mechanic). 'TITLE' is the confirmed
// working mode (86 records for "nodejs"). Do not switch this back to 'EVERYWHERE' without
// re-verifying from a machine with real network access to the live API.
const SEARCH_SCOPE = 'TITLE';

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

// Maps a target-list country code (e.g. "FR", as stored uppercase in
// profile.search.targetCountryCodes) to EURES's own lowercase locationCodes value.
// Returns null (and logs a warning) for a code with no known EURES mapping, so an
// unrecognised or future country added to the target list is skipped safely instead of
// sending an invalid locationCodes value or throwing.
export function mapToEuresLocationCode(countryCode: string): string | null {
  const code = EURES_LOCATION_CODES[countryCode.trim().toUpperCase()];
  if (!code) {
    console.warn(`[eures] no EURES locationCode mapping for country "${countryCode}" — skipping`);
    return null;
  }
  return code;
}

// Dual-language query pattern already used for Arbeitsagentur/France Travail: English
// keywords everywhere (EURES's requestLanguage:"en" searches English terms regardless of
// the target country), plus the localized set for France/Germany specifically.
function buildQueriesForCountry(countryCode: string): string[] {
  const queries = [...ENGLISH_KEYWORDS];
  if (countryCode === 'FR') queries.push(...FRENCH_KEYWORDS);
  if (countryCode === 'DE') queries.push(...GERMAN_KEYWORDS);
  return queries;
}

export class EuresSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const targetCountries = settings.targetCountryCodes ?? [];
    if (targetCountries.length === 0) {
      console.warn('[eures] no targetCountryCodes configured on this profile — skipping EURES entirely');
      return [];
    }

    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;
    const sessionId = `jobsscrapper-${Date.now()}`;
    // Dedup by EURES job ID (encoded in canonicalUrl) across every country/keyword
    // query in this run — the same job routinely turns up across several keyword
    // variants within one country.
    const seen = new Set<string>();
    const allJobs: JobPosting[] = [];

    for (const countryCode of targetCountries) {
      const locationCode = mapToEuresLocationCode(countryCode);
      if (!locationCode) continue;

      const queriesForCountry = buildQueriesForCountry(countryCode);
      let fetchedRaw = 0;
      let passedForCountry = 0;

      for (const query of queriesForCountry) {
        try {
          const results = await fetchQuery(query, locationCode, cutoff, sessionId);
          fetchedRaw += results.length;
          for (const job of results) {
            if (!seen.has(job.canonicalUrl)) {
              seen.add(job.canonicalUrl);
              allJobs.push(job);
              passedForCountry++;
            }
          }
        } catch (err) {
          console.warn(`[eures] country=${countryCode} query "${query}" failed:`, err instanceof Error ? err.message.slice(0, 200) : err);
        }
        await sleep(1500);
      }

      // One line per country per run (not one aggregate line) so a single
      // underperforming country is visible without re-running the whole source.
      console.log(`[eures] country=${countryCode} fetched=${fetchedRaw} passed_filters=${passedForCountry}`);
    }

    console.log(`[eures] ${allJobs.length} unique jobs across ${targetCountries.length} countries`);
    return allJobs;
  }
}

async function fetchQuery(query: string, locationCode: string, cutoff: number, sessionId: string): Promise<JobPosting[]> {
  // Page 1 only for now — 86 records for the broadest query means one page of 50,
  // sorted MOST_RECENT, comfortably covers what a several-hours scheduler needs. Add
  // page 2 later if job volume grows enough to justify it.
  const body = {
    resultsPerPage: 50,
    page: 1,
    sortSearch: 'MOST_RECENT',
    keywords: [{ keyword: query, specificSearchCode: SEARCH_SCOPE }],
    publicationPeriod: null,
    occupationUris: [],
    skillUris: [],
    requiredExperienceCodes: [],
    positionScheduleCodes: [],
    sectorCodes: [],
    educationAndQualificationLevelCodes: [],
    positionOfferingCodes: [],
    locationCodes: [locationCode],
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
    console.warn(`[eures] unexpected response ${response.status} for locationCode=${locationCode} "${query}"`);
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

  // Full JD text is never stored beyond this excerpt — see EURES_DESC_EXCERPT_LENGTH
  // comment above for why (ToS: no republishing vacancy data beyond aggregate + link
  // back). descriptionPartial=true always, since this cap is a deliberate compliance
  // choice rather than the API only ever giving us a short snippet (same field, same
  // "don't trust this as the full JD" signal already used by Adzuna/Jooble/Bundesagentur
  // for their own partial-description cases).
  const description = stripHtml((raw.description ?? '')).slice(0, EURES_DESC_EXCERPT_LENGTH);
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
    descriptionPartial: true,
  };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
