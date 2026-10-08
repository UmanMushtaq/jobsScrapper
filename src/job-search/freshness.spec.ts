import { isFreshJob } from './run';
import { dashboardTtlSeconds, DASHBOARD_JOB_TTL_SECONDS } from './redis-store';

const NOW = Date.UTC(2026, 9, 8, 12);
const HOUR = 60 * 60 * 1000;

describe('isFreshJob', () => {
  const seenOnce = new Set(['https://example.com/job/old-undated']);

  it('keeps a dated job inside maxAgeHours and drops one outside it', () => {
    expect(
      isFreshJob(
        {
          canonicalUrl: 'https://example.com/a',
          publishedAtTimestamp: (NOW - 71 * HOUR) / 1000,
        },
        seenOnce,
        72,
        NOW,
      ),
    ).toBe(true);
    expect(
      isFreshJob(
        {
          canonicalUrl: 'https://example.com/a',
          publishedAtTimestamp: (NOW - 73 * HOUR) / 1000,
        },
        seenOnce,
        72,
        NOW,
      ),
    ).toBe(false);
  });

  it('passes a job without a posting date on the first run it is seen', () => {
    expect(
      isFreshJob(
        {
          canonicalUrl: 'https://example.com/job/new-undated',
          publishedAtTimestamp: null,
        },
        seenOnce,
        72,
        NOW,
      ),
    ).toBe(true);
  });

  it('drops a job without a posting date on every later run (matched by normalized URL)', () => {
    expect(
      isFreshJob(
        {
          canonicalUrl: 'https://example.com/job/old-undated/?utm_source=x',
          publishedAtTimestamp: null,
        },
        seenOnce,
        72,
        NOW,
      ),
    ).toBe(false);
  });
});

describe('dashboardTtlSeconds', () => {
  it('is 72 hours for a card that expires 72h from now', () => {
    expect(DASHBOARD_JOB_TTL_SECONDS).toBe(72 * 60 * 60);
    expect(dashboardTtlSeconds(NOW + 72 * HOUR, NOW)).toBe(72 * 60 * 60);
  });

  it('counts down to the deadline, never below 1 second', () => {
    expect(dashboardTtlSeconds(NOW + 2 * HOUR, NOW)).toBe(2 * 60 * 60);
    expect(dashboardTtlSeconds(NOW - 28 * HOUR, NOW)).toBe(1);
  });
});
