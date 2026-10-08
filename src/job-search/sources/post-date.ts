import { load as cheerioLoad } from 'cheerio';

// Real posting dates for scrapers that read HTML. Order of trust:
//   1. schema.org JobPosting JSON-LD "datePosted" (what job boards publish for Google for Jobs)
//   2. datePosted / published-time meta or itemprop, <time datetime>
//   3. "posted ..." text: "3 days ago", "il y a 3 jours", "vor 3 Tagen", "Publiée le 12/10/2026"
// When none is found the job gets publishedAt null and run.ts tags it "no-post-date".

export interface PostDate {
  publishedAt: string | null;
  publishedAtTimestamp: number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_PLAUSIBLE_MS = Date.UTC(2015, 0, 1);

export function toPostDate(ms: number | null): PostDate {
  if (ms === null) return { publishedAt: null, publishedAtTimestamp: null };
  return {
    publishedAt: new Date(ms).toISOString(),
    publishedAtTimestamp: Math.floor(ms / 1000),
  };
}

// ISO-ish date string → ms, or null when unparseable or implausible (before 2015, or more
// than a day in the future).
export function parseIsoDate(value: unknown, now = Date.now()): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms) || ms < MIN_PLAUSIBLE_MS || ms > now + DAY_MS)
    return null;
  return ms;
}

function jobPostingsIn(
  node: unknown,
  out: Array<Record<string, unknown>>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) jobPostingsIn(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  if (
    type === 'JobPosting' ||
    (Array.isArray(type) && type.includes('JobPosting'))
  )
    out.push(obj);
  for (const key of ['@graph', 'itemListElement', 'item']) {
    if (obj[key]) jobPostingsIn(obj[key], out);
  }
}

// Every JobPosting found in the given JSON-LD script bodies, with its url and datePosted.
export function jsonLdJobDates(
  scripts: string[],
  now = Date.now(),
): Array<{ url: string | null; ms: number }> {
  const result: Array<{ url: string | null; ms: number }> = [];
  for (const body of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const postings: Array<Record<string, unknown>> = [];
    jobPostingsIn(parsed, postings);
    for (const p of postings) {
      const ms = parseIsoDate(p.datePosted, now);
      if (ms === null) continue;
      const url = typeof p.url === 'string' ? p.url : null;
      result.push({ url, ms });
    }
  }
  return result;
}

// Posting date of a single job page (detail page) from its HTML.
export function extractPostDateFromHtml(
  html: string,
  now = Date.now(),
): number | null {
  const $ = cheerioLoad(html);
  const scripts = $('script[type="application/ld+json"]')
    .toArray()
    .map((el) => $(el).text());
  const fromJsonLd = jsonLdJobDates(scripts, now)[0];
  if (fromJsonLd) return fromJsonLd.ms;

  const metaCandidates = [
    $('meta[itemprop="datePosted"]').attr('content'),
    $('[itemprop="datePosted"]').attr('datetime'),
    $('[itemprop="datePosted"]').attr('content'),
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[property="og:published_time"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
  ];
  for (const candidate of metaCandidates) {
    const ms = parseIsoDate(candidate, now);
    if (ms !== null) return ms;
  }
  return parsePostedText($('body').text(), now, { cardText: false });
}

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(?:minute|minuten|min)/, 60 * 1000],
  [/^(?:hour|heure|stunde|std)/, HOUR_MS],
  [/^(?:day|jour|tag)/, DAY_MS],
  [/^(?:week|semaine|woche)/, 7 * DAY_MS],
  [/^(?:month|mois|monat)/, 30 * DAY_MS],
];

function unitMs(unit: string): number | null {
  const u = unit.toLowerCase();
  for (const [pattern, ms] of UNIT_MS) if (pattern.test(u)) return ms;
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  janvier: 0,
  januar: 0,
  feb: 1,
  february: 1,
  février: 1,
  fevrier: 1,
  februar: 1,
  mar: 2,
  march: 2,
  mars: 2,
  märz: 2,
  maerz: 2,
  apr: 3,
  april: 3,
  avril: 3,
  may: 4,
  mai: 4,
  jun: 5,
  june: 5,
  juin: 5,
  juni: 5,
  jul: 6,
  july: 6,
  juillet: 6,
  juli: 6,
  aug: 7,
  august: 7,
  août: 7,
  aout: 7,
  sep: 8,
  sept: 8,
  september: 8,
  septembre: 8,
  oct: 9,
  october: 9,
  octobre: 9,
  okt: 9,
  oktober: 9,
  nov: 10,
  november: 10,
  novembre: 10,
  dec: 11,
  december: 11,
  décembre: 11,
  decembre: 11,
  dez: 11,
  dezember: 11,
};

function dayMonthYear(day: number, month: number, year: number): number | null {
  const y = year < 100 ? 2000 + year : year;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  return Date.UTC(y, month, day, 12);
}

