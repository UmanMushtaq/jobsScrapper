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
  // ── Universal English signals (appear in any language job description) ─────
  'english required', 'english is required', 'english mandatory', 'english is mandatory',
  'english is a must', 'english language required', 'english language skills',
  'fluent english', 'fluent in english', 'english fluency',
  'english proficiency', 'proficient in english', 'english communication skills',
  'professional english', 'strong english', 'excellent english', 'good english',
  'strong english skills', 'good english skills', 'very good english skills',
  'good knowledge of english', 'excellent written and spoken english',
  'english speaker', 'english-speaking', 'english speaking', 'english speaking team',
  'native english', 'business english',
  'written and spoken english', 'spoken and written english',
  'strong written and verbal english',
  'b2.*english', 'english.*b2', 'c1.*english', 'english.*c1', 'c2.*english', 'english.*c2',
  'internationally',
  // ── Universal: working language ────────────────────────────────────────────
  'working language.*english', 'working language: english', 'working language is english',
  'language of work: english', 'english.*working language',
  'business language.*english', 'company language.*english', 'team language.*english',
  'we work in english', 'we communicate in english', 'work in english',
  'communicate in english', 'communication in english',
  'meetings in english', 'daily communication in english',
  'team speaks english', 'our team speaks english',
  // ── International team signals (language-neutral) ─────────────────────────
  'international team', 'international environment', 'international company',
  'multicultural', 'multi-cultural', 'multinational',
  'diverse team', 'global team', 'remote-first', 'fully remote',
  'international.*nationalities', 'nationalities.*international',
  'team.*countries', 'countries.*team',

  // ── GERMAN ────────────────────────────────────────────────────────────────
  'englisch ist pflicht', 'englisch erforderlich',
  'englischkenntnisse erforderlich', 'englischkenntnisse',
  'sehr gute englischkenntnisse', 'gute englischkenntnisse',
  'fließende englischkenntnisse', 'fließend.*englisch', 'englisch fließend',
  'englisch verhandlungssicher', 'verhandlungssicheres englisch',
  'englisch.*voraussetzung', 'englisch.*notwendig',
  'unsere arbeitssprache ist englisch', 'arbeitssprache englisch',
  'arbeitssprache.*englisch', 'englisch als arbeitssprache',
  'unternehmenssprache englisch', 'unternehmenssprache ist englisch',
  'firmensprache englisch', 'firmensprache ist englisch',
  'wir arbeiten auf englisch', 'kommunikation auf englisch', 'meetings auf englisch',
  'englischsprachig', 'englischsprachiges umfeld', 'englischsprachiges team',
  'internationales team', 'internationale teams',
  'internationales umfeld', 'internationale umgebung',
  'internationale kollegen', 'internationale zusammenarbeit',
  'internationales unternehmen',
  'multinationales team', 'globales team',
  // english phrases that also appear in German job posts
  'english skills', 'english language', 'english is required',

  // ── DUTCH / FLEMISH ───────────────────────────────────────────────────────
  'internationale omgeving', 'internationaal team', 'internationale samenwerking',
  'voertaal is engels', 'voertaal.*engels',
  'werktaal is engels', 'werktaal.*engels', 'werkvoertaal.*engels',
  'engels is verplicht', 'engelstalig',
  'goede beheersing van het engels', 'goede.*engels',
  'vloeiend engels', 'vlotte.*engels',
  'uitstekende beheersing van het engels',
  'engels vereist', 'engels.*vereist',

  // ── FRENCH ────────────────────────────────────────────────────────────────
  'equipe internationale', 'équipe internationale',
  'environnement international', 'contexte international',
  'entreprise internationale',
  'équipe anglophone', 'environnement anglophone', 'milieu anglophone',
  'langue de travail : anglais', 'langue principale : anglais', 'langue.*anglais',
  'anglais courant', 'anglais obligatoire', 'anglais requis',
  'anglais professionnel requis', 'anglais professionnel', 'anglais technique requis',
  'anglais indispensable', 'anglais.*indispensable',
  'maitrise de l\'anglais', 'maîtrise de l\'anglais',
  'bonne maîtrise de l\'anglais', 'maîtrise.*anglais', 'maitrise.*anglais',
  'bon niveau d\'anglais', 'niveau d\'anglais courant', 'très bon niveau.*anglais',
  'bon anglais', 'très bon anglais', 'aisance en anglais',
  'pratique de l\'anglais',
  'l\'anglais est notre langue de travail', 'nous travaillons en anglais',
  'parler anglais', 'anglais.*courant', 'anglais.*requis', 'anglais.*obligatoire',

  // ── SPANISH ───────────────────────────────────────────────────────────────
  'equipo internacional', 'ambiente internacional', 'entorno internacional',
  'empresa internacional', 'equipo multicultural', 'team internacional',
  'inglés requerido', 'inglés obligatorio', 'inglés fluido', 'inglés avanzado',
  'dominio del inglés', 'nivel de inglés', 'inglés imprescindible',
  'inglés indispensable', 'buen nivel de inglés', 'alto nivel de inglés',
  'inglés como idioma de trabajo', 'idioma de trabajo: inglés',
  'idioma principal: inglés', 'trabajamos en inglés',
  'reuniones en inglés', 'comunicación en inglés',

  // ── ITALIAN ───────────────────────────────────────────────────────────────
  'team internazionale', 'ambiente internazionale', 'contesto internazionale',
  'azienda internazionale',
  'inglese richiesto', 'ottima conoscenza dell\'inglese',
  'buona conoscenza dell\'inglese', 'inglese fluente', 'inglese professionale',
  'inglese obbligatorio', 'inglese indispensabile', 'buon livello di inglese',
  'padronanza dell\'inglese', 'lingua di lavoro: inglese',
  'lavoriamo in inglese', 'comunicazione in inglese', 'riunioni in inglese',

  // ── PORTUGUESE ────────────────────────────────────────────────────────────
  'equipe internacional', 'equipa internacional',
  'ambiente internacional', 'empresa internacional', 'equipa multicultural',
  'inglês necessário', 'inglês obrigatório', 'inglês fluente',
  'bom nível de inglês', 'inglês avançado', 'domínio do inglês',
  'inglês imprescindível', 'idioma de trabalho: inglês',
  'trabalhamos em inglês', 'comunicação em inglês', 'time internacional',

  // ── SWEDISH ───────────────────────────────────────────────────────────────
  'internationellt team', 'internationell miljö', 'internationellt företag',
  'engelska krävs', 'flytande engelska', 'goda kunskaper i engelska',
  'mycket goda kunskaper i engelska', 'engelska som arbetsspråk',
  'arbetsspråk: engelska', 'vi jobbar på engelska', 'möten på engelska',

  // ── POLISH ────────────────────────────────────────────────────────────────
  'międzynarodowy zespół', 'środowisko międzynarodowe', 'firma międzynarodowa',
  'znajomość języka angielskiego', 'język angielski wymagany',
  'biegła znajomość języka angielskiego', 'dobra znajomość języka angielskiego',
  'angielski obowiązkowy', 'język pracy: angielski', 'pracujemy w języku angielskim',

  // ── DANISH ────────────────────────────────────────────────────────────────
  'internationalt team', 'internationalt miljø', 'internationalt selskab',
  'engelsk påkrævet', 'flydende engelsk', 'gode engelskkundskaber',
  'arbejdssprog: engelsk', 'vi arbejder på engelsk',

  // ── NORWEGIAN ─────────────────────────────────────────────────────────────
  'internasjonalt team', 'internasjonalt miljø', 'internasjonalt selskap',
  'engelsk påkrevet', 'flytende engelsk', 'gode engelskkunnskaper',
  'arbeidsspråk: engelsk', 'vi jobber på engelsk',
];

export function hasEnglishTeamSignals(txt: string): boolean {
  return ENGLISH_TEAM_SIGNALS.some((s) => {
    try { return new RegExp(s, 'i').test(txt); } catch { return txt.includes(s); }
  });
}
export function detectLanguage(raw: string): string {
  const text = raw.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length || 1;

  // Count French-specific accented chars (not shared with German). ü is deliberately
  // excluded here — it's a German umlaut, not a French letter (German words like "für",
  // "grün", "Büro" were previously miscounted as French accent signals, misclassifying
  // short German descriptions as French — fixed in the Germany-coverage pass, July 12 2026).
  const frAccents = (text.match(/[àâéèêëîïôùûçœæ]/g) ?? []).length;
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
