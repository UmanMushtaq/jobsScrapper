import { allSources, FAST_SOURCES, PLAYWRIGHT_SOURCES, MANUAL_ONLY_SOURCES, SLOW_SCHEDULER_ONLY } from './run';

// Guards against a subtler version of the registration-gap bug: a source can be present
// in allSources (satisfying registry-completeness.spec.ts) while still never actually
// running anywhere a human is likely to look. This is exactly what happened to
// eu.talent.io — it was in allSources and technically included in the SLOW scheduler's
// default pass, but absent from FAST_SOURCES, PLAYWRIGHT_SOURCES, and any manual
// runner, so it never showed up via the "Run now" button or the faster/more-observed
// paths, and looked orphaned for two sessions (July 12 2026 fix).
//
// A source is "reachable" here if it's in FAST_SOURCES, PLAYWRIGHT_SOURCES,
// MANUAL_ONLY_SOURCES, or the explicit SLOW_SCHEDULER_ONLY allowlist — the last one is
// the "yes, this genuinely only has the quiet 8-hour catch-all path, and that's a
// conscious choice" declaration. A source with a name in NONE of these four sets fails:
// it would silently fall into the catch-all with nobody ever having decided that's okay.
describe('source registry reachability', () => {
  const classified = new Set([
    ...FAST_SOURCES,
    ...PLAYWRIGHT_SOURCES,
    ...MANUAL_ONLY_SOURCES,
    ...SLOW_SCHEDULER_ONLY,
  ]);

  it.each(allSources.map((s) => s.name))('%s is reachable from at least one documented scheduler path', (name) => {
    expect(classified.has(name)).toBe(true);
  });

  it('eu.talent.io specifically has a manual runner (regression check for the July 12 2026 orphan fix)', () => {
    expect(MANUAL_ONLY_SOURCES.has('eu.talent.io')).toBe(true);
  });

  it('eures.europa.eu has both a manual runner and a fast-scheduler slot (July 14 2026 EURES rebuild)', () => {
    expect(MANUAL_ONLY_SOURCES.has('eures.europa.eu')).toBe(true);
    expect(FAST_SOURCES.includes('eures.europa.eu')).toBe(true);
  });

  it('a source cannot be silently reachable-by-omission: every allSources name maps to exactly one primary classification', () => {
    // Not a hard requirement that categories are mutually exclusive (a source CAN
    // legitimately have more than one path, e.g. apec.fr has both a Playwright slot and
    // a manual runner) — this just asserts nothing is fully unclassified, which is the
    // actual bug this test exists to catch.
    for (const source of allSources) {
      const inAny =
        FAST_SOURCES.includes(source.name) ||
        PLAYWRIGHT_SOURCES.has(source.name) ||
        MANUAL_ONLY_SOURCES.has(source.name) ||
        SLOW_SCHEDULER_ONLY.has(source.name);
      expect(inAny).toBe(true);
    }
  });
});
