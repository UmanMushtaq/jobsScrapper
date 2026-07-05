import { SearchSettings } from '../types';

export interface LocationScore {
  isAcceptable: boolean;
  score: number; // 0-100
  priority: 'preferred' | 'acceptable' | 'backup' | 'rejected';
  reason: string;
}

export type RemoteScope = 'eu-ok' | 'global' | 'unknown' | 'restricted-non-eu';

// EU country names + hint words already used for country inference below, reused
// here as the "eu-ok" signal set for remote-scope classification.
const EU_OK_HINTS = [
  'emea', 'europe', 'european', 'eu remote', 'remote eu', 'eu only',
  'cet', 'cest', 'utc+1', 'utc+2', 'worldwide', 'global', 'anywhere',
  'germany', 'deutschland', 'belgium', 'belgique', 'belgie', 'netherlands', 'nederland',
  'luxembourg', 'france', 'ireland', 'poland', 'polska', 'spain', 'españa', 'sweden', 'sverige',
  'italy', 'italia', 'denmark', 'danmark', 'czech', 'austria', 'portugal', 'finland', 'greece',
  'hungary', 'romania', 'bulgaria', 'croatia', 'slovakia', 'slovenia', 'estonia', 'latvia',
  'lithuania', 'malta', 'cyprus',
];

// Whole-word-ish patterns (word-boundary regexes) that signal the job is scoped
// to a non-EU region and excludes EU-based remote candidates.
const RESTRICTED_NON_EU_PATTERNS: RegExp[] = [
  // US
  /\bus[\s-]?only\b/i, /\busa only\b/i, /\bunited states only\b/i,
  /\bremote\s*\(us\)/i, /\bremote us\b/i, /\bus remote\b/i, /\bremote in the us\b/i,
  /\bus[\s-]based\b/i, /\bbased in the us\b/i, /\bus residents?\b/i,
  /\bmust be located in the us\b/i, /\bmust reside in the us\b/i,
  /\bus work authorization\b/i, /\bauthorized to work in the us\b/i,
  /\bus citizens?\b/i, /\bgreen card\b/i, /\bw-?2\b/i,
  // North America
  /\bcanada only\b/i, /\bus or canada\b/i, /\bus\/canada\b/i, /\bus & canada\b/i,
  /\bnorth america only\b/i, /\bna only\b/i, /\bus\/ca\b/i, /\(us\/ca\)/i,
  // LATAM / other regions
  /\blatam\b/i, /\blatin america\b/i, /\bargentina only\b/i, /\bbrazil only\b/i,
  /\bmexico only\b/i, /\bamericas only\b/i, /\bapac\b/i, /\basia-pacific\b/i,
  /\bindia only\b/i, /\baustralia only\b/i, /\bus or latam\b/i,
  // US timezone hard requirements
  /\bpacific hours\b/i, /\bpst hours\b/i, /\best hours\b/i, /\bus pacific\b/i,
  /\bus eastern\b/i, /\boverlap with us\b/i, /\bus time ?zone\b/i, /\bus timezones\b/i,
  /\bus business hours\b/i,
];

// Weaker signals only trustworthy when they ARE the location label itself
// (e.g. locationLabel === "United States (Remote)") — a bare country name used
// as the posting's location field means the role is scoped to that country.
// Too noisy to also scan the full description, where a stray "United States"
// mention doesn't necessarily restrict an otherwise EU-fine remote role.
const RESTRICTED_LABEL_ONLY_PATTERNS: RegExp[] = [
  /\bunited states\b/i,
];

/**
 * Classifies a job's remote scope from its location label (strongest signal)
 * and the first ~1500 chars of its description (weaker, only for the explicit
 * patterns above — long descriptions bury unrelated "US" mentions that don't
 * describe the job's own eligibility).
 */
export function parseRemoteScope(locationLabel: string, description: string): RemoteScope {
  const label = (locationLabel ?? '').toLowerCase();
  const descSample = (description ?? '').slice(0, 1500).toLowerCase();

  if (RESTRICTED_NON_EU_PATTERNS.some((p) => p.test(label))) return 'restricted-non-eu';
  if (RESTRICTED_LABEL_ONLY_PATTERNS.some((p) => p.test(label))) return 'restricted-non-eu';
  if (RESTRICTED_NON_EU_PATTERNS.some((p) => p.test(descSample))) return 'restricted-non-eu';

  if (EU_OK_HINTS.some((hint) => label.includes(hint))) return 'eu-ok';
  if (EU_OK_HINTS.some((hint) => descSample.includes(hint))) return 'eu-ok';

  if (label.includes('fully remote') || descSample.includes('fully remote')) return 'global';

  return 'unknown';
}

