import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allSources } from './run';
import { JobSource } from './sources/registry';

// Guards against the exact bug found in the July 12 2026 registry audit: jooble.source.ts
// and englishjobs-de.source.ts existed on disk, worked correctly, and were even listed in
// ACTIVE_SOURCES/FAST_SOURCES — but were never added to a couple of the dashboard's
// separate hand-maintained country-tag lists, making them invisible on the Germany view
// despite running successfully every scan. This test targets the more fundamental version
// of that failure mode: a scraper file that exists on disk but was never added to
// `allSources` in run.ts at all, so it never runs in the first place.
const SOURCES_DIR = join(__dirname, 'sources');

// Legacy files that intentionally have no live registration — superseded by another
// source, or never finished. Not part of this test's concern; a new file should never be
// added to this list without a comment explaining why it's exempt.
const KNOWN_UNREGISTERED = new Set([
  'apec.source.ts', // superseded by apec.playwright.ts (ApecPlaywrightSource)
  'jobat-be.source.ts', // duplicate of jobat.source.ts (JobatSource) — same source name
  'stepstone-be.source.ts', // Belgium StepStone — never finished/registered
]);

function isJobSourceExport(value: unknown): value is new () => JobSource {
  if (typeof value !== 'function') return false;
  try {
    const instance = new (value as new () => unknown)() as Partial<JobSource>;
    return typeof instance.name === 'string' && typeof instance.fetch === 'function';
  } catch {
    return false;
  }
}

describe('source registry completeness', () => {
  const registeredNames = new Set(allSources.map((s) => s.name));

  const sourceFiles = readdirSync(SOURCES_DIR).filter(
    (f) => f.endsWith('.source.ts') && !f.endsWith('.spec.ts') && !KNOWN_UNREGISTERED.has(f),
  );

  it('found at least the expected number of source files (sanity check the glob itself works)', () => {
    expect(sourceFiles.length).toBeGreaterThan(40);
  });

  it.each(sourceFiles)('%s is registered in run.ts\'s allSources', (file) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(join(SOURCES_DIR, file)) as Record<string, unknown>;
    const exportedClasses = Object.values(mod).filter(isJobSourceExport);

    expect(exportedClasses.length).toBeGreaterThan(0);

    for (const Cls of exportedClasses) {
      const instance = new Cls();
      expect(registeredNames.has(instance.name)).toBe(true);
    }
  });

  it('every allSources entry has a non-empty name and fetch function', () => {
    for (const source of allSources) {
      expect(typeof source.name).toBe('string');
      expect(source.name.length).toBeGreaterThan(0);
      expect(typeof source.fetch).toBe('function');
    }
  });
});
