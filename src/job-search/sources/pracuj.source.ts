import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

export class PracujPlSource implements JobSource {
  name = 'pracuj.pl';
  priority = 4;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    console.log('[pracuj] disabled — no working endpoint (ScraperAPI returns 500, direct API 403)');
    return [];
  }
}