// Country name hints used to infer a country code from a free-text location
// label when no structured countryCode is available. Shared by the core
// scorer (below) and the priority-boost wrapper (scoreLocation), so both
// agree on which country a label-only job resolves to.
const COUNTRY_NAME_HINTS: Record<string, string> = {
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

function inferCountryFromLabel(locationLabel: string): string | null {
  const labelLower = (locationLabel ?? '').toLowerCase();
  for (const [hint, code] of Object.entries(COUNTRY_NAME_HINTS)) {
    if (labelLower.includes(hint)) return code;
  }
  return null;
}

/**
 * Scores a job's location/work-mode fit against the profile, then applies a
 * ranking boost (not a filter — never changes isAcceptable) based on which
 * country tier the job falls into: tier1 (+15, primary market — currently
 * France), tier2 (+10, secondary English-first markets), tier3 (+5, everything
 * else worth ranking above non-tier countries).
 */
export function scoreLocation(
  countryCode: string | null,
  city: string | null,
  workMode: 'remote' | 'hybrid' | 'on-site',
  offersRelocation: boolean,
  profile: SearchSettings,
  locationLabel?: string,
  description?: string,
): LocationScore {
  const result = scoreLocationCore(countryCode, city, workMode, offersRelocation, profile, locationLabel, description);
  if (!result.isAcceptable) return result;

  const effectiveCountryCode = countryCode ?? inferCountryFromLabel(locationLabel ?? '');
  const tiers = profile.countryTiers ?? { tier1: [], tier2: [], tier3: [] };
  if (effectiveCountryCode) {
    let boost = 0;
    let tierLabel = '';
    if (tiers.tier1.includes(effectiveCountryCode)) {
      boost = 15;
      tierLabel = 'tier1';
    } else if (tiers.tier2.includes(effectiveCountryCode)) {
      boost = 10;
      tierLabel = 'tier2';
    } else if (tiers.tier3.includes(effectiveCountryCode)) {
      boost = 5;
      tierLabel = 'tier3';
    }
    if (boost > 0) {
      return {
        ...result,
        score: Math.min(100, result.score + boost),
        reason: `${result.reason} [${tierLabel} country]`,
      };
    }
  }
  return result;
}

function scoreLocationCore(
  countryCode: string | null,
  city: string | null,
  workMode: 'remote' | 'hybrid' | 'on-site',
  offersRelocation: boolean,
  profile: SearchSettings,
  locationLabel?: string,
  description?: string,
): LocationScore {
  let effectiveCountryCode = countryCode;

  // Remote jobs: acceptable regardless of country, BUT respect usaJobs:false and
  // any explicit non-EU geo restriction (US-only, US/CA, LATAM, APAC, etc.).
  if (workMode === 'remote') {
    if (!profile.usaJobs && countryCode && profile.usaCountryCodes.includes(countryCode)) {
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: 'USA-based company — usaJobs is disabled',
      };
    }

    const scope = parseRemoteScope(locationLabel ?? '', description ?? '');
    if (scope === 'restricted-non-eu') {
      return {
        isAcceptable: false,
        score: 0,
        priority: 'rejected',
        reason: `Remote restricted to non-EU region: ${locationLabel ?? description?.slice(0, 80) ?? 'unspecified'}`,
      };
    }
    if (scope === 'eu-ok' || scope === 'global') {
      return {
        isAcceptable: true,
        score: 95,
        priority: 'acceptable',
        reason: 'EU/global remote',
      };
    }
    return {
      isAcceptable: true,
      score: 85,
      priority: 'acceptable',
      reason: 'Remote, location unspecified — acceptable',
    };
  }

  // If no country code provided, try to infer from locationLabel
  if (!countryCode) {
    const inferredCode = inferCountryFromLabel(locationLabel ?? '');

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
