import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SearchProfile } from './types';

export async function loadSearchProfile(): Promise<SearchProfile> {
  const profilePath = join(process.cwd(), 'job_search_profile.json');
  const profileContent = await readFile(profilePath, 'utf-8');
  return JSON.parse(profileContent) as SearchProfile;
}

export interface ResolvedWorkAuth {
  permitName: string;
  country: string;
  countryCode: string;
  expiry: string;
  statusLine: string;
  visaContext: string;
}

// Single source of truth for the candidate's work-authorization wording.
// Reads candidate.workAuthorization from the profile and fills in sensible
// defaults so cover letters, emails, and Gemini prompts all stay in sync.
// Update job_search_profile.json when the permit/card changes; everything else
// follows automatically.
export function resolveWorkAuth(profile: SearchProfile): ResolvedWorkAuth {
  const wa = profile.candidate.workAuthorization;
  const permitName = wa?.permitName?.trim() || 'work permit';
  const country = wa?.country?.trim() || 'France';
  const countryCode = wa?.countryCode?.trim() || 'FR';
  const expiry = wa?.expiry?.trim() || '';

  const statusLine =
    wa?.statusLine?.trim() ||
    `Authorized to work in ${country}. ${permitName}${expiry ? ` valid to ${expiry}` : ''}, standard change of status on contract signing.`;

  const visaContext =
    wa?.visaContext?.trim() ||
    `${country} ${permitName}${expiry ? `, valid to ${expiry}` : ''}. Already legally resident in ${country}, no overseas visa process required.`;

  return { permitName, country, countryCode, expiry, statusLine, visaContext };
}

