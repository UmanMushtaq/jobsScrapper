import { evaluateLanguageRequirement, detectRequiredLanguagePhrase } from './language-requirement-filter';

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
