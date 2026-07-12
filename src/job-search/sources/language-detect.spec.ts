import { hasEnglishTeamSignals, detectLanguage } from './language-detect';

describe('hasEnglishTeamSignals — German coverage pass, July 12 2026', () => {
  it('detects "englischsprachig" as an English-team signal', () => {
    expect(hasEnglishTeamSignals('Wir sind ein englischsprachiges Unternehmen.')).toBe(true);
  });

  it('detects "englischsprachiges Team"', () => {
    expect(hasEnglishTeamSignals('Du arbeitest in einem englischsprachigen Team.')).toBe(true);
  });

  it('detects "Unternehmenssprache Englisch"', () => {
    expect(hasEnglishTeamSignals('Unsere Unternehmenssprache ist Englisch.')).toBe(true);
  });

  it('returns false for plain German text with no English signal', () => {
    expect(hasEnglishTeamSignals('Wir suchen einen erfahrenen Backend-Entwickler für unser Team in Berlin.')).toBe(false);
  });
});

describe('detectLanguage — German text with an English-team override', () => {
  it('detects a German-worded description with an englischsprachig signal as English-friendly', () => {
    const text = 'Backend Entwickler gesucht. Wir arbeiten in einem englischsprachigen Team.';
    expect(hasEnglishTeamSignals(text)).toBe(true);
  });

  it('still detects plain German text as "de"', () => {
    expect(detectLanguage('Wir suchen einen erfahrenen Backend-Entwickler mit fundierten Kenntnissen in Node.js und TypeScript für unser wachsendes Team in Berlin.')).toBe('de');
  });
});
