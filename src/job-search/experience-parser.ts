// Extracts a stated minimum years-of-experience requirement from free-text JD content, in
// English, French, or German — the JD-body case, which is most sources (Adzuna, LinkedIn,
// Welcome to the Jungle, etc. don't expose a structured experience field). Shared by
// matcher.ts (the hard->5-year-cap reject) and any source with EN/FR/German descriptions
// that also wants a first-pass structured experienceLevelMinimum (e.g. eures.source.ts).
const YEAR_UNIT = String.raw`(?:years?|yrs?|ann[ée]es?|ans|jahre?)`;
const EXPERIENCE_KEYWORD = String.raw`(?:experience|exp[ée]rience|berufserfahrung|erfahrung)`;

/**
 * Extracts the MINIMUM required years of experience stated in text, in English, French,
 * or German. For a range ("5 à 10 ans", "5 to 10 years", "5 bis 10 Jahre") the LOWER
 * bound is what's actually required — the upper bound is just a nice-to-have ceiling —
 * so that's what's returned. Returns null when no requirement is found in text.
 */
export function extractRequiredMinimumYears(text: string): number | null {
  // "5 to 10 years" / "5-10 ans" / "5 à 10 ans" / "5 bis 10 Jahre"
  const range = text.match(new RegExp(String.raw`(\d{1,2})\s*(?:to|-|–|à|bis)\s*\d{1,2}\s*${YEAR_UNIT}`, 'i'));
  if (range) return parseInt(range[1], 10);

  // "6+ years" / "7+ ans" / "8+ Jahre"
  const plus = text.match(new RegExp(String.raw`(\d{1,2})\+\s*${YEAR_UNIT}`, 'i'));
  if (plus) return parseInt(plus[1], 10);

  // "minimum 6 years" / "minimum of 6 years" / "at least 6 years" / "au moins 6 ans" /
  // "mindestens 6 Jahre" — an optional filler word ("of"/"de") between the minimum-phrase
  // and the number covers "minimum of X years" specifically.
  const minPhrase = text.match(new RegExp(
    String.raw`(?:minimum|at\s+least|au\s+moins|minimum\s+de|mindestens)\s*(?:of\s+|de\s+)?(\d{1,2})\s*${YEAR_UNIT}`, 'i',
  ));
  if (minPhrase) return parseInt(minPhrase[1], 10);

  // General "X years/ans/Jahre" near an experience keyword, either order — catches
  // "6 years of experience", "7 Jahre Berufserfahrung"/"7 Jahre Erfahrung", "6 ans
  // d'expérience minimum requis", "expérience confirmée de 5 ans".
  const near = text.match(new RegExp(
    String.raw`(\d{1,2})\s*${YEAR_UNIT}[^.]{0,40}?${EXPERIENCE_KEYWORD}|${EXPERIENCE_KEYWORD}[^.]{0,40}?(\d{1,2})\s*${YEAR_UNIT}`,
    'i',
  ));
  if (near) return parseInt(near[1] ?? near[2], 10);

  return null;
}
