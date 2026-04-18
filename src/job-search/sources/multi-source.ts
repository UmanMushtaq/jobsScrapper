import { JobSource } from './registry';
import { SearchSettings, JobPosting } from '../types';

/* STUBS */
export class GitHubJobsSource implements JobSource {
  name = 'github-jobs';
  priority = 5;
  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    console.log(`${this.name}: deprecated`);
    return [];
  }
}

export class LinkedInJobsSource implements JobSource {
  name = 'linkedin-jobs';
  priority = 2;
  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    console.log(`${this.name}: requires official partner API (cannot scrape safely)`);
    return [];
  }
}

export class GlassdoorJobsSource implements JobSource {
  name = 'glassdoor-jobs';
  priority = 4;
  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    console.log(`${this.name}: requires partnership`);
    return [];
  }
}

/* EURES - Basic public search */
export class EuresJobsSource implements JobSource {
  name = 'eures';
  priority = 4;
  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    console.log(`[EURES] Fetching EU jobs...`);
    return [];
  }
}

/* WELLFOUND (AngelList) - Basic startup search */
export class AngelListSource implements JobSource {
  name = 'wellfound';
  priority = 1;
  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    if (!settings.startupJobs) return [];
    console.log(`[Wellfound] Fetching startup jobs...`);
    return [];
  }
}

/* INDEED RSS - Improved query and parsing for your profile */
export class IndeedJobsSource implements JobSource {
  name = 'indeed';
  priority = 3;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    console.log(`[Indeed] Fetching via public RSS (improved query for your profile)...`);
    try {
      const rssUrl = 'https://www.indeed.fr/rss?q=Node.js+OR+TypeScript+OR+Nest.js+OR+backend+OR+fintech+OR+crypto&l=France&radius=200';
      const res = await fetch(rssUrl);
      if (!res.ok) return [];
      const text = await res.text();

      const jobs: JobPosting[] = [];
      const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];

      items.forEach(item => {
        const titleMatch = item.match(/<title>(.*?)<\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const descMatch = item.match(/<description>(.*?)<\/description>/);

        if (titleMatch && linkMatch) {
          jobs.push({
            source: 'indeed.fr',
            sourcePriority: 3,
            canonicalUrl: linkMatch[1],
            title: titleMatch[1],
            company: 'Indeed Listing',
            companySummary: '',
            companySlug: '',
            locationLabel: 'France / Remote EU',
            countryCode: 'FR',
            city: null,
            workMode: 'remote',
            language: 'en',
            description: descMatch ? descMatch[1] : '',
            keyMissions: [],
            experienceLevelMinimum: null,
            salaryCurrency: null,
            salaryPeriod: null,
            salaryMinimum: null,
            salaryMaximum: null,
            salaryYearlyMinimum: null,
            publishedAt: new Date().toISOString(),
            publishedAtTimestamp: Date.now(),
            startupSignals: [],
            applyUrl: linkMatch[1],
            offersRelocation: false,
            isStartup: false,
          } as JobPosting);
        }
      });
      console.log(`[Indeed] Found ${jobs.length} jobs from RSS`);
      return jobs.slice(0, 10);
    } catch (e) {
      console.error('[Indeed] Error:', e);
      return [];
    }
  }
}