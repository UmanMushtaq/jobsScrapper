import { SearchSettings } from '../types';

export interface LocationScore {
  isAcceptable: boolean;
  score: number; // 0-100
  priority: 'preferred' | 'acceptable' | 'backup' | 'rejected';
  reason: string;
}

export function scoreLocation(
  countryCode: string | null,
  city: string | null,
  workMode: 'remote' | 'hybrid' | 'on-site',
  offersRelocation: boolean,
  profile: SearchSettings,
): LocationScore {
  // Remote jobs are always acceptable regardless of country
  if (workMode === 'remote') {
    return {
      isAcceptable: true,
      score: 90,
      priority: 'acceptable',
      reason: 'Remote position - location-independent',
    };
  }

  // If no country code provided but work mode accepted, reject on-site
  if (!countryCode) {
    if (workMode === 'on-site') {
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: 'On-site but location unknown',
      };
    }
    return {
      isAcceptable: true,
      score: 70,
      priority: 'backup',
      reason: 'Hybrid/Unknown location - need clarification',
    };
  }

  // Blacklisted countries
  if (profile.excludedCountries.includes(countryCode)) {
    return {
      isAcceptable: false,
      score: 0,
      priority: 'rejected',
      reason: `Country ${countryCode} is in exclude list`,
    };
  }

  // Preferred countries (France)
  if (profile.preferredCountries.includes(countryCode)) {
    return {
      isAcceptable: true,
      score: 100,
      priority: 'preferred',
      reason: `Preferred country: ${countryCode}`,
    };
  }

  // Europe acceptance
  if (profile.europeCountryCodes.includes(countryCode)) {
    // On-site in Europe is acceptable if relocation offered or willing to relocate
    if (workMode === 'on-site') {
      if (offersRelocation || profile.willingToRelocate) {
        return {
          isAcceptable: true,
          score: 75,
          priority: 'acceptable',
          reason: `Europe on-site (${countryCode}) with relocation support`,
        };
      }
      return {
        isAcceptable: profile.acceptOnSite,
        score: profile.acceptOnSite ? 60 : 0,
        priority: profile.acceptOnSite ? 'acceptable' : 'rejected',
        reason: `Europe on-site (${countryCode}) - no relocation mentioned`,
      };
    }

    // Hybrid in Europe
    if (workMode === 'hybrid') {
      return {
        isAcceptable: profile.acceptHybrid,
        score: profile.acceptHybrid ? 85 : 0,
        priority: profile.acceptHybrid ? 'acceptable' : 'rejected',
        reason: `Europe hybrid (${countryCode})`,
      };
    }
  }

  // USA acceptance
  if (profile.usaJobs && profile.usaCountryCodes.includes(countryCode)) {
    const score = offersRelocation ? 70 : 50;
    return {
      isAcceptable: true,
      score,
      priority: 'acceptable',
      reason: `USA position (${workMode})${offersRelocation ? ' with relocation' : ''}`,
    };
  }

  return {
    isAcceptable: false,
    score: 0,
    priority: 'rejected',
    reason: `Country ${countryCode} not in acceptable regions`,
  };
}
