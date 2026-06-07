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
}

export interface SearchSettings {
  titles: string[];
  queries: string[];
  requiredKeywords: string[];
  preferredKeywordGroups: string[][];
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
}

export interface ScoreBreakdown {
  mandatory: number;
  keywords: number;
  location: number;
  startup: number;
  sponsor?: number;
  // Adjustment learned from your Applied/Dismissed history (can be negative).
  preference?: number;
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

export interface JobSearchState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastRunStatus: 'idle' | 'running' | 'success' | 'error';
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
}
