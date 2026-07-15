import { renderAnalyticsPage } from './analytics-page';
import { AnalyticsData } from './job-search/analytics';

function buildData(overrides: Partial<AnalyticsData> = {}): AnalyticsData {
  return {
    windowDays: 30,
    totalRows: 3,
    jobsBySource: [{ label: 'apec.fr', count: 2 }, { label: 'adzuna.com', count: 1 }],
    applicationsBySource: [{ label: 'apec.fr', count: 1 }],
    jobsByCountry: [{ label: 'FR', count: 3 }],
    statusBreakdown: { applied: 1, dismissed: 1, pending: 1 },
    trend: [{ date: '2026-07-01', count: 2 }, { date: '2026-07-02', count: 1 }],
    dataNote: 'test data note',
    ...overrides,
  };
}

describe('renderAnalyticsPage', () => {
  it('renders a full HTML document with the expected charts and no apply/dismiss actions', () => {
    const html = renderAnalyticsPage(buildData());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Sources &amp; Applications');
    expect(html).toContain('Jobs found by source');
    expect(html).toContain('Applications by source');
    expect(html).toContain('Jobs by country');
    expect(html).toContain('Applied vs. dismissed vs. pending');
    expect(html).toContain('Trend over time');
    expect(html).toContain('← Back to Dashboard');
    // Read-only page: no apply/dismiss/run-source form actions anywhere.
    expect(html).not.toContain('action="/run');
    expect(html).not.toContain('/applied"');
    expect(html).not.toContain('/dismiss"');
  });

  it('escapes untrusted source/country labels rather than injecting them raw', () => {
    const html = renderAnalyticsPage(buildData({
      jobsBySource: [{ label: '<script>alert(1)</script>', count: 1 }],
    }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders a graceful empty state for an all-zero window instead of a broken chart', () => {
    const html = renderAnalyticsPage(buildData({
      jobsBySource: [],
      applicationsBySource: [],
      jobsByCountry: [],
      statusBreakdown: { applied: 0, dismissed: 0, pending: 0 },
      trend: [],
      totalRows: 0,
    }));
    expect(html).toContain('No data in this window.');
    expect(html).toContain('Not enough data yet to plot a trend');
  });

  it('renders the "all time" window selector as active when windowDays is "all"', () => {
    const html = renderAnalyticsPage(buildData({ windowDays: 'all' }));
    expect(html).toMatch(/href="\/analytics\?days=all" class="window-opt active"/);
  });

  it('highlights the correct window option for a numeric windowDays', () => {
    const html = renderAnalyticsPage(buildData({ windowDays: 7 }));
    expect(html).toMatch(/href="\/analytics\?days=7" class="window-opt active"/);
  });
});
