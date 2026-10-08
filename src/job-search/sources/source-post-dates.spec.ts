// Every enabled source that used to fall back to the scrape time now reads the real posting
// date, or returns null (tagged "no-post-date" in run.ts) when there is none.
import { mapJob as mapAshby } from './ashby.source';
import { mapJob as mapBundesagentur } from './bundesagentur.source';
import { mapJob as mapEures } from './eures.source';
import { mapOffer as mapFranceTravail } from './france-travail.source';
import { mapJob as mapGlassdoor } from './glassdoor.source';
import { parseComment as mapHackerNews } from './hackernews.source';
import { mapJob as mapHimalayas } from './himalayas.source';
import { mapAjaxJob as mapJobbird } from './jobbird.source';
import { mapJob as mapJobbsafari } from './jobbsafari.source';
import { mapJob as mapJobicy } from './jobicy.source';
import { mapJob as mapJooble } from './jooble.source';
import { mapJob as mapNvb } from './nvb.source';
import { extractJobsFromHtml, mapRawJob } from './shared-scraper';
import { mapJob as mapStepstone } from './stepstone-de.source';
import { mapPosition as mapTalentio } from './talentio.source';
import { mapItem as mapWwr, parseRssItems } from './weworkremotely.source';
import { JobPosting } from '../types';

const ISO = '2026-10-06T09:00:00.000Z';
const SECONDS = Date.parse(ISO) / 1000;
const DESC =
  'We build backend APIs with Node.js, NestJS and TypeScript in a remote-friendly team.';

type Case = [
  string,
  (date: string | number | undefined) => JobPosting | null,
  string | number,
];

// Each mapper gets one raw record, once with its real date field set and once without it.
const CASES: Case[] = [
  [
    'ashby',
    (d) =>
      mapAshby(
        {
          id: '1',
          title: 'Backend Engineer (Node.js)',
          descriptionHtml: DESC,
          publishedDate: d,
        } as unknown as Parameters<typeof mapAshby>[0],
        'acme',
      ),
    ISO,
  ],
  [
    'bundesagentur',
    (d) =>
      mapBundesagentur({
        refnr: '1',
        titel: 'Backend Entwickler Node.js',
        arbeitgeber: 'Acme',
        aktuelleVeroeffentlichungsdatum: d,
      } as unknown as Parameters<typeof mapBundesagentur>[0]),
    ISO,
  ],
  [
    'francetravail',
    (d) =>
      mapFranceTravail({
        id: '1',
        intitule: 'Développeur backend Node.js',
        description: DESC,
        lieuTravail: { libelle: '75 - Paris' },
        salaire: {},
        dateCreation: d,
      } as unknown as Parameters<typeof mapFranceTravail>[0]),
    ISO,
  ],
  [
    'glassdoor',
    (d) =>
      mapGlassdoor({
        title: 'Backend Engineer Node.js',
        url: 'https://glassdoor.com/job/1',
        description: DESC,
        datePosted: d,
      } as unknown as Parameters<typeof mapGlassdoor>[0]),
    ISO,
  ],
  [
    'himalayas',
    (d) =>
      mapHimalayas({
        guid: '1',
        title: 'Backend Engineer Node.js',
        applicationLink: 'https://himalayas.app/jobs/1',
        description: DESC,
        pubDate: d,
      } as unknown as Parameters<typeof mapHimalayas>[0]),
    SECONDS,
  ],
  [
    'jobbird',
    (d) =>
      mapJobbird(
        {
          title: 'Backend Developer Node.js',
          description: DESC,
          dateRefreshed: d,
        } as unknown as Parameters<typeof mapJobbird>[0],
        '1',
      ),
    ISO,
  ],
  [
    'jobbsafari',
    (d) =>
      mapJobbsafari({
        title: 'Backend Developer Node.js',
        url: 'https://jobbsafari.se/job/1',
        description: DESC,
        datePosted: d,
      } as unknown as Parameters<typeof mapJobbsafari>[0]),
    ISO,
  ],
  [
    'jobicy',
    (d) =>
      mapJobicy({
        url: 'https://jobicy.com/jobs/1',
        jobTitle: 'Backend Engineer Node.js',
        jobDescription: DESC,
        pubDate: d,
      } as unknown as Parameters<typeof mapJobicy>[0]),
    ISO,
  ],
  [
    'jooble',
    (d) =>
      mapJooble({
        title: 'Backend Entwickler Node.js',
        link: 'https://jooble.org/desc/1',
        snippet: DESC,
        updated: d,
      } as unknown as Parameters<typeof mapJooble>[0]),
    ISO,
  ],
  [
    'nvb',
    (d) =>
      mapNvb({
        metadata: { jdco: 'Backend Developer Node.js' },
        apply: { url: 'https://nvb.nl/1' },
        description: DESC,
        publicationDate: d,
      } as unknown as Parameters<typeof mapNvb>[0]),
    ISO,
  ],
  [
    'stepstone-de',
    (d) =>
      mapStepstone({
        title: 'Backend Entwickler Node.js',
        url: 'https://www.stepstone.de/job/1',
        description: DESC,
        datePosted: d,
      } as unknown as Parameters<typeof mapStepstone>[0]),
    ISO,
  ],
  [
    'talentio',
    (d) =>
      mapTalentio({
        id: '1',
        name: 'Backend Engineer Node.js',
        description: DESC,
        publicationDate: d,
      } as unknown as Parameters<typeof mapTalentio>[0]),
    ISO,
  ],
  [
    'hackernews',
    (d) =>
      mapHackerNews({
        objectID: '1',
        parent_id: 9,
        created_at: d,
        comment_text: `Acme | Berlin, Germany | Remote | Backend Engineer<p>${DESC} Apply at https://acme.dev/jobs`,
      } as unknown as Parameters<typeof mapHackerNews>[0]),
    ISO,
  ],
  [
    'shared scraper (jobware, duunitori, intermediair, xing)',
    (d) =>
      mapRawJob(
        {
          title: 'Backend Developer Node.js',
          url: '/job/1',
          description: DESC,
          datePosted: d as string | undefined,
        },
        'jobware.de',
        4,
        'DE',
        'Germany',
        'https://www.jobware.de',
      ),
    ISO,
  ],
];

