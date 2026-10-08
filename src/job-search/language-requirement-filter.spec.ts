import {
  detectPostingLanguage,
  detectRequiredLanguagePhrase,
  evaluateLanguageRequirement,
  evaluatePostingLanguage,
  hasEnglishSignal,
  LOCAL_LANGUAGE_REQUIRED,
  NO_ENGLISH_SIGNAL,
} from './language-requirement-filter';

describe('evaluateLanguageRequirement — structured field', () => {
  it('rejects Dutch required at B1', () => {
    const result = evaluateLanguageRequirement([{ code: 'nl', level: 'B1' }], 'We build backend APIs.');
    expect(result.reject).toBe(true);
    expect(result.reason).toMatch(/NL/);
  });

  it('accepts English required at B2 only', () => {
    const result = evaluateLanguageRequirement([{ code: 'en', level: 'B2' }], 'We build backend APIs.');
    expect(result.reject).toBe(false);
  });

  it('accepts when the requiredLanguages field is absent', () => {
    const result = evaluateLanguageRequirement(undefined, 'We build backend APIs.');
    expect(result.reject).toBe(false);
    expect(result.note).toBeNull();
  });

  it('accepts when requiredLanguages is empty', () => {
    const result = evaluateLanguageRequirement([], 'We build backend APIs.');
    expect(result.reject).toBe(false);
  });

  it('does not reject French A1 — below the B1 threshold — but notes it', () => {
    const result = evaluateLanguageRequirement([{ code: 'fr', level: 'A1' }], 'We build backend APIs.');
    expect(result.reject).toBe(false);
    expect(result.note).toContain('FR');
  });

  it('does not reject a language marked optional/asset regardless of level', () => {
    const result = evaluateLanguageRequirement([{ code: 'de', level: 'C1', required: false }], 'We build backend APIs.');
    expect(result.reject).toBe(false);
  });

  it('rejects French required at B1 (candidate is only A1 in French)', () => {
    const result = evaluateLanguageRequirement([{ code: 'fr', level: 'B1' }], 'We build backend APIs.');
    expect(result.reject).toBe(true);
  });
});

describe('evaluateLanguageRequirement — free-text requirement-phrase heuristic', () => {
  it('rejects "French required" phrasing', () => {
    const result = evaluateLanguageRequirement(null, 'Backend role. French required for client meetings.');
    expect(result.reject).toBe(true);
  });

  it('rejects "vous parlez français"', () => {
    const result = evaluateLanguageRequirement(null, 'Poste backend. Vous parlez français couramment.');
    expect(result.reject).toBe(true);
  });

  it('rejects "Nederlands vereist"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend developer. Nederlands vereist voor dagelijks contact.');
    expect(result.reject).toBe(true);
  });

  it('rejects "Deutschkenntnisse erforderlich"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend Entwickler gesucht. Sehr gute Deutschkenntnisse erforderlich.');
    expect(result.reject).toBe(true);
  });

  it('does NOT reject a French-language JD that has no stated French requirement', () => {
    const description =
      'Nous recherchons un développeur backend Node.js. Vous rejoindrez une équipe internationale ' +
      'travaillant principalement en anglais sur des microservices.';
    const result = evaluateLanguageRequirement(null, description);
    expect(result.reject).toBe(false);
  });

  it('detectRequiredLanguagePhrase returns null on plain English text', () => {
    expect(detectRequiredLanguagePhrase('We are hiring a backend engineer with Node.js experience.')).toBeNull();
  });
});

describe('evaluateLanguageRequirement — July 8 2026 pattern additions', () => {
  it('rejects "verhandlungssichere Deutschkenntnisse"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend Entwickler. Verhandlungssichere Deutschkenntnisse.');
    expect(result.reject).toBe(true);
  });

  it('rejects "Deutschkenntnisse in Wort und Schrift"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend role. Deutschkenntnisse in Wort und Schrift erforderlich.');
    expect(result.reject).toBe(true);
  });

  it('rejects "Deutsch C1"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend Entwickler gesucht. Deutsch C1 erwartet.');
    expect(result.reject).toBe(true);
  });

  it('rejects "fließendes Deutsch"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend role. Fließendes Deutsch wird vorausgesetzt.');
    expect(result.reject).toBe(true);
  });

  it('rejects "French C1 required"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend role. French C1 required for this position.');
    expect(result.reject).toBe(true);
  });

  it('rejects "parfaitement francophone"', () => {
    const result = evaluateLanguageRequirement(null, 'Poste backend. Vous devez être parfaitement francophone.');
    expect(result.reject).toBe(true);
  });

  it('rejects "je spreekt Nederlands"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend developer. Je spreekt Nederlands vloeiend.');
    expect(result.reject).toBe(true);
  });

  it('does NOT reject a French-language JD without any of the new requirement phrases', () => {
    const description =
      'Poste de développeur backend Node.js et TypeScript, au sein d\'une équipe internationale ' +
      'travaillant principalement en anglais. Stack : NestJS, PostgreSQL, Docker.';
    const result = evaluateLanguageRequirement(null, description);
    expect(result.reject).toBe(false);
  });
});

