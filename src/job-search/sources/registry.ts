import { JobPosting, SearchSettings } from '../types';

export interface JobSource {
  name: string;
  priority: number;
  fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]>;
}

export class JobSourceRegistry {
  private sources: Map<string, JobSource> = new Map();

  register(source: JobSource): void {
    this.sources.set(source.name, source);
  }

  async fetchFromAll(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const allJobs: JobPosting[] = [];

    // Sort sources by priority
    const sortedSources = Array.from(this.sources.values()).sort(
      (a, b) => a.priority - b.priority,
    );

    for (const source of sortedSources) {
      console.log(`Fetching from ${source.name}...`);
      try {
        const jobs = await source.fetch(queries, settings);
        allJobs.push(...jobs);
        console.log(`  Found ${jobs.length} jobs from ${source.name}`);
      } catch (error) {
        console.error(`  Error fetching from ${source.name}:`, error);
      }
    }

    // Deduplicate by canonical URL
    const seen = new Set<string>();
    const uniqueJobs: JobPosting[] = [];
    for (const job of allJobs) {
      if (!seen.has(job.canonicalUrl)) {
        seen.add(job.canonicalUrl);
        uniqueJobs.push(job);
      }
    }

    return uniqueJobs;
  }
}
