import { extractRequiredMinimumYears } from './experience-parser';

describe('extractRequiredMinimumYears — real examples from the July 2026 review session', () => {
  it('extracts 6 from "Around 6+ years of experience" (Air Apps)', () => {
    expect(extractRequiredMinimumYears('Around 6+ years of experience')).toBe(6);
  });

  it('extracts 5 from "5+ years professional software engineering experience" (Avenga)', () => {
    expect(extractRequiredMinimumYears('5+ years professional software engineering experience')).toBe(5);
  });

  it('extracts 5 from "5 à 10 ans d\'expérience"', () => {
    expect(extractRequiredMinimumYears("5 à 10 ans d'expérience")).toBe(5);
  });

  it('extracts 5 from "Deep Backend Expertise: 5+ years of commercial web development experience" (LionHires)', () => {
    expect(extractRequiredMinimumYears('Deep Backend Expertise: 5+ years of commercial web development experience')).toBe(5);
  });

  it('extracts 5 from "You justify solid experience of 5 years minimum" (Dougs, English)', () => {
    expect(extractRequiredMinimumYears('You justify solid experience of 5 years minimum')).toBe(5);
  });

  it('extracts 5 from "solide expérience de 5 ans minimum" (Dougs, French)', () => {
    expect(extractRequiredMinimumYears('solide expérience de 5 ans minimum')).toBe(5);
  });

  it('extracts 7 from "7 Jahre Berufserfahrung"', () => {
    expect(extractRequiredMinimumYears('7 Jahre Berufserfahrung')).toBe(7);
  });
});

describe('extractRequiredMinimumYears — additional EN/FR/DE pattern coverage', () => {
  it('extracts 6 from "minimum of 6 years experience required" (filler word between minimum and number)', () => {
    expect(extractRequiredMinimumYears('minimum of 6 years experience required')).toBe(6);
  });

  it('extracts 6 from "at least 6 years of experience"', () => {
    expect(extractRequiredMinimumYears('at least 6 years of experience')).toBe(6);
  });

  it('extracts 6 from "mindestens 6 Jahre"', () => {
    expect(extractRequiredMinimumYears('mindestens 6 Jahre')).toBe(6);
  });

  it('extracts 7 from bare "7 Jahre Erfahrung" (no Berufs- prefix)', () => {
    expect(extractRequiredMinimumYears('7 Jahre Erfahrung')).toBe(7);
  });

  it('extracts 5 from "expérience confirmée de 5 ans"', () => {
    expect(extractRequiredMinimumYears('expérience confirmée de 5 ans')).toBe(5);
  });

  it('extracts 5 from "5-10 years experience" (English range, lower bound)', () => {
    expect(extractRequiredMinimumYears('5-10 years experience')).toBe(5);
  });

  it('returns null when no experience requirement is stated', () => {
    expect(extractRequiredMinimumYears('Node.js backend engineer building REST APIs.')).toBeNull();
  });
});

describe('extractRequiredMinimumYears — German coverage pass, July 12 2026', () => {
  it('extracts 7 from the abbreviated "mind. 7 Jahre" form', () => {
    expect(extractRequiredMinimumYears('mind. 7 Jahre Berufserfahrung')).toBe(7);
  });

  it('extracts 7 from "mind. 7 Jahre" without a trailing "Berufserfahrung"', () => {
    expect(extractRequiredMinimumYears('mind. 7 Jahre')).toBe(7);
  });

  it('extracts 6 from "6+ Jahre Berufserfahrung"', () => {
    expect(extractRequiredMinimumYears('6+ Jahre Berufserfahrung')).toBe(6);
  });

  it('extracts 5 from "5-10 Jahre" (German range, lower bound)', () => {
    expect(extractRequiredMinimumYears('5-10 Jahre Erfahrung')).toBe(5);
  });

  it('extracts 5 from "5+ Jahre"', () => {
    expect(extractRequiredMinimumYears('5+ Jahre Erfahrung im Backend-Bereich')).toBe(5);
  });
});
