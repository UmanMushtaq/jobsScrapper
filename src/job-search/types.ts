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
