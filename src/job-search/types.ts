export interface SearchProfile {
  candidate: CandidateProfile;
  search: SearchSettings;
}

export interface CandidateProfile {
  name: string;
  location: string;
  summary: string;
  coreSkills: string[];
  experienceYears: number;
  cvText?: string;
  // Your work-authorization details. Edit these in job_search_profile.json
  // whenever your permit/card changes (new name, new expiry). The values
  // flow automatically into every cover letter, email, and Gemini query.
  workAuthorization?: WorkAuthorization;
}

export interface WorkAuthorization {
  permitName: string;     // e.g. "RECE permit", "Talent permit", "EU Blue Card"
  country: string;        // e.g. "France"
  countryCode?: string;   // e.g. "FR"
  expiry: string;         // free text, e.g. "October 2026"
  // Optional. The exact sentence appended to cover letters and emails.
  // If omitted, it is built automatically from the fields above.
  statusLine?: string;
  // Optional. Extra context fed to Gemini so it judges visa fit correctly.
  // If omitted, it is built automatically from the fields above.
  visaContext?: string;
}

export interface SearchSettings {
  titles: string[];
  queries: string[];
  requiredKeywords: string[];
  preferredKeywordGroups: string[][];
  // JSON can't hold comments, so the rule lives here: jobs stating a MINIMUM experience
  // requirement of MORE than `max` are rejected outright — enforced in matcher.ts as
  // `effectiveExperience > profile.search.experience.max` (structured field) and
  // detectExperiencePenalty()'s `minYears > maxYears` (free-text, EN/FR/DE via
  // experience-parser.ts). A requirement of exactly `max`, or phrased as the lower bound
  // of an open-ended/ranged requirement (e.g. "5+ years", "5-10 years"), is NOT rejected.
  // Current value: max 5 — Uman has 4 years and is a reasonable stretch candidate at the
  // 5-year floor, but 6+ is a hard skip regardless of stack fit or other scoring.
  experience: {
    min: number;
    max: number;
  };
  minimumSalaryMonthlyEur: number;
  language: string;
  maxResults: number;
  maxAgeHours: number;
  checkIntervalHours: number;
  seenTtlHours?: number;
  willingToRelocate: boolean;
  preferredCountries: string[];
  acceptRemote: boolean;
  acceptHybrid: boolean;
  acceptOnSite: boolean;
  usaJobs: boolean;
  startupJobs: boolean;
  startupPrioritySources: string[];
  excludedCountries: string[];
  europeCountryCodes: string[];
  usaCountryCodes: string[];
  relocationKeywords: string[];
  excludedTitleKeywords: string[];
  // 3-tier scoring boost by country (never a filter — does not bypass the language
  // filter the way preferredCountries does). tier1 > tier2 > tier3 in boost size.
  countryTiers?: { tier1: string[]; tier2: string[]; tier3: string[] };
  // Explicit target-country allowlist for onsite/hybrid roles (location-filter.ts's
  // scoreLocationCore). Unlike countryTiers this IS a filter — deliberately kept as its
  // own field so it never entangles with the tier boost's "never a filter" invariant.
  targetCountryCodes?: string[];
}

export interface JobPosting {
  source: string;
  sourcePriority: number;
  canonicalUrl: string;
  title: string;
  company: string;
  companySummary: string;
  companySlug: string;
  locationLabel: string;
  countryCode: string | null;
  city: string | null;
  workMode: 'remote' | 'hybrid' | 'on-site';
  language: string | null;
  description: string;
  keyMissions: string[];
  experienceLevelMinimum: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryMinimum: number | null;
  salaryMaximum: number | null;
  salaryYearlyMinimum: number | null;
  publishedAt: string;
  publishedAtTimestamp: number;
  startupSignals: string[];
  applyUrl: string;
  offersRelocation: boolean;
  isStartup: boolean;
  employeeCount?: number | null;
  companyCreationYear?: number | null;
  commentId?: string | null;
  // Structured "Job requirements > Languages" data, when the source exposes it (currently
  // EURES only). Consumed by language-requirement-filter.ts alongside the free-text
  // requirement-phrase heuristic, which applies to every source's description.
  requiredLanguages?: { code: string; level?: string; required?: boolean }[] | null;
  // True when `description` is a short snippet (Adzuna/Jooble truncation, or a
  // Bundesagentur detail-fetch that 404'd) rather than the full JD — the language filter
  // and Gemini scorer both need full text, so a job flagged here got scored on
  // incomplete information and is worth a manual second look, not an automatic pass.
  descriptionPartial?: boolean;
}

