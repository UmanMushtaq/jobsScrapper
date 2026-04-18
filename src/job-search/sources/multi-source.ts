import { JobSource } from './registry';
import { JobPosting, SearchSettings } from '../types';

function unavailable(source: string, reason: string): JobPosting[] {
  console.log(`[${source}] skipped: ${reason}`);
  return [];
}

export class GitHubJobsSource implements JobSource {
  name = 'github-jobs';
  priority = 7;

  async fetch(): Promise<JobPosting[]> {
    return unavailable(this.name, 'GitHub Jobs is no longer available');
  }
}

export class LinkedInJobsSource implements JobSource {
  name = 'linkedin.com';
  priority = 5;

  async fetch(): Promise<JobPosting[]> {
    return unavailable(this.name, 'LinkedIn does not provide a safe public scraping path here');
  }
}

export class GlassdoorJobsSource implements JobSource {
  name = 'glassdoor.com';
  priority = 6;

  async fetch(): Promise<JobPosting[]> {
    return unavailable(this.name, 'Glassdoor requires protected access');
  }
}

export class EuresJobsSource implements JobSource {
  name = 'europa.eu/eures';
  priority = 4;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    return unavailable(this.name, 'EURES public search is JS-driven and not yet implemented');
  }
}

export class AngelListSource implements JobSource {
  name = 'wellfound.com';
  priority = 1;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    if (!settings.startupJobs) {
      return [];
    }

    return unavailable(this.name, 'Wellfound blocks unattended server-side scraping');
  }
}

export class IndeedJobsSource implements JobSource {
  name = 'indeed.com';
  priority = 3;

  async fetch(): Promise<JobPosting[]> {
    return unavailable(this.name, 'Indeed is blocked by Cloudflare in this environment');
  }
}