describe('evaluateLanguageRequirement — German coverage pass, July 12 2026', () => {
  it('rejects "Deutsch in Wort und Schrift" (without the "-kenntnisse" prefix)', () => {
    const result = evaluateLanguageRequirement(null, 'Backend Entwickler gesucht. Deutsch in Wort und Schrift wird vorausgesetzt.');
    expect(result.reject).toBe(true);
  });

  it('rejects "Deutschkenntnisse auf C1-Niveau"', () => {
    const result = evaluateLanguageRequirement(null, 'Backend role. Deutschkenntnisse auf C1-Niveau erforderlich.');
    expect(result.reject).toBe(true);
  });

  it('rejects "Deutschkenntnisse auf B2 Niveau" (no hyphen)', () => {
    const result = evaluateLanguageRequirement(null, 'Backend role. Deutschkenntnisse auf B2 Niveau sind Voraussetzung.');
    expect(result.reject).toBe(true);
  });
});

// ── Final rule set: local-language-required / no-english-signal / language-unclear ──

const FR_NO_SIGNAL =
  'Nous recherchons un développeur backend Node.js pour rejoindre notre équipe à Paris. ' +
  'Vous serez en charge de la conception des API et des microservices avec NestJS. ' +
  'Vous travaillerez avec les équipes produit et vous participerez aux choix techniques. ' +
  'Le poste est basé à Paris avec deux jours de télétravail par semaine.';
const FR_WITH_SIGNAL = `${FR_NO_SIGNAL} Vous rejoindrez une équipe internationale et la langue de travail est l'anglais.`;
const DE_NO_SIGNAL =
  'Wir suchen einen Backend Entwickler für unser Team in Berlin. Du entwickelst die APIs und ' +
  'Microservices mit Node.js und TypeScript. Du arbeitest eng mit dem Produktteam zusammen und ' +
  'bist für die Qualität der Software mit verantwortlich. Wir bieten dir ein modernes Büro und ' +
  'flexible Arbeitszeiten.';
const DE_WITH_SIGNAL = `${DE_NO_SIGNAL} Unsere Arbeitssprache ist Englisch.`;
const EN_POSTING =
  'We are looking for a backend engineer to join our team. You will design and build the APIs ' +
  'and microservices that power our platform, working with Node.js, TypeScript and PostgreSQL. ' +
  'You will work closely with the product team and own the quality of what you ship.';

describe('detectPostingLanguage', () => {
  it('reads an English posting as English', () => {
    expect(detectPostingLanguage(EN_POSTING).language).toBe('en');
  });

  it.each([
    ['French', FR_NO_SIGNAL, 'fr'],
    ['German', DE_NO_SIGNAL, 'de'],
    ['Dutch', 'Wij zoeken een backend developer voor ons team in Amsterdam. Je bouwt de API en de microservices met Node.js en je werkt samen met het productteam. Wat wij bieden is een goed salaris en ook een fijne werkplek.', 'nl'],
    ['Swedish', 'Vi söker en backendutvecklare till vårt team i Stockholm. Du kommer att bygga våra API och tjänster med Node.js och du har erfarenhet av TypeScript. Det är en roll för dig som gillar att ta ansvar för kvalitet och som vill utvecklas med oss.', 'sv'],
    ['Finnish', 'Haemme backend-kehittäjää tiimiimme Helsinkiin. Olet kokenut Node.js ja TypeScript osaaja ja haluat kehittää palveluita kanssa meidän tiimin. Tarjoamme sinulle hyvät työehdot ja myös joustavan työajan, kun olet valmis tekemään tämä työ meillä.', 'fi'],
  ])('reads a %s posting as local', (_name, text, code) => {
    expect(detectPostingLanguage(text)).toEqual({ language: 'local', localCode: code });
  });

  it('is unclear for a short snippet', () => {
    expect(detectPostingLanguage('Node.js, TypeScript, NestJS, PostgreSQL').language).toBe('unclear');
  });

  it('is unclear for a half-English, half-German posting', () => {
    expect(detectPostingLanguage(`${EN_POSTING} ${DE_NO_SIGNAL}`).language).toBe('unclear');
  });
});