// "Posted ..." phrases in English, French and German. Only explicit posting phrases are
// read, so a start date or deadline elsewhere in the text is not mistaken for one. Bare
// "today"/"heute"/"gestern" only count on a short listing card (options.cardText), never in
// a page body ("Apply today!" is not a posting date).
export function parsePostedText(
  rawText: string,
  now = Date.now(),
  options: { cardText?: boolean } = {},
): number | null {
  const text = (rawText ?? '').toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  const check = (ms: number | null): number | null =>
    ms !== null && ms >= MIN_PLAUSIBLE_MS && ms <= now + DAY_MS ? ms : null;

  // "3 days ago" / "il y a 3 jours" / "vor 3 Tagen" (also "il y a 30+ jours")
  const relative =
    text.match(/(\d{1,3})\+?\s*(minutes?|hours?|days?|weeks?|months?)\s+ago/) ??
    text.match(
      /il y a\s+(\d{1,3})\+?\s*(minutes?|heures?|jours?|semaines?|mois)/,
    ) ??
    text.match(
      /vor\s+(\d{1,3})\+?\s*(minuten|minute|stunden|stunde|std\.?|tagen|tag|wochen|woche|monaten|monat)/,
    );
  if (relative) {
    const unit = unitMs(relative[2]);
    if (unit !== null) return check(now - parseInt(relative[1], 10) * unit);
  }
  const single =
    text.match(/\b(?:a|an|one)\s+(day|week|month|hour)\s+ago\b/) ??
    text.match(/il y a (?:un|une)\s+(jour|semaine|heure)/) ??
    text.match(/vor (?:einem|einer)\s+(tag|monat|woche|stunde)/);
  if (single) {
    const unit = unitMs(single[1]);
    if (unit !== null) return check(now - unit);
  }
  const shortText = options.cardText !== false && text.length <= 300;
  if (
    /\b(?:posted|published|added) today\b|\bjust posted\b|publiée? aujourd['’]hui|heute veröffentlicht/.test(
      text,
    ) ||
    (shortText && /\baujourd['’]hui\b|\bheute\b|\btoday\b/.test(text))
  ) {
    return now;
  }
  if (
    /\b(?:posted|published|added) yesterday\b|publiée? hier|gestern veröffentlicht/.test(
      text,
    ) ||
    (shortText && /\byesterday\b|\bgestern\b/.test(text))
  ) {
    return now - DAY_MS;
  }

  // "Publiée le 12/10/2026" / "posted on 12.10.2026" / "veröffentlicht am 12.10.2026"
  const lead = String.raw`(?:publi[ée]+e?s?\s+le|mise? en ligne le|posted(?:\s+on)?|published(?:\s+on)?|veröffentlicht(?:\s+am)?|online seit)`;
  const numeric = text.match(
    new RegExp(
      String.raw`${lead}\s*:?\s*(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})`,
    ),
  );
  if (numeric) {
    return check(
      dayMonthYear(
        parseInt(numeric[1], 10),
        parseInt(numeric[2], 10) - 1,
        parseInt(numeric[3], 10),
      ),
    );
  }
  const named = text.match(
    new RegExp(
      String.raw`${lead}\s*:?\s*(\d{1,2})\.?\s+([a-zäéû]+)\.?\s+(\d{4})`,
    ),
  );
  if (named && MONTHS[named[2]] !== undefined) {
    return check(
      dayMonthYear(
        parseInt(named[1], 10),
        MONTHS[named[2]],
        parseInt(named[3], 10),
      ),
    );
  }
  const iso = text.match(
    new RegExp(String.raw`${lead}\s*:?\s*(\d{4}-\d{2}-\d{2})`),
  );
  if (iso) return check(parseIsoDate(iso[1], now));

  return null;
}

// Posting date for a search-result card scraped in the browser: the page's JSON-LD entry
// for the same URL, then the card's <time datetime>, then its "posted" text.
export function resultCardPostDate(
  card: { url: string; datetime: string | null; cardText: string },
  jsonLdDates: Array<{ url: string | null; ms: number }>,
  baseUrl: string,
  now = Date.now(),
): number | null {
  const pathOf = (u: string): string | null => {
    try {
      return new URL(u, baseUrl).pathname.replace(/\/$/, '');
    } catch {
      return null;
    }
  };
  const cardPath = pathOf(card.url);
  const fromJsonLd = jsonLdDates.find(
    (d) => d.url !== null && cardPath !== null && pathOf(d.url) === cardPath,
  );
  if (fromJsonLd) return fromJsonLd.ms;
  return (
    parseIsoDate(card.datetime, now) ?? parsePostedText(card.cardText, now)
  );
}

// A source's raw date value → PostDate, or null fields when it is missing or unparseable
// (never the scrape time). Accepts ISO / RFC 2822 strings, "dd.mm.yyyy" / "dd/mm/yyyy",
// "posted" phrases ("3 days ago", "Publiée le 06/10/2026", "vor 2 Tagen"), epoch numbers
// (seconds or ms) and Date objects. An old but valid date is kept as is (it then fails the
// freshness check); only garbage (0, negative, more than a day ahead) becomes null.
export function postDateFrom(value: unknown, now = Date.now()): PostDate {
  const valid = (ms: number): number | null => (Number.isFinite(ms) && ms > 0 && ms <= now + DAY_MS ? ms : null);
  if (value instanceof Date) return toPostDate(valid(value.getTime()));
  if (typeof value === 'number') return toPostDate(valid(value < 1e12 ? value * 1000 : value));
  if (typeof value !== 'string' || !value.trim()) return toPostDate(null);
  const text = value.trim();

  // Unambiguous machine formats: ISO 8601 and RFC 2822 ("Mon, 05 Oct 2026 10:00:00 +0000").
  if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^(?:[a-z]{3},?\s+)?\d{1,2}\s+[a-z]{3}\s+\d{4}/i.test(text)) {
    return toPostDate(valid(Date.parse(text)));
  }
  // Day-first numeric dates: Date.parse would read "06.10.2026" as 10 June.
  const dmy = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (dmy) {
    const year = parseInt(dmy[3], 10);
    const ms = Date.UTC(year < 100 ? 2000 + year : year, parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10), 12);
    return toPostDate(valid(ms));
  }
  const posted = parsePostedText(text, now, { cardText: true });
  if (posted !== null) return toPostDate(posted);
  // Anything else Date.parse reads, unless it holds a day-first numeric date it would misread.
  if (!/\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(text)) return toPostDate(valid(Date.parse(text)));
  return toPostDate(null);
}
