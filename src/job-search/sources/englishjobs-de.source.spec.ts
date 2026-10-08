import { mapJob, isRelevant, RawListingJob } from './englishjobs-de.source';

function buildListing(overrides: Partial<RawListingJob> = {}): RawListingJob {
  return {
    title: 'Backend Developer (Node.js)',
    company: 'Acme GmbH',
    locationLabel: 'Berlin, Germany',
    detailUrl: 'https://englishjobs.de/jobs/backend-developer-acme',
    ...overrides,
  };
}

describe('englishjobs-de isRelevant', () => {
  it('accepts a backend/node title', () => {
    expect(isRelevant('Senior Backend Developer (Node.js)')).toBe(true);
  });

  it('rejects a frontend-only title', () => {
    expect(isRelevant('Frontend Developer (React)')).toBe(false);
  });

  it('rejects a mobile title', () => {
    expect(isRelevant('iOS Developer')).toBe(false);
  });
});

describe('englishjobs-de mapJob', () => {
  it('maps a listing + description into a JobPosting', () => {
    const job = mapJob(buildListing(), 'We use Node.js and TypeScript across the stack.', false);
    expect(job).not.toBeNull();
    expect(job?.source).toBe('englishjobs.de');
    expect(job?.countryCode).toBe('DE');
    expect(job?.city).toBe('Berlin');
    expect(job?.canonicalUrl).toBe('https://englishjobs.de/jobs/backend-developer-acme');
  });

  it('carries the descriptionPartial flag through', () => {
    const job = mapJob(buildListing(), '', true);
    expect(job?.descriptionPartial).toBe(true);
  });

  it('still runs the language filter on the full description even though the site is English-only by definition', () => {
    const job = mapJob(buildListing(), 'Deutschkenntnisse in Wort und Schrift erforderlich.', false);
    expect(job?.language).not.toBe('en');
  });

  it('extracts a German experience-cap phrase from the description', () => {
    const job = mapJob(buildListing({ title: 'Senior Backend Engineer' }), 'Requires at least 7 years of experience.', false);
    expect(job?.experienceLevelMinimum).toBe(7);
  });
});

describe('englishjobs-de mapJob — posting date', () => {
  it('uses the real posting date when one was found', () => {
    const job = mapJob(buildListing(), 'Node.js and TypeScript.', false, Date.UTC(2026, 9, 6, 9));
    expect(job?.publishedAt).toBe('2026-10-06T09:00:00.000Z');
    expect(job?.publishedAtTimestamp).toBe(Date.UTC(2026, 9, 6, 9) / 1000);
  });

  it('leaves the date null (never scrape time) when the page shows none', () => {
    const job = mapJob(buildListing(), 'Node.js and TypeScript.', false);
    expect(job?.publishedAt).toBeNull();
    expect(job?.publishedAtTimestamp).toBeNull();
  });
});
