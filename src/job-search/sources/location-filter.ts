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
  // Remote jobs: acceptable regardless of country, BUT respect usaJobs:false.
  // If the company is USA-based and the profile opts out of USA jobs, reject even for remote.
  if (workMode === 'remote') {
    if (!profile.usaJobs && countryCode && profile.usaCountryCodes.includes(countryCode)) {
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: 'USA-based company — usaJobs is disabled',
      };
    }
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
    if (workMode === 'on-site') {
      if (offersRelocation || profile.willingToRelocate) {
        return {
          isAcceptable: true,
          score: offersRelocation ? 70 : 60,
          priority: 'acceptable',
          reason: `Europe on-site (${countryCode})${offersRelocation ? ' with relocation support' : ', candidate willing to relocate'}`,
        };
      }
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: `Europe on-site (${countryCode}) - no relocation offered`,
      };
    }

    if (workMode === 'hybrid') {
      if (countryCode === 'GB') {
        return {
          isAcceptable: false,
          score: 0,
          priority: 'rejected',
          reason: 'UK hybrid - not viable from Paris (remote or full relocation only)',
        };
      }
      if (offersRelocation || profile.willingToRelocate) {
        return {
          isAcceptable: true,
          score: offersRelocation ? 80 : 70,
          priority: 'acceptable',
          reason: `Europe hybrid (${countryCode})${offersRelocation ? ' with relocation support' : ', candidate willing to relocate'}`,
        };
      }
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: `Europe hybrid (${countryCode}) - no relocation offered`,
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
