import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SearchProfile } from './types';

export async function loadSearchProfile(): Promise<SearchProfile> {
  const profilePath = join(process.cwd(), 'job_search_profile.json');
  const profileContent = await readFile(profilePath, 'utf-8');
  return JSON.parse(profileContent) as SearchProfile;
}