export interface ScoreBreakdown {
  mandatory: number;
  keywords: number;
  location: number;
  startup: number;
  sponsor?: number;
  tier2?: number;
  fintech?: number;
  preference?: number;
  expPenalty?: number;
  tier1Penalty?: number;
}

export interface MatchResult {
  job: JobPosting;
  score: number;
  scoreBreakdown?: ScoreBreakdown;
  reasons: string[];
  startupScore: number;
  salaryLabel: string;
  coverLetter: string;
  shortAnswers: string[];
  fraudScore?: number;
  fraudReasons?: string[];
  suggestedSalary?: string;
  companyQualityScore?: number;
  companyRedFlags?: string[];
  relevanceScore?: number;
  visaFriendly?: boolean | null;
  visaNote?: string | null;
  visaRisk?: string | null;
  atsMissingKeywords?: string[];
  atsPlacementSuggestions?: string[];
  relevanceIssues?: string[];
  hiringEmail?: string | null;
  emailSubject?: string | null;
  emailBody?: string | null;
  languageRequirementNote?: string | null;
}

export interface RunSummary {
  reportPath: string;
  allJobsCount: number;
  freshJobsCount: number;
  matchCount: number;
  matches: MatchResult[];
  blockedSources: string[];
  activeSources: string[];
  ranAt: string;
}

// Per-source health, recorded every run so platform failures (proxy offline,
// crashes, blocks, empty results) can be tracked and fixed later.
export type SourceHealthStatus =
  | 'ok'           // returned jobs normally
  | 'empty'        // ran without error but returned 0 jobs (not necessarily a problem)
  | 'blocked'      // looks IP-blocked (403/429/captcha) — likely needs the proxy
  | 'proxy_offline'// the home proxy tunnel is down (503/523 from proxy)
  | 'error';       // threw an exception / crashed during fetch

export interface SourceHealthRecord {
  source: string;
  status: SourceHealthStatus;
  jobsFound: number;
  durationMs: number;
  error: string | null;
  usesProxy: boolean;
  lastCheckedAt: string;     // ISO — last time this source ran
  lastSuccessAt: string | null; // ISO — last time it returned jobs
  consecutiveFailures: number;
}

export interface ProxyHealth {
  configured: boolean;       // JOB_PROXY_URL + JOB_PROXY_SECRET both set
  online: boolean;           // proxy responded to the last ping
  url: string | null;        // masked proxy host for display
  error: string | null;
  checkedAt: string;
}

export interface PlatformHealth {
  sources: SourceHealthRecord[];
  proxy: ProxyHealth;
  updatedAt: string;
}

export interface ScorerDiagnostic {
  freshJobs: number;
  matched: number;
  filtered: {
    lang: number;
    titleExcl: number;
    roleExcl: number;
    location: number;
    exp: number;
    salary: number;
    mandatory: number;
    score: number;
    frontendPrimary: number;
    languageRequirement: number;
  };
  locationBreak: { usaRemote: number; euOnsite: number; euHybrid: number; other: number };
  geminiRejected: number;
  deadUrls: number;
  sent: number;
}

export interface JobSearchState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: 'idle' | 'running' | 'success' | 'error' | 'gemini_waiting';
  lastError: string | null;
  latestMatches: MatchResult[];
  reportPath: string | null;
  blockedSources: string[];
  activeSources: string[];
  stats: {
    allJobsCount: number;
    freshJobsCount: number;
    matchCount: number;
  };
  intervalMinutes: number;
  seenTtlHours: number;
  nextRunAt: string | null;
  lastRunDiagnostic?: ScorerDiagnostic | null;
  // Non-null while the run is paused waiting for Gemini to recover from 503 high-demand.
  geminiRetry?: { count: number; max: number; nextAt: string } | null;
}
