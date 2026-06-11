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

const ENGLISH_TEAM_SIGNALS = [
  // ── English: proficiency / requirement ────────────────────────────────────
  'english required', 'english is required', 'english mandatory', 'english is mandatory',
  'english is a must', 'english language required', 'english language skills',
  'fluent english', 'fluent in english', 'english fluency',
  'english proficiency', 'proficient in english',
  'professional english', 'strong english', 'excellent english', 'good english',
  'english speaker', 'english-speaking', 'english speaking',
  'native english', 'business english',
  'written and spoken english', 'spoken and written english',
  'strong written and verbal english',
  'b2.*english', 'english.*b2', 'c1.*english', 'english.*c1', 'c2.*english', 'english.*c2',
  'internationally',
  // ── English: working/company language ─────────────────────────────────────
  'working language.*english', 'english.*working language',
  'business language.*english', 'company language.*english', 'team language.*english',
  'we work in english', 'work in english',
  'communicate in english', 'communication in english',
  'meetings in english', 'daily communication in english',
  'team speaks english', 'our team speaks english',
  // ── French signals ─────────────────────────────────────────────────────────
  'équipe anglophone', 'environnement anglophone', 'milieu anglophone',
  'equipe internationale', 'équipe internationale',
  'environnement international', 'contexte international',
  'entreprise internationale',
  'langue.*anglais', 'anglais.*courant', 'anglais.*requis',
  'maîtrise.*anglais', 'maitrise.*anglais',
  'parler anglais', 'anglais.*obligatoire', 'anglais.*indispensable',
  'très bon niveau.*anglais', 'bon niveau.*anglais',
  'nous travaillons en anglais', 'anglais est notre langue de travail',
  // ── Dutch/Flemish signals ──────────────────────────────────────────────────
  'engelstalig',
  'voertaal.*engels', 'werktaal.*engels', 'werkvoertaal.*engels',
  'engels.*vereist', 'engels is verplicht',
  'goede.*engels', 'vlotte.*engels', 'vloeiend engels',
  'uitstekende beheersing van het engels',
  'internationale omgeving', 'internationaal team', 'internationale samenwerking',
  // ── German signals ─────────────────────────────────────────────────────────
  'englischkenntnisse', 'englisch.*voraussetzung',
  'arbeitssprache.*englisch', 'englisch als arbeitssprache',
  'fließend.*englisch', 'englisch fließend',
  'englisch verhandlungssicher', 'verhandlungssicheres englisch',
  'sehr gute.*englischkenntnisse', 'gute englischkenntnisse',
  'englisch erforderlich', 'englisch ist.*pflicht', 'englisch.*notwendig',
  'unternehmenssprache englisch', 'firmensprache englisch', 'firmensprache ist englisch',
  'wir arbeiten auf englisch', 'kommunikation auf englisch', 'meetings auf englisch',
  'unsere arbeitssprache ist englisch',
  // ── International team signals (language-neutral) ─────────────────────────
  'international team', 'international environment', 'international company',
  'multicultural', 'multi-cultural', 'multinational',
  'diverse team', 'global team', 'globales team', 'remote-first', 'fully remote',
  'internationales team', 'internationale teams',
  'internationales umfeld', 'internationale umgebung',
  'internationale kollegen', 'internationale zusammenarbeit',
  'internationales unternehmen',
  'international.*nationalities', 'nationalities.*international',
  'team.*countries', 'countries.*team',
];

export function hasEnglishTeamSignals(txt: string): boolean {
  return ENGLISH_TEAM_SIGNALS.some((s) => {
    try { return new RegExp(s, 'i').test(txt); } catch { return txt.includes(s); }
  });
}
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
