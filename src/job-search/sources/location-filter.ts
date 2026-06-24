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
  locationLabel?: string,
): LocationScore {
  let effectiveCountryCode = countryCode;

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

  // If no country code provided, try to infer from locationLabel
  if (!countryCode) {
    const labelLower = (locationLabel ?? '').toLowerCase();

    // Check if locationLabel contains a preferred/target country name
    const COUNTRY_HINTS: Record<string, string> = {
      'germany': 'DE', 'deutschland': 'DE', 'berlin': 'DE', 'munich': 'DE', 'münchen': 'DE',
      'hamburg': 'DE', 'frankfurt': 'DE', 'cologne': 'DE', 'köln': 'DE',
      'belgium': 'BE', 'belgique': 'BE', 'belgie': 'BE', 'brussels': 'BE', 'bruxelles': 'BE',
      'netherlands': 'NL', 'amsterdam': 'NL', 'rotterdam': 'NL', 'nederland': 'NL',
      'luxembourg': 'LU', 'france': 'FR', 'paris': 'FR',
      'ireland': 'IE', 'dublin': 'IE',
      'poland': 'PL', 'polska': 'PL', 'warsaw': 'PL', 'warszawa': 'PL', 'krakow': 'PL', 'wroclaw': 'PL',
      'spain': 'ES', 'españa': 'ES', 'madrid': 'ES', 'barcelona': 'ES',
      'sweden': 'SE', 'sverige': 'SE', 'stockholm': 'SE',
      'italy': 'IT', 'italia': 'IT', 'milan': 'IT', 'rome': 'IT',
      'denmark': 'DK', 'danmark': 'DK', 'copenhagen': 'DK',
      'czech': 'CZ', 'prague': 'CZ', 'praha': 'CZ',
    };

    let inferredCode: string | null = null;
    for (const [hint, code] of Object.entries(COUNTRY_HINTS)) {
      if (labelLower.includes(hint)) {
        inferredCode = code;
        break;
      }
    }

    if (inferredCode) {
      // Re-run with inferred country code by falling through to the checks below
      // Use the inferred code for the rest of the function
      effectiveCountryCode = inferredCode;
      console.log(`[loc-filter] inferred countryCode ${inferredCode} from locationLabel "${locationLabel}"`);
    } else {
      // Truly unknown location
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
  }

  // Blacklisted countries
  if (profile.excludedCountries.includes(effectiveCountryCode!)) {
    return {
      isAcceptable: false,
      score: 0,
      priority: 'rejected',
      reason: `Country ${effectiveCountryCode} is in exclude list`,
    };
  }

  // Preferred countries (France)
  if (profile.preferredCountries.includes(effectiveCountryCode!)) {
    return {
      isAcceptable: true,
      score: 100,
      priority: 'preferred',
      reason: `Preferred country: ${effectiveCountryCode}`,
    };
  }

  // Target relocation countries — candidate is willing to relocate here without
  // requiring the company to explicitly offer a relocation package.
  // EU Blue Card / skilled worker visa covers Germany and all other EU targets.
  // GB is excluded — post-Brexit visa complexity makes it a special case.
  const TARGET_RELOCATION_COUNTRIES = ['IT', 'ES', 'SE', 'DK', 'CZ', 'PL', 'AT', 'PT', 'NO'];

  if (profile.europeCountryCodes.includes(effectiveCountryCode!)) {
    // UK: only accept remote or if relocation explicitly offered — too complex post-Brexit
    if (effectiveCountryCode === 'GB') {
      if (workMode === 'hybrid' || workMode === 'on-site') {
        if (!offersRelocation) {
          return {
            isAcceptable: false,
            score: 0,
            priority: 'rejected',
            reason: 'UK hybrid/on-site — post-Brexit visa complexity, relocation support required',
          };
        }
      }
    }

    if (workMode === 'on-site') {
      if (TARGET_RELOCATION_COUNTRIES.includes(effectiveCountryCode!)) {
        return {
          isAcceptable: true,
          score: offersRelocation ? 75 : 65,
          priority: 'acceptable',
          reason: `Target country on-site (${effectiveCountryCode}) — willing to relocate${offersRelocation ? ' + relocation support offered' : ''}`,
        };
      }
      if (offersRelocation) {
        return {
          isAcceptable: true,
          score: 70,
          priority: 'acceptable',
          reason: `Europe on-site (${effectiveCountryCode}) with relocation support`,
        };
      }
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: `Europe on-site (${effectiveCountryCode}) — not a target relocation country and no relocation offered`,
      };
    }

    if (workMode === 'hybrid') {
      if (TARGET_RELOCATION_COUNTRIES.includes(effectiveCountryCode!)) {
        return {
          isAcceptable: true,
          score: offersRelocation ? 80 : 70,
          priority: 'acceptable',
          reason: `Target country hybrid (${effectiveCountryCode}) — willing to relocate${offersRelocation ? ' + relocation support offered' : ''}`,
        };
      }
      if (offersRelocation) {
        return {
          isAcceptable: true,
          score: 80,
          priority: 'acceptable',
          reason: `Europe hybrid (${effectiveCountryCode}) with relocation support`,
        };
      }
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: `Europe hybrid (${effectiveCountryCode}) — not a target relocation country and no relocation offered`,
      };
    }
  }

  // USA acceptance
  if (profile.usaJobs && profile.usaCountryCodes.includes(effectiveCountryCode!)) {
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
    reason: `Country ${effectiveCountryCode} not in acceptable regions`,
  };
}
