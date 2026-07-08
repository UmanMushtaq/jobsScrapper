import { REJECTED_COMPANIES, isRejectedCompany } from './rejected-companies';

describe('rejected-companies seed list', () => {
  it('matches the July 8 2026 seed list exactly', () => {
    const seed = [
      'dashlane', 'redcare pharmacy', 'strv', 'swan', 'team.blue', 'papaya',
      'tricentis', 'sweep', 'atolls', 'securepoint', 'swile', 'devoteam',
      'oskey', 'modjo', 'sii', 'creative clicks', 'winamax',
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
});
