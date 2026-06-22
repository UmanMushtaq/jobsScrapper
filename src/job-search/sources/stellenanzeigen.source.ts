import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';

export class StellenanzeigenSource implements JobSource {
  name = 'stellenanzeigen.de';
  priority = 4;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    console.log('[stellenanzeigen] disabled — no working endpoint (ScraperAPI returns 500, ajax/RSS both 403)');
    return [];
  }
}
