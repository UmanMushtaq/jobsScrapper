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
