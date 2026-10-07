import { allSources } from './run';
import {
  ALLOWED_COUNTRIES,
  isJobCountryAllowed,
  isSourceCountryAllowed,
  MULTI_COUNTRY_SOURCES,
  SOURCE_COUNTRY,
} from './allowed-countries';

describe('allowed countries', () => {
  it('is exactly FR, DE, NL, SE, DK, NO, FI', () => {
    expect(ALLOWED_COUNTRIES).toEqual([
      'FR',
      'DE',
      'NL',
      'SE',
      'DK',
      'NO',
      'FI',
    ]);
  });

  it.each([
    'ictjob.be',
    'jobat.be',
    'eurobrussels.com',
    'theprotocol.it',
    'justjoin.it',
    'nofluffjobs.com',
    'infojobs.it',
    'talent.it',
    'jobs.lu',
    'moovijob.com',
    'pracuj.pl',
  ])('skips %s', (name) => {
    expect(isSourceCountryAllowed(name)).toBe(false);
  });

  it.each([
    'apec.fr',
    'arbeitsagentur.de',
    'jobbird.nl',
    'arbetsformedlingen.se',
    'duunitori.fi',
    'adzuna.com',
    'greenhouse.io',
  ])('keeps %s', (name) => {
    expect(isSourceCountryAllowed(name)).toBe(true);
  });

  it('every mapped or multi-country source name exists in allSources', () => {
    const names = new Set(allSources.map((s) => s.name));
    for (const name of [
      ...Object.keys(SOURCE_COUNTRY),
      ...MULTI_COUNTRY_SOURCES,
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it.each([
    ['Remote Europe', 'PL'],
    ['EMEA', null],
    ['Anywhere in Europe', null],
    ['Berlin, Germany', 'DE'],
    ['Stockholm', null],
    ['Oslo, Norway', null],
    ['Remote', null],
    ['Worldwide', 'REMOTE'],
  ])(
    'keeps job located "%s" (countryCode %s)',
    (locationLabel, countryCode) => {
      expect(isJobCountryAllowed({ locationLabel, countryCode })).toBe(true);
    },
  );

  it.each([
    ['Warsaw, Poland', 'PL'],
    ['London', null],
    ['Remote - United States', 'US'],
    ['Madrid', null],
    ['Brussels', 'BE'],
  ])(
    'drops job located "%s" (countryCode %s)',
    (locationLabel, countryCode) => {
      expect(isJobCountryAllowed({ locationLabel, countryCode })).toBe(false);
    },
  );
});
