import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_KEYWORDS, CORE_KEYWORDS_MINIMAL, FRENCH_KEYWORDS, GERMAN_KEYWORDS, ENGLISH_KEYWORDS } from './keywords';

const SOURCES_DIR = join(__dirname, 'sources');

// Source files that legitimately do NOT do keyword-based search (post-fetch relevance
// filtering against a fixed feed/page, URL-path-based category browsing, disabled stubs,
// or dead/unregistered legacy files) — see the July 13 2026 keyword-consolidation audit
// report for the file-by-file reasoning. A file should only be added here with a comment
// explaining why it's exempt from importing keywords.ts.
const EXEMPT_FILES: Record<string, string> = {
  'arbeitnow.source.ts': 'fetches every page, filters post-fetch by RELEVANT_TAGS — no search query',
  'berlinstartupjobs.source.ts': 'single fixed listing page + post-fetch RELEVANT_KEYWORDS filter',
  'englishjobs-de.source.ts': 'LISTING_PATHS are site-specific URL slugs, not free-text search terms',
  'stellenanzeigen.source.ts': 'disabled stub — no working endpoint',
  'hackernews.source.ts': 'fetches Ask/Show HN threads, filters post-fetch by RELEVANT_KEYWORDS',
  'nofluffjobs.source.ts': 'hardcoded URL-path criteria (site-specific filter syntax), not free-text keywords',
  'remoteok.source.ts': 'fetches full feed, filters post-fetch by RELEVANT_TAGS — no search query',
  'nodesk.source.ts': 'disabled stub — single fixed page fetch, filters post-fetch via isRelevantJob, no search query',
  'indeed.source.ts': 'disabled stub — ScraperAPI plan expired',
  'pracuj.source.ts': 'disabled stub — no working endpoint',
  'weworkremotely.source.ts': 'fixed RSS feed URLs, no keyword search',
  'greenhouse.source.ts': 'crawls a fixed company list, filters post-fetch using the passed-in queries param',
  'lever.source.ts': 'crawls a fixed company list, filters post-fetch using the passed-in queries param',
  'ashby.source.ts': 'crawls a fixed company list, filters post-fetch using the passed-in queries param',
  'wttj.source.ts': 'uses the passed-in queries param (profile.search.queries), not its own array',
  'apec.source.ts': 'unregistered legacy file, superseded by apec.playwright.ts',
  'jobat-be.source.ts': 'unregistered legacy file, duplicate of jobat.source.ts',
  'stepstone-be.source.ts': 'unregistered legacy file, never finished/registered',
};

// Matches a hardcoded query-array literal like `SEARCH_QUERIES = ['nodejs', ...]` or
// `QUERIES = ["Node.js", ...]` — the exact shape every source had before the July 13
// 2026 consolidation. A file matching this AND not importing from keywords.ts means a
// new hardcoded query array was introduced instead of using the shared list.
const HARDCODED_ARRAY_PATTERN = /(?:SEARCH_)?QUERIES\s*(?::\s*\w+(?:\[\])?)?\s*=\s*\[\s*['"](?:node|nest|typescript)/i;

describe('keywords.ts consistency', () => {
  const allFiles = readdirSync(SOURCES_DIR).filter(
    (f) => (f.endsWith('.source.ts') || f === 'apec.playwright.ts') && !f.endsWith('.spec.ts'),
  );

  it('found the expected number of source files (sanity check)', () => {
    expect(allFiles.length).toBeGreaterThan(40);
  });

  it.each(allFiles.filter((f) => !(f in EXEMPT_FILES)))(
    '%s imports from keywords.ts rather than declaring its own hardcoded query array',
    (file) => {
      const content = readFileSync(join(SOURCES_DIR, file), 'utf-8');
      const importsFromKeywords = /from ['"]\.\.\/keywords['"]/.test(content);
      const hasHardcodedArray = HARDCODED_ARRAY_PATTERN.test(content);

      // Every migrated file must import from keywords.ts.
      expect(importsFromKeywords).toBe(true);
      // A file that imports from keywords.ts is allowed to also contain a *few* extra
      // literal strings (e.g. stepstone-de.source.ts's two preserved German phrases,
      // spread alongside a keywords.ts import) — what's disallowed is a query array that
      // is ENTIRELY hardcoded literals with no keywords.ts import at all, which is
      // already covered by the importsFromKeywords assertion above. This second check
      // exists purely so a NEW file that copies the old hardcoded-array pattern without
      // ever adding the import fails loudly instead of silently passing.
      if (!importsFromKeywords) {
        expect(hasHardcodedArray).toBe(false);
      }
    },
  );

  it('CORE_KEYWORDS is non-empty', () => {
    expect(CORE_KEYWORDS.length).toBeGreaterThan(0);
  });

  it('CORE_KEYWORDS_MINIMAL is non-empty', () => {
    expect(CORE_KEYWORDS_MINIMAL.length).toBeGreaterThan(0);
  });

  it('FRENCH_KEYWORDS is non-empty', () => {
    expect(FRENCH_KEYWORDS.length).toBeGreaterThan(0);
  });

  it('GERMAN_KEYWORDS is non-empty', () => {
    expect(GERMAN_KEYWORDS.length).toBeGreaterThan(0);
  });

  it('ENGLISH_KEYWORDS is non-empty', () => {
    expect(ENGLISH_KEYWORDS.length).toBeGreaterThan(0);
  });

  it('FRENCH_KEYWORDS is a true subset of CORE_KEYWORDS', () => {
    for (const k of FRENCH_KEYWORDS) expect(CORE_KEYWORDS).toContain(k);
  });

  it('GERMAN_KEYWORDS is a true subset of CORE_KEYWORDS', () => {
    for (const k of GERMAN_KEYWORDS) expect(CORE_KEYWORDS).toContain(k);
  });

  it('ENGLISH_KEYWORDS is a true subset of CORE_KEYWORDS', () => {
    for (const k of ENGLISH_KEYWORDS) expect(CORE_KEYWORDS).toContain(k);
  });

  it('CORE_KEYWORDS_MINIMAL is a true subset of CORE_KEYWORDS', () => {
    for (const k of CORE_KEYWORDS_MINIMAL) expect(CORE_KEYWORDS).toContain(k);
  });

  it('FRENCH_KEYWORDS and GERMAN_KEYWORDS never overlap', () => {
    for (const k of FRENCH_KEYWORDS) expect(GERMAN_KEYWORDS).not.toContain(k);
  });

  it('ENGLISH_KEYWORDS never overlaps FRENCH_KEYWORDS or GERMAN_KEYWORDS', () => {
    for (const k of ENGLISH_KEYWORDS) {
      expect(FRENCH_KEYWORDS).not.toContain(k);
      expect(GERMAN_KEYWORDS).not.toContain(k);
    }
  });

  it('every CORE_KEYWORDS entry is accounted for by exactly one of English/French/German', () => {
    for (const k of CORE_KEYWORDS) {
      const buckets = [ENGLISH_KEYWORDS.includes(k), FRENCH_KEYWORDS.includes(k), GERMAN_KEYWORDS.includes(k)];
      expect(buckets.filter(Boolean).length).toBe(1);
    }
  });
});
