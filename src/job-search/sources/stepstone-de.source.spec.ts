import { mapJob, RawJob } from './stepstone-de.source';

function buildRaw(overrides: Partial<RawJob> = {}): RawJob {
  return {
    title: 'Backend Entwickler (Node.js)',
    url: '/stellenangebote--Backend-Entwickler--123456-inline.html',
    company: 'Acme GmbH',
    location: 'Berlin',
    description: 'Wir suchen einen Node.js Entwickler mit TypeScript-Erfahrung.',
    datePosted: new Date().toISOString(),
    ...overrides,
  };
}

describe('stepstone-de mapJob', () => {
  it('maps a well-formed job to a JobPosting', () => {
    const job = mapJob(buildRaw());
    expect(job).not.toBeNull();
    expect(job?.source).toBe('stepstone.de');
    expect(job?.company).toBe('Acme GmbH');
    expect(job?.canonicalUrl).toBe('https://www.stepstone.de/stellenangebote--Backend-Entwickler--123456-inline.html');
  });

  it('returns null when title is missing', () => {
    expect(mapJob(buildRaw({ title: undefined, name: undefined }))).toBeNull();
  });

  it('returns null when url is missing', () => {
    expect(mapJob(buildRaw({ url: undefined, jobUrl: undefined }))).toBeNull();
  });

  it('extracts a German experience-cap phrase ("mindestens X Jahre") from the description', () => {
    const job = mapJob(buildRaw({ description: 'Mindestens 6 Jahre Berufserfahrung erforderlich.' }));
    expect(job?.experienceLevelMinimum).toBe(6);
  });

  it('extracts the abbreviated German form ("mind. X Jahre")', () => {
    const job = mapJob(buildRaw({ description: 'Mind. 7 Jahre Erfahrung im Backend-Bereich.' }));
    expect(job?.experienceLevelMinimum).toBe(7);
  });

  it('resolves company from a nested object shape', () => {
    const job = mapJob(buildRaw({ company: undefined, employer: { name: 'Nested Employer GmbH' } }));
    expect(job?.company).toBe('Nested Employer GmbH');
  });
});
