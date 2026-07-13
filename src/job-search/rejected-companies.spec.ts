import { REJECTED_COMPANIES, isRejectedCompany, normalizeCompanyName } from './rejected-companies';

describe('rejected-companies seed list', () => {
  it('matches the July 13 2026 seed list exactly (adds the Gemini hard-skip rulebook\'s permanent blocklist)', () => {
    const seed = [
      'dashlane', 'redcare pharmacy', 'strv', 'swan', 'team.blue', 'papaya',
      'tricentis', 'sweep', 'atolls', 'securepoint', 'swile', 'devoteam',
      'oskey', 'modjo', 'sii', 'creative clicks', 'winamax',
      'theodo', 'transparent hiring',
    ];
    expect(REJECTED_COMPANIES).toEqual(seed);
  });
});

describe('isRejectedCompany', () => {
  it('matches an exact blocklisted name', () => {
    expect(isRejectedCompany('Dashlane')).toBe(true);
  });

  it('matches "SII Toulouse" against the "sii" entry', () => {
    expect(isRejectedCompany('SII Toulouse')).toBe(true);
  });

  it('matches "Groupe SII" against the "sii" entry', () => {
    expect(isRejectedCompany('Groupe SII')).toBe(true);
  });

  it('does not match "Missio" as a false positive for "sii"', () => {
    expect(isRejectedCompany('Missio')).toBe(false);
  });

  it('does not match an unrelated company', () => {
    expect(isRejectedCompany('Acme Corp')).toBe(false);
  });

  it('matches through a stripped corporate suffix ("Swile SAS")', () => {
    expect(isRejectedCompany('Swile SAS')).toBe(true);
  });

  it('matches "Team.blue" case-insensitively', () => {
    expect(isRejectedCompany('TEAM.BLUE')).toBe(true);
  });

  it('matches a multi-word entry ("Redcare Pharmacy GmbH")', () => {
    expect(isRejectedCompany('Redcare Pharmacy GmbH')).toBe(true);
  });

  it('matches "Theodo" (hard skip rule 8 — grandes ecoles filter)', () => {
    expect(isRejectedCompany('Theodo')).toBe(true);
  });

  it('matches "Transparent Hiring" (hard skip rule 8 — paid service, not a real employer)', () => {
    expect(isRejectedCompany('Transparent Hiring')).toBe(true);
  });
});

describe('normalizeCompanyName — German legal-suffix stripping (Germany-coverage pass, July 12 2026)', () => {
  it('strips a bare "GmbH" suffix', () => {
    expect(normalizeCompanyName('Acme GmbH')).toBe('acme');
  });

  it('strips the compound "GmbH & Co. KG" suffix', () => {
    expect(normalizeCompanyName('Acme GmbH & Co. KG')).toBe('acme');
  });

  it('leaves a name with no suffix unchanged (lowercased)', () => {
    expect(normalizeCompanyName('ACME')).toBe('acme');
  });

  it('strips a bare "AG" suffix', () => {
    expect(normalizeCompanyName('Acme AG')).toBe('acme');
  });

  it('strips "UG" (haftungsbeschränkt short form)', () => {
    expect(normalizeCompanyName('Acme UG')).toBe('acme');
  });

  it('collapses three different source spellings of the same German company to one key', () => {
    const a = normalizeCompanyName('Acme GmbH');
    const b = normalizeCompanyName('Acme');
    const c = normalizeCompanyName('ACME GmbH & Co. KG');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
