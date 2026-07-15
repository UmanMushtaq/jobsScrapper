import {
  AnalyticsRow,
  filterByWindow,
  computeCountsBySource,
  computeApplicationsBySource,
  computeCountsByCountry,
  computeStatusBreakdown,
  computeTrendOverTime,
  buildAnalyticsData,
} from './analytics';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function row(overrides: Partial<AnalyticsRow> = {}): AnalyticsRow {
  return {
    source: 'apec.fr',
    countryCode: 'FR',
    status: 'applied',
    timestamp: NOW,
    ...overrides,
  };
}

describe('filterByWindow', () => {
  const rows: AnalyticsRow[] = [
    row({ timestamp: NOW }),
    row({ timestamp: NOW - 6 * DAY_MS }),
    row({ timestamp: NOW - 40 * DAY_MS }),
    row({ timestamp: NOW - 200 * DAY_MS }),
  ];

  it('keeps only rows within the last 7 days', () => {
    expect(filterByWindow(rows, 7)).toHaveLength(2);
  });

  it('keeps only rows within the last 30 days', () => {
    expect(filterByWindow(rows, 30)).toHaveLength(2);
  });

  it('keeps only rows within the last 90 days', () => {
    expect(filterByWindow(rows, 90)).toHaveLength(3);
  });

  it('"all" returns every row unfiltered', () => {
    expect(filterByWindow(rows, 'all')).toHaveLength(4);
  });
});

describe('computeCountsBySource', () => {
  it('counts jobs per source, sorted descending by count', () => {
    const rows = [
      row({ source: 'apec.fr' }),
      row({ source: 'apec.fr' }),
      row({ source: 'adzuna.com' }),
      row({ source: 'apec.fr' }),
      row({ source: 'adzuna.com' }),
    ];
    expect(computeCountsBySource(rows)).toEqual([
      { label: 'apec.fr', count: 3 },
      { label: 'adzuna.com', count: 2 },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(computeCountsBySource([])).toEqual([]);
  });
});

describe('computeApplicationsBySource', () => {
  it('only counts rows with status=applied, ignoring dismissed/pending', () => {
    const rows = [
      row({ source: 'apec.fr', status: 'applied' }),
      row({ source: 'apec.fr', status: 'dismissed' }),
      row({ source: 'apec.fr', status: 'applied' }),
      row({ source: 'adzuna.com', status: 'pending' }),
    ];
    expect(computeApplicationsBySource(rows)).toEqual([{ label: 'apec.fr', count: 2 }]);
  });
});

describe('computeCountsByCountry', () => {
  it('groups by the corrected countryCode field, not a source-name heuristic', () => {
    const rows = [
      row({ source: 'adzuna.com', countryCode: 'DE' }),
      row({ source: 'adzuna.com', countryCode: 'FR' }),
      row({ source: 'adzuna.com', countryCode: 'DE' }),
    ];
    expect(computeCountsByCountry(rows)).toEqual([
      { label: 'DE', count: 2 },
      { label: 'FR', count: 1 },
    ]);
  });

  it('buckets a null countryCode under "Unknown" rather than dropping it', () => {
    const rows = [row({ countryCode: null }), row({ countryCode: null })];
    expect(computeCountsByCountry(rows)).toEqual([{ label: 'Unknown', count: 2 }]);
  });
});

describe('computeStatusBreakdown', () => {
  it('tallies applied/dismissed/pending independently', () => {
    const rows = [
      row({ status: 'applied' }),
      row({ status: 'applied' }),
      row({ status: 'dismissed' }),
      row({ status: 'pending' }),
      row({ status: 'pending' }),
      row({ status: 'pending' }),
    ];
    expect(computeStatusBreakdown(rows)).toEqual({ applied: 2, dismissed: 1, pending: 3 });
  });

  it('returns all zeros for no rows', () => {
    expect(computeStatusBreakdown([])).toEqual({ applied: 0, dismissed: 0, pending: 0 });
  });
});

describe('computeTrendOverTime', () => {
  it('buckets rows by calendar day and sorts ascending', () => {
    const day1 = new Date('2026-07-01T10:00:00Z').getTime();
    const day2 = new Date('2026-07-02T09:00:00Z').getTime();
    const rows = [
      row({ timestamp: day2 }),
      row({ timestamp: day1 }),
      row({ timestamp: day1 + 60_000 }),
    ];
    expect(computeTrendOverTime(rows)).toEqual([
      { date: '2026-07-01', count: 2 },
      { date: '2026-07-02', count: 1 },
    ]);
  });

  it('returns an empty array for no rows', () => {
    expect(computeTrendOverTime([])).toEqual([]);
  });
});

describe('buildAnalyticsData', () => {
  it('applies the time window before computing every chart\'s data', () => {
    const rows = [
      row({ source: 'apec.fr', status: 'applied', timestamp: NOW }),
      row({ source: 'apec.fr', status: 'applied', timestamp: NOW - 200 * DAY_MS }),
    ];
    const data = buildAnalyticsData(rows, 30);
    expect(data.totalRows).toBe(1);
    expect(data.jobsBySource).toEqual([{ label: 'apec.fr', count: 1 }]);
    expect(data.applicationsBySource).toEqual([{ label: 'apec.fr', count: 1 }]);
  });

  it('"all" window includes everything and carries a data-limitation note', () => {
    const rows = [
      row({ timestamp: NOW - 200 * DAY_MS }),
      row({ timestamp: NOW }),
    ];
    const data = buildAnalyticsData(rows, 'all');
    expect(data.totalRows).toBe(2);
    expect(data.dataNote.length).toBeGreaterThan(0);
    expect(data.windowDays).toBe('all');
  });
});
