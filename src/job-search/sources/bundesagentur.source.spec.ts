import { mapJob, BaJob } from './bundesagentur.source';

function buildRaw(overrides: Partial<BaJob> = {}): BaJob {
  return {
    refnr: '10000-1234567890-S',
    titel: 'Backend Entwickler (Node.js)',
    beruf: 'Softwareentwickler',
    arbeitgeber: 'Acme GmbH',
    arbeitsort: { ort: 'Berlin' },
    aktuelleVeroeffentlichungsdatum: new Date().toISOString(),
    ...overrides,
  };
}

describe('bundesagentur mapJob', () => {
  it('maps a well-formed job to a JobPosting', () => {
    const job = mapJob(buildRaw());
    expect(job).not.toBeNull();
    expect(job?.source).toBe('arbeitsagentur.de');
    expect(job?.company).toBe('Acme GmbH');
    expect(job?.city).toBe('Berlin');
    expect(job?.countryCode).toBe('DE');
  });

  it('returns null when refnr is missing', () => {
    expect(mapJob(buildRaw({ refnr: '' }))).toBeNull();
  });

  it('returns null when titel is missing', () => {
    expect(mapJob(buildRaw({ titel: '' }))).toBeNull();
  });

  it('prefers externeUrl for canonicalUrl when present', () => {
    const job = mapJob(buildRaw({ externeUrl: 'https://company.example/careers/123' }));
    expect(job?.canonicalUrl).toBe('https://company.example/careers/123');
  });

  it('falls back to the arbeitsagentur.de detail page when externeUrl is absent', () => {
    const job = mapJob(buildRaw({ externeUrl: undefined }));
    expect(job?.canonicalUrl).toBe('https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1234567890-S');
  });

  it('starts with descriptionPartial true and an empty description before the detail fetch runs', () => {
    const job = mapJob(buildRaw());
    expect(job?.description).toBe('');
    expect(job?.descriptionPartial).toBe(true);
  });

  it('infers hybrid work mode from arbeitszeitmodelle homeoffice signal', () => {
    const job = mapJob(buildRaw({ arbeitszeitmodelle: ['Vollzeit', 'Homeoffice möglich'] }));
    expect(job?.workMode).toBe('hybrid');
  });

  it('defaults to on-site when no remote/homeoffice signal is present', () => {
    const job = mapJob(buildRaw({ arbeitszeitmodelle: ['Vollzeit'] }));
    expect(job?.workMode).toBe('on-site');
  });
});
