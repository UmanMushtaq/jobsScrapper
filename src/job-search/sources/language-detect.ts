/**
 * Detects whether text is English, French, or German.
 *
 * Strategy (most reliable first):
 * 1. Accented character ratio — French and German text always has high
 *    density of é, è, à, â, ç, ä, ö, ü, ß etc. English almost never does.
 * 2. Keyword scoring — count language-specific phrases as a secondary signal.
 *
 * Returns 'en', 'fr', or 'de'.
 */
export function detectLanguage(raw: string): string {
  const text = raw.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length || 1;

  // Count French-specific accented chars (not shared with German)
  const frAccents = (text.match(/[àâéèêëîïôùûüçœæ]/g) ?? []).length;
  // Count German-specific chars
  const deAccents = (text.match(/[äöüß]/g) ?? []).length;

  const frRatio = frAccents / words;
  const deRatio = deAccents / words;

  // More than ~2 accented chars per 100 words is a strong non-English signal
  if (frRatio > 0.02 || frAccents > 5) return 'fr';
  if (deRatio > 0.02 || deAccents > 5) return 'de';

  // Secondary: keyword scoring
  const frKeywords = [
    'rejoignez', 'nous recherchons', 'vous serez', 'vos missions',
    'votre profil', 'profil recherché', 'rémunération', 'poste',
    'entreprise', 'développeur', 'ingénieur', 'expérience', 'compétences',
    'télétravail', 'candidature', 'nous vous', 'dans le cadre',
  ];
  const deKeywords = [
    'wir suchen', 'ihre aufgaben', 'ihr profil', 'was wir bieten',
    'kenntnisse', 'entwickler', 'berufserfahrung', 'standort',
    'vollzeit', 'festanstellung', 'deutschkenntnisse',
  ];
  const enKeywords = [
    'we are looking', 'you will', 'requirements', 'responsibilities',
    'join our', 'we offer', 'about us', 'must have', 'nice to have',
    'experience with', 'what you', 'the role', 'ideal candidate',
  ];

  const frScore = frKeywords.filter((k) => text.includes(k)).length;
  const deScore = deKeywords.filter((k) => text.includes(k)).length;
  const enScore = enKeywords.filter((k) => text.includes(k)).length;

  if (frScore > enScore || deScore > enScore) return frScore >= deScore ? 'fr' : 'de';
  return 'en';
}
