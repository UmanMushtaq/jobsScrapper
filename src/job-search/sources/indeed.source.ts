import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

const SOURCE = 'indeed.com';

export class IndeedJobsSource implements JobSource {
  name = SOURCE;
  priority = 8;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    console.log('[indeed] disabled until ScraperAPI plan renews');
    return [];
  }
}
