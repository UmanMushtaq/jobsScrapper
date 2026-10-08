import {
  extractPostDateFromHtml,
  jsonLdJobDates,
  parseIsoDate,
  parsePostedText,
  postDateFrom,
  resultCardPostDate,
  toPostDate,
} from './post-date';

const NOW = Date.UTC(2026, 9, 8, 12); // 8 Oct 2026, 12:00 UTC
const DAY = 24 * 60 * 60 * 1000;

describe('parseIsoDate', () => {
  it('parses an ISO date', () => {
    expect(parseIsoDate('2026-10-06T09:00:00Z', NOW)).toBe(
      Date.UTC(2026, 9, 6, 9),
    );
  });

  it.each([undefined, '', 'not a date', '2030-01-01', '2001-01-01'])(
    'rejects %p',
    (value) => {
      expect(parseIsoDate(value, NOW)).toBeNull();
    },
  );
});

describe('extractPostDateFromHtml', () => {
  it('reads JobPosting datePosted from JSON-LD (including inside @graph)', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","datePosted":"2026-10-07"}]}</script>`;
    expect(extractPostDateFromHtml(html, NOW)).toBe(Date.parse('2026-10-07'));
  });

  it('falls back to itemprop datePosted, then <time datetime>', () => {
    expect(
      extractPostDateFromHtml(
        '<span itemprop="datePosted" content="2026-10-05"></span>',
        NOW,
      ),
    ).toBe(Date.parse('2026-10-05'));
    expect(
      extractPostDateFromHtml(
        '<time datetime="2026-10-04T08:00:00Z">4 Oct</time>',
        NOW,
      ),
    ).toBe(Date.UTC(2026, 9, 4, 8));
  });

  it('ignores broken JSON-LD and returns null when no date is shown', () => {
    expect(
      extractPostDateFromHtml(
        '<script type="application/ld+json">{oops</script><p>Apply today!</p>',
        NOW,
      ),
    ).toBeNull();
  });
});

describe('parsePostedText', () => {
  it.each([
    ['Posted 3 days ago', 3 * DAY],
    ['2 weeks ago', 14 * DAY],
    ['Il y a 5 jours', 5 * DAY],
    ['Publiée il y a 30+ jours', 30 * DAY],
    ['il y a une semaine', 7 * DAY],
    ['vor 2 Tagen', 2 * DAY],
    ['vor einer Woche', 7 * DAY],
    ['a day ago', DAY],
  ])('reads relative "%s"', (text, ago) => {
    expect(parsePostedText(text, NOW)).toBe(NOW - ago);
  });

  it.each([
    ['Publiée le 06/10/2026', Date.UTC(2026, 9, 6, 12)],
    ['Posted on 05.10.2026', Date.UTC(2026, 9, 5, 12)],
    ['Veröffentlicht am 04.10.2026', Date.UTC(2026, 9, 4, 12)],
    ['Publiée le 3 octobre 2026', Date.UTC(2026, 9, 3, 12)],
    ['Published: 2026-10-02', Date.parse('2026-10-02')],
  ])('reads absolute "%s"', (text, expected) => {
    expect(parsePostedText(text, NOW)).toBe(expected);
  });

  it('reads "today" / "Aujourd\'hui" / "gestern" on a short card', () => {
    expect(
      parsePostedText("Backend Dev · Acme · Paris · Aujourd'hui", NOW),
    ).toBe(NOW);
    expect(parsePostedText('Node.js Entwickler · Berlin · gestern', NOW)).toBe(
      NOW - DAY,
    );
  });

  it('does not treat "today" in a long page body as a posting date', () => {
    expect(
      parsePostedText(`${'We build things. '.repeat(30)} Apply today!`, NOW),
    ).toBeNull();
  });

  it('does not mistake a start date for a posting date', () => {
    expect(parsePostedText('Début : 01/11/2026 · CDI · Paris', NOW)).toBeNull();
  });
});

describe('resultCardPostDate', () => {
  const jsonLd = jsonLdJobDates(
    [
      JSON.stringify({
        '@type': 'ItemList',
        itemListElement: [
          {
            '@type': 'JobPosting',
            url: 'https://x.fr/offre/42',
            datePosted: '2026-10-07',
          },
        ],
      }),
    ],
    NOW,
  );

  it('prefers the JSON-LD entry for the same URL path', () => {
    const card = {
      url: '/offre/42',
      datetime: null,
      cardText: 'il y a 9 jours',
    };
    expect(resultCardPostDate(card, jsonLd, 'https://x.fr', NOW)).toBe(
      Date.parse('2026-10-07'),
    );
  });

  it('then the card <time datetime>, then its text, else null', () => {
    expect(
      resultCardPostDate(
        { url: '/offre/1', datetime: '2026-10-06', cardText: '' },
        jsonLd,
        'https://x.fr',
        NOW,
      ),
    ).toBe(Date.parse('2026-10-06'));
    expect(
      resultCardPostDate(
        { url: '/offre/1', datetime: null, cardText: 'il y a 2 jours' },
        jsonLd,
        'https://x.fr',
        NOW,
      ),
    ).toBe(NOW - 2 * DAY);
    expect(
      resultCardPostDate(
        { url: '/offre/1', datetime: null, cardText: 'CDI · Paris' },
        jsonLd,
        'https://x.fr',
        NOW,
      ),
    ).toBeNull();
  });
});

describe('toPostDate', () => {
  it('maps null to null fields (no fake scrape-time date)', () => {
    expect(toPostDate(null)).toEqual({
      publishedAt: null,
      publishedAtTimestamp: null,
    });
    expect(toPostDate(NOW)).toEqual({
      publishedAt: new Date(NOW).toISOString(),
      publishedAtTimestamp: NOW / 1000,
    });
  });
});

describe('postDateFrom', () => {
  const sec = (ms: number): number => Math.floor(ms / 1000);

  it.each([
    ['ISO', '2026-10-06T09:00:00Z', Date.UTC(2026, 9, 6, 9)],
    ['RFC 2822 (RSS)', 'Tue, 06 Oct 2026 09:00:00 +0000', Date.UTC(2026, 9, 6, 9)],
    ['day-first dotted', '06.10.2026', Date.UTC(2026, 9, 6, 12)],
    ['APEC card text (not read as 10 June)', 'Publiée le 06/10/2026', Date.UTC(2026, 9, 6, 12)],
    ['relative English', '2 days ago', NOW - 2 * DAY],
    ['relative German', 'vor 3 Tagen', NOW - 3 * DAY],
  ])('reads %s', (_label, value, expectedMs) => {
    expect(postDateFrom(value, NOW).publishedAtTimestamp).toBe(sec(expectedMs));
  });

  it('reads epoch seconds and epoch milliseconds', () => {
    expect(postDateFrom(sec(NOW - DAY), NOW).publishedAtTimestamp).toBe(sec(NOW - DAY));
    expect(postDateFrom(NOW - DAY, NOW).publishedAtTimestamp).toBe(sec(NOW - DAY));
  });

  it('keeps an old but valid date (so freshness rejects it) instead of nulling it', () => {
    expect(postDateFrom('2014-01-01', NOW).publishedAt).toBe('2014-01-01T00:00:00.000Z');
  });

  it.each([undefined, null, '', 'not a date', 0, -5, '2030-01-01', 'Début : 01/11/2026'])(
    'returns null fields for %p (never the scrape time)',
    (value) => {
      expect(postDateFrom(value, NOW)).toEqual({ publishedAt: null, publishedAtTimestamp: null });
    },
  );
});
