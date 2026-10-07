import { JobPosting } from './types';
import { inferCountryCode } from './sources/country-codes';

// Countries the bot searches in. Single-country sources outside this list are skipped
// at run time (their files stay registered in allSources), and multi-country sources
// have individual jobs in other specific countries dropped.
export const ALLOWED_COUNTRIES = ['FR', 'DE', 'NL', 'SE', 'DK', 'NO', 'FI'];

// Country of every single-country source in allSources. Sources not listed here are
// multi-country (aggregators, ATS boards, remote boards) and are always run.
export const SOURCE_COUNTRY: Record<string, string> = {
  'apec.fr': 'FR',
  'francetravail.fr': 'FR',
  'cadremploi.fr': 'FR',
  'hellowork.com': 'FR',
  'arbeitsagentur.de': 'DE',
  'arbeitnow.com': 'DE',
  'berlinstartupjobs.com': 'DE',
  'stepstone.de': 'DE',
  'stellenanzeigen.de': 'DE',
  'xing.com': 'DE',
  'jobware.de': 'DE',
  'englishjobs.de': 'DE',
  'nationalevacaturebank.nl': 'NL',
  'jobbird.nl': 'NL',
  'vacancy.nl': 'NL',
  'intermediair.nl': 'NL',
  'arbetsformedlingen.se': 'SE',
  'jobbsafari.se': 'SE',
  'duunitori.fi': 'FI',
  'ictjob.be': 'BE',
  'jobat.be': 'BE',
  'eurobrussels.com': 'BE',
  'pracuj.pl': 'PL',
  'theprotocol.it': 'PL',
  'justjoin.it': 'PL',
  'nofluffjobs.com': 'PL',
  'infojobs.it': 'IT',
  'talent.it': 'IT',
  'jobs.lu': 'LU',
  'moovijob.com': 'LU',
};

// Multi-country sources whose individual jobs are checked with isJobCountryAllowed.
export const MULTI_COUNTRY_SOURCES = new Set([
  'greenhouse.io',
  'jobs.ashbyhq.com',
  'jobs.lever.co',
  'eu.talent.io',
  'glassdoor.com',
  'jooble.org',
  'jobicy.com',
  'weworkremotely.com',
  'remotive.com',
  'remoteok.com',
  'himalayas.app',
  'nodesk.co',
  'news.ycombinator.com',
]);

const EUROPE_WIDE = /\b(europe|european|emea|eu)\b/i;

export function isSourceCountryAllowed(sourceName: string): boolean {
  const country = SOURCE_COUNTRY[sourceName];
  return !country || ALLOWED_COUNTRIES.includes(country);
}

// False only when the job is tied to a specific country outside ALLOWED_COUNTRIES.
// Europe-wide labels ("Remote Europe", "EMEA", "Anywhere in Europe") and jobs with no
// identifiable country are kept.
export function isJobCountryAllowed(
  job: Pick<JobPosting, 'countryCode' | 'locationLabel'>,
): boolean {
  if (EUROPE_WIDE.test(job.locationLabel ?? '')) return true;
  const raw = (job.countryCode ?? '').trim().toUpperCase();
  const cc =
    /^[A-Z]{2}$/.test(raw) && raw !== 'EU'
      ? raw
      : inferCountryCode(job.locationLabel ?? '');
  if (!cc) return true;
  return ALLOWED_COUNTRIES.includes(cc === 'UK' ? 'GB' : cc);
}