describe('hasEnglishSignal', () => {
  it.each([
    'Good English is required',
    'Sehr gute Englischkenntnisse',
    'Anglais courant',
    'Goede beheersing van het Engels',
    'Goda kunskaper i engelska',
    'Gode engelskkundskaber',
    'Englannin kielen taito',
    'The working language is English',
    'You join an international team',
  ])('finds "%s"', (text) => {
    expect(hasEnglishSignal(text)).toBe(true);
  });

  it('finds nothing in a plain German posting', () => {
    expect(hasEnglishSignal(DE_NO_SIGNAL)).toBe(false);
  });
});

describe('evaluatePostingLanguage — rule 1: local language required', () => {
  it.each([
    'Fluent German is required for this role.',
    'Deutsch fließend in Wort und Schrift.',
    'Sehr gute Deutschkenntnisse.',
    'Verhandlungssicheres Deutsch.',
    'Maîtrise du français indispensable.',
    'Français courant.',
    'Vloeiend Nederlands.',
    'Flytande svenska.',
    'Flydende dansk.',
    'Flytende norsk.',
    'Erinomainen suomen kielen taito.',
  ])('rejects "%s" as local-language-required, even in an English posting', (phrase) => {
    const result = evaluatePostingLanguage(null, `${EN_POSTING} ${phrase}`);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe(LOCAL_LANGUAGE_REQUIRED);
  });

  it.each([
    'Fluent German is a plus.',
    'Fluent German is nice to have.',
    'Fließende Deutschkenntnisse sind von Vorteil.',
    'Sehr gute Deutschkenntnisse sind ein Plus.',
    'Le français courant est un plus.',
    'Nice to have:\n- Flytande svenska',
  ])('keeps "%s" (marked optional)', (phrase) => {
    const result = evaluatePostingLanguage(null, `${EN_POSTING} ${phrase}`);
    expect(result.decision).toBe('keep');
  });

  it('a requirements heading after a nice-to-have list still rejects', () => {
    const result = evaluatePostingLanguage(null, `${EN_POSTING}\nNice to have: Kafka\nRequirements:\n- Fluent German`);
    expect(result.reason).toBe(LOCAL_LANGUAGE_REQUIRED);
  });

  it('rejects a structured B2 requirement with the same reason', () => {
    const result = evaluatePostingLanguage([{ code: 'de', level: 'B2' }], EN_POSTING);
    expect(result.reason).toBe(LOCAL_LANGUAGE_REQUIRED);
  });
});

describe('evaluatePostingLanguage — rules 2-4', () => {
  it('rejects a French posting with no English signal (no-english-signal)', () => {
    const result = evaluatePostingLanguage(null, FR_NO_SIGNAL);
    expect(result).toMatchObject({ decision: 'reject', reason: NO_ENGLISH_SIGNAL });
  });

  it('keeps a French posting with an English signal', () => {
    expect(evaluatePostingLanguage(null, FR_WITH_SIGNAL).decision).toBe('keep');
  });

  it('rejects a German posting with no English signal (no-english-signal)', () => {
    const result = evaluatePostingLanguage(null, DE_NO_SIGNAL);
    expect(result).toMatchObject({ decision: 'reject', reason: NO_ENGLISH_SIGNAL });
  });

  it('keeps a German posting that says the working language is English', () => {
    expect(evaluatePostingLanguage(null, DE_WITH_SIGNAL).decision).toBe('keep');
  });

  it('keeps an English posting with no local-language requirement', () => {
    expect(evaluatePostingLanguage(null, EN_POSTING)).toMatchObject({ decision: 'keep', reason: null });
  });

  it('marks an empty or very short description as unclear (kept)', () => {
    expect(evaluatePostingLanguage(null, '').decision).toBe('unclear');
    expect(evaluatePostingLanguage(null, 'Node.js backend').decision).toBe('unclear');
  });
});
