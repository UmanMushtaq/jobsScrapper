// Canonical search-query keyword set, shared by every source that performs
// per-keyword search-string queries against its API/site (as opposed to sources that
// crawl a fixed feed/page and filter post-fetch — those use their own relevance-keyword
// lists in shared-scraper.ts / their own file, which is a different concern).
//
// Centralized July 13 2026 to fix inconsistent recall across sources: some sources tried
// 8-11 query variants including localized terms, others tried only 2-3 bare English
// spellings, so the same real job could be found by one source and missed by another
// purely because of query-string differences, not actual relevance. See the July 13 2026
// keyword-consolidation report for the full per-source audit this list was built from.
//
// Casing/spacing variants are preserved deliberately, not collapsed — some sites' search
// behaves differently on an exact-match vs. fuzzy basis, so "node js" and "Node JS" are
// both kept even though they normalize to the same thing semantically.
export const CORE_KEYWORDS = [
  // Node.js variants
  'Node.js',
  'NodeJS',
  'Node JS',
  'node.js',
  'nodejs',
  'node js',

  // NestJS variants
  'NestJS',
  'Nest.js',
  'Nest JS',
  'nestjs',
  'nest.js',
  'nest js',

  // TypeScript backend combinations
  'TypeScript backend',
  'TypeScript Node.js',
  'Backend TypeScript',
  'TypeScript',

  // Generic backend engineer terms (English)
  'Backend Engineer',
  'Backend Developer',
  'Backend Node',

  // French localized (for France-based sources: APEC, France Travail, HelloWork,
  // Cadremploi) — France Travail's own comment notes its search index is French-first
  // and English tech terms often return 0 results, hence the deliberately wide net here.
  'développeur nodejs',
  'développeur Node.js',
  'développeur backend',
  'développeur typescript',
  'développeur nestjs',
  'ingénieur backend nodejs',
  'ingénieur Node.js',

  // German localized (for German sources: Arbeitsagentur, Jobware, etc.)
  'Node.js Entwickler',
  'Backend Entwickler',
  'NestJS Entwickler',
];

// Reduced set for rate-limited or pay-per-query sources (Jooble's paid API, any
// ScraperAPI-metered source like StepStone/Xing where each query variant consumes a
// counted request against a 100/day-per-key budget) — the highest-signal subset only.
export const CORE_KEYWORDS_MINIMAL = [
  'Node.js',
  'NestJS',
  'TypeScript backend',
];

// Localized subsets, derived from CORE_KEYWORDS by filter (not maintained separately) so
// they can never silently diverge from the canonical list — see
// keywords-consistency.spec.ts, which asserts these stay true subsets.
export const FRENCH_KEYWORDS = CORE_KEYWORDS.filter((k) => /développeur|ingénieur/.test(k));
export const GERMAN_KEYWORDS = CORE_KEYWORDS.filter((k) => /Entwickler/.test(k));
export const ENGLISH_KEYWORDS = CORE_KEYWORDS.filter(
  (k) => !FRENCH_KEYWORDS.includes(k) && !GERMAN_KEYWORDS.includes(k),
);
