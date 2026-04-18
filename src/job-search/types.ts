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
}

export interface MatchResult {
  job: JobPosting;
  score: number;
  reasons: string[];
  startupScore: number;
  salaryLabel: string;
  coverLetter: string;
  shortAnswers: string[];
}

