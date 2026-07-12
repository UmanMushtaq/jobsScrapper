// Deterministic language-requirement filter — same layer as stack-filter.ts and the
// remote geo-restriction filter (sources/location-filter.ts). Distinct from
// matcher.ts's isLanguageFit(), which judges the LANGUAGE THE POSTING IS WRITTEN IN
// (a French-language JD is fine on its own). This module judges an explicit, stated
// LANGUAGE PROFICIENCY REQUIREMENT for the candidate — "you must speak French",
// "Nederlands vereist" — which is rejected independently of what language the JD itself
// happens to be written in.
//
// Candidate profile this filter is tuned for: fluent English, French at A1 only.

export interface RequiredLanguage {
  code: string; // ISO 639-1, e.g. 'nl', 'fr', 'de'
  level?: string; // CEFR level, e.g. 'B1', 'B2' — omitted when unknown
  required?: boolean; // false = optional/asset/nice-to-have, never rejects
}

export interface LanguageRequirementResult {
  reject: boolean;
  reason: string;
  note: string | null; // human-readable summary for surfacing in analysis/reporting
}

const ENGLISH_CODES = new Set(['en', 'eng', 'english']);

const CEFR_RANK: Record<string, number> = {
  a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6,
};

const REJECT_FROM_RANK = CEFR_RANK.b1;

function rankOf(level: string | undefined): number {
  if (!level) return 0;
  return CEFR_RANK[level.trim().toLowerCase()] ?? 0;
}

// Text-heuristic layer — applies to every source's free-text description, not just
// EURES. Deliberately phrase-specific (not a bare language-name scan) so a JD merely
// *written* in French/Dutch/German never trips this — only an explicit stated
// requirement for the candidate to speak it does.
const REQUIREMENT_PHRASE_PATTERNS: Array<{ language: string; patterns: RegExp[] }> = [
  {
    language: 'French',
    patterns: [
      /vous parlez français/i,
      /ma[iî]trise (?:du|de la|de l['’]|courante du) français/i,
      /français courant/i,
      /français exigé/i,
      /niveau de français (?:b1|b2|c1|c2|courant|natif)/i,
      /french required/i,
      /french(?: language)? proficiency required/i,
      /fluent(?:ly)? in french/i,
      /must speak french/i,
      /french (?:fluent|native|c1|c2|b2) required/i,
      /parfaitement francophone/i,
    ],
  },
  {
    language: 'Dutch',
    patterns: [
      /nederlands vereist/i,
      /goede kennis van het nederlands/i,
      /vloeiend nederlands/i,
      /dutch required/i,
      /fluent(?:ly)? in dutch/i,
      /must speak dutch/i,
      /je spreekt nederlands/i,
    ],
  },
  {
    language: 'German',
    patterns: [
      /deutschkenntnisse (?:erforderlich|zwingend|vorausgesetzt)/i,
      /sehr gute deutschkenntnisse/i,
      /deutsch (?:erforderlich|zwingend)/i,
      /german required/i,
      /fluent(?:ly)? in german/i,
      /must speak german/i,
      /verhandlungssichere? deutschkenntnisse/i,
      /deutschkenntnisse in wort und schrift/i,
      /deutsch in wort und schrift/i,
      /deutsch (?:c1|c2|b2)\b/i,
      /deutschkenntnisse auf (?:c1|c2|b2)[\s-]?niveau/i,
      /flie[ßs]end(?:es)? deutsch/i,
    ],
  },
  {
    language: 'Italian',
    patterns: [
      /italiano richiesto/i,
      /ottima conoscenza dell['’]italiano/i,
      /italian required/i,
      /fluent(?:ly)? in italian/i,
      /must speak italian/i,
    ],
  },
  {
    language: 'Polish',
    patterns: [
      /znajomo[śs][ćc] j[eę]zyka polskiego (?:wymagana|na poziomie)/i,
      /wymagana znajomo[śs][ćc] polskiego/i,
      /polish required/i,
      /fluent(?:ly)? in polish/i,
      /must speak polish/i,
    ],
  },
];

export function detectRequiredLanguagePhrase(text: string): string | null {
  const t = text ?? '';
  for (const { language, patterns } of REQUIREMENT_PHRASE_PATTERNS) {
    if (patterns.some((p) => p.test(t))) return language;
  }
  return null;
}

/**
 * Evaluates both the structured requiredLanguages field (when a source provides one,
 * e.g. EURES) and the free-text requirement-phrase heuristic (all sources).
 * - English-only or no requirement at all: accept.
 * - Any non-English language required at B1+: reject.
 * - Non-English at A1/A2, or explicitly marked optional/asset: pass through with a note.
 */
export function evaluateLanguageRequirement(
  requiredLanguages: RequiredLanguage[] | null | undefined,
  description: string,
): LanguageRequirementResult {
  const notes: string[] = [];

  if (requiredLanguages) {
    for (const lang of requiredLanguages) {
      const code = (lang.code ?? '').toLowerCase();
      if (!code || ENGLISH_CODES.has(code)) continue;
      if (lang.required === false) {
        notes.push(`${code.toUpperCase()}${lang.level ? ` ${lang.level}` : ''} (optional/asset)`);
        continue;
      }
      const rank = rankOf(lang.level);
      if (rank >= REJECT_FROM_RANK) {
        return {
          reject: true,
          reason: `${code.toUpperCase()} required at ${lang.level} — above candidate's level`,
          note: `${code.toUpperCase()} ${lang.level} required`,
        };
      }
      notes.push(`${code.toUpperCase()}${lang.level ? ` ${lang.level}` : ''}`);
    }
  }

  const phraseHit = detectRequiredLanguagePhrase(description ?? '');
  if (phraseHit) {
    return {
      reject: true,
      reason: `description requires ${phraseHit} as a stated requirement`,
      note: `${phraseHit} required (description)`,
    };
  }

  return {
    reject: false,
    reason: '',
    note: notes.length ? notes.join(', ') : null,
  };
}
