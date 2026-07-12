import { mapPosition, TalentioPosition } from './talentio.source';

function buildRaw(overrides: Partial<TalentioPosition> = {}): TalentioPosition {
  return {
    id: 'pos-12345',
    name: 'Backend Engineer (Node.js/TypeScript)',
    slug: 'backend-engineer-node-typescript',
    company: { name: 'Acme SAS', slug: 'acme-sas' },
    office: { city: 'Paris', country: 'France', countryCode: 'FR' },
    remote: false,
    remotePolicy: 'no',
    description: 'We build backend APIs with Node.js and TypeScript.',
    publicationDate: new Date().toISOString(),
    ...overrides,
  };
}

describe('talentio mapPosition', () => {
  it('maps a well-formed position to a JobPosting', () => {
    const job = mapPosition(buildRaw());
    expect(job).not.toBeNull();
    expect(job?.source).toBe('eu.talent.io');
    expect(job?.company).toBe('Acme SAS');
    expect(job?.city).toBe('Paris');
    expect(job?.countryCode).toBe('FR');
    expect(job?.canonicalUrl).toBe('https://eu.talent.io/app/jobs/backend-engineer-node-typescript');
  });

  it('returns null when id is missing', () => {
    expect(mapPosition(buildRaw({ id: '' }))).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(mapPosition(buildRaw({ name: '' }))).toBeNull();
  });

  it('falls back to the raw id for the URL slug when slug is absent', () => {
    const job = mapPosition(buildRaw({ slug: undefined }));
    expect(job?.canonicalUrl).toBe('https://eu.talent.io/app/jobs/pos-12345');
  });

  it('maps remote: true to workMode "remote"', () => {
    const job = mapPosition(buildRaw({ remote: true, remotePolicy: undefined }));
    expect(job?.workMode).toBe('remote');
  });

  it('maps remotePolicy "full" to workMode "remote"', () => {
    const job = mapPosition(buildRaw({ remote: false, remotePolicy: 'full' }));
    expect(job?.workMode).toBe('remote');
  });

  it('maps remotePolicy "partial" to workMode "hybrid"', () => {
    const job = mapPosition(buildRaw({ remote: false, remotePolicy: 'partial' }));
    expect(job?.workMode).toBe('hybrid');
  });

  it('defaults to on-site with no remote signal', () => {
    const job = mapPosition(buildRaw({ remote: undefined, remotePolicy: undefined }));
    expect(job?.workMode).toBe('on-site');
  });

  it('infers countryCode from office.country when countryCode is absent', () => {
    const job = mapPosition(buildRaw({ office: { city: 'Berlin', country: 'Germany' } }));
    expect(job?.countryCode).toBe('DE');
  });

  it('falls back to "Unknown" company when company is undefined', () => {
    const job = mapPosition(buildRaw({ company: undefined as unknown as TalentioPosition['company'] }));
    expect(job?.company).toBe('Unknown');
  });

  it('detects relocation/visa-sponsorship keywords in the description', () => {
    const job = mapPosition(buildRaw({ description: 'We offer visa sponsorship for this role.' }));
    expect(job?.offersRelocation).toBe(true);
  });
});