describe('posting dates — real date when the source gives one', () => {
  it.each(CASES)('%s', (_name, map, date) => {
    const job = map(date);
    expect(job).not.toBeNull();
    expect(job?.publishedAt).toBe(ISO);
    expect(job?.publishedAtTimestamp).toBe(SECONDS);
  });
});

describe('posting dates — null (never the scrape time) when the date is missing or unparseable', () => {
  it.each(CASES)('%s, missing', (_name, map) => {
    const job = map(undefined);
    expect(job).not.toBeNull();
    expect(job?.publishedAt).toBeNull();
    expect(job?.publishedAtTimestamp).toBeNull();
  });

  it.each(CASES.filter(([, , d]) => typeof d === 'string'))(
    '%s, unparseable',
    (_name, map) => {
      const job = map('not a date');
      expect(job).not.toBeNull();
      expect(job?.publishedAtTimestamp).toBeNull();
    },
  );
});

describe('weworkremotely', () => {
  const item = (pubDate: string) =>
    `<item><title>Acme: Backend Engineer (Node.js)</title><link>https://weworkremotely.com/jobs/1</link>` +
    `<description>${DESC}</description>${pubDate}<region>Anywhere in the World</region></item>`;

  it('reads the RSS pubDate', () => {
    const [parsed] = parseRssItems(
      `<rss>${item('<pubDate>Tue, 06 Oct 2026 09:00:00 +0000</pubDate>')}</rss>`,
    );
    expect(mapWwr(parsed)?.publishedAtTimestamp).toBe(SECONDS);
  });

  it('keeps an item without pubDate, with a null date', () => {
    const [parsed] = parseRssItems(`<rss>${item('')}</rss>`);
    expect(parsed.pubDate).toBeNull();
    expect(mapWwr(parsed)?.publishedAt).toBeNull();
  });
});

describe('eures', () => {
  it('returns a null date when the record has none', () => {
    const job = mapEures(
      {
        id: 'X1',
        title: 'Node.js Backend Developer',
        description: DESC,
        locationMap: { DE: ['DE300'] },
      } as Parameters<typeof mapEures>[0],
      0,
    );
    expect(job?.publishedAtTimestamp).toBeNull();
  });
});

describe('shared scraper — HTML cards', () => {
  const card = (inner: string) =>
    `<ul><li class="job-card"><h3>Backend Developer Node.js</h3><a href="/job/42">View</a>${inner}</li></ul>`;

  it('reads <time datetime> from the card', () => {
    const [raw] = extractJobsFromHtml(
      card(`<time datetime="${ISO}">6 Oct</time>`),
      'https://www.jobware.de',
    );
    expect(
      mapRawJob(
        { ...raw, description: DESC },
        'jobware.de',
        4,
        'DE',
        'Germany',
        'https://www.jobware.de',
      )?.publishedAtTimestamp,
    ).toBe(SECONDS);
  });

  it('reads a "posted" phrase from the card', () => {
    const [raw] = extractJobsFromHtml(
      card('<span>vor 2 Tagen</span>'),
      'https://www.jobware.de',
    );
    expect(raw.date).toBeDefined();
  });

  it('leaves the date unset when the card shows none', () => {
    const [raw] = extractJobsFromHtml(
      card('<span>Berlin</span>'),
      'https://www.jobware.de',
    );
    expect(raw.date).toBeUndefined();
  });
});
