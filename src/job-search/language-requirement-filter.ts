// Deterministic language-requirement filter — same layer as stack-filter.ts and the
// remote geo-restriction filter (sources/location-filter.ts). Distinct from
// matcher.ts's isLanguageFit(), which judges the LANGUAGE THE POSTING IS WRITTEN IN
// (a French-language JD is fine on its own). This module judges an explicit, stated
// LANGUAGE PROFICIENCY REQUIREMENT for the candidate — "you must speak French",
// "Nederlands vereist" — which is rejected independently of what language the JD itself
// happens to be written in.
//
// Candidate profile this filter is tuned for: fluent English, French at A1 only.
//
// Final rule set (both checks live here; matcher.ts runs them as one posting-language step):
// 1. A local language (FR/DE/NL/SV/DA/NO/FI) stated as REQUIRED → reject
//    "local-language-required", unless that phrase is marked nice to have / a plus.
// 2. Description not in English and no English signal → reject "no-english-signal",
//    for every source (trusted ones included).
// 3. English description without a local-language requirement → keep.
// 4. Language can't be told → keep, tagged "language-unclear".

export const LOCAL_LANGUAGE_REQUIRED = 'local-language-required';
export const NO_ENGLISH_SIGNAL = 'no-english-signal';
export const LANGUAGE_UNCLEAR_TAG = 'language-unclear';

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
      /fluent(?:ly)?\s+(?:in\s+)?(?:english\s+(?:and|&)\s+)?french/i,
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
      /fluent(?:ly)?\s+(?:in\s+)?(?:english\s+(?:and|&)\s+)?dutch/i,
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
      /flie[ßs]ende deutschkenntnisse/i,
      /deutsch\s*(?:\(|:|-)?\s*flie[ßs]end/i,
      /verhandlungssicher(?:e|es|en)? deutsch/i,
      /fluent(?:ly)?\s+(?:in\s+)?(?:english\s+(?:and|&)\s+)?german/i,
    ],
  },
  {
    language: 'Swedish',
    patterns: [
      /flytande svenska/i,
      /svenska (?:krävs|är ett krav)/i,
      /(?:mycket )?goda kunskaper i svenska/i,
      /behärskar svenska/i,
      /swedish required/i,
      /fluent(?:ly)?\s+(?:in\s+)?(?:english\s+(?:and|&)\s+)?swedish/i,
      /must speak swedish/i,
    ],
  },
  {
    language: 'Danish',
    patterns: [
      /flydende dansk/i,
      /dansk (?:er et krav|påkrævet)/i,
      /taler og skriver dansk/i,
      /danish required/i,
      /fluent(?:ly)?\s+(?:in\s+)?(?:english\s+(?:and|&)\s+)?danish/i,
      /must speak danish/i,
    ],
  },
  {
    language: 'Norwegian',
    patterns: [
      /flytende norsk/i,
      /norsk (?:er et krav|påkrevd|påkrevet)/i,
      /gode norskkunnskaper/i,
      /norwegian required/i,
      /fluent(?:ly)?\s+(?:in\s+)?(?:english\s+(?:and|&)\s+)?norwegian/i,
      /must speak norwegian/i,
    ],
  },
  {
    language: 'Finnish',
    patterns: [
      /suomen kielen taito/i,
      /sujuva suomen kieli/i,
      /sujuvaa suomea/i,
      /finnish required/i,
      /fluent(?:ly)?\s+(?:in\s+)?(?:english\s+(?:and|&)\s+)?finnish/i,
      /must speak finnish/i,
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

// A requirement phrase marked like this (same clause, or under a "nice to have" heading)
// is optional and never rejects.
const SOFT_QUALIFIER =
  /(?:nice[\s-]to[\s-]have|\ba\s+plus\b|\bbonus\b|advantage|\basset\b|desirable|preferred|optional|von\s+vorteil|ein\s+plus|wünschenswert|un\s+plus|un\s+atout|apprécié|souhaité|pluspunt|een\s+pré|meriterande|meritterande|en\s+fordel|\beduksi\b|\betu\b)/i;
// A requirements heading between a qualifier and the phrase resets the context.
const HARD_HEADING =
  /(?:requirements?|required|must|anforderungen|voraussetzungen|das bringst du mit|ihr profil|dein profil|exigences|requis|profil recherché|vereisten|vereist|krav|vaatimukset)/gi;

function isSoftPhrase(text: string, start: number, end: number): boolean {
  let before = text.slice(Math.max(0, start - 80), start);
  const stop = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf(','), before.lastIndexOf('!'), before.lastIndexOf('?'));
  if (stop >= 0) before = before.slice(stop + 1);
  let lastHard = -1;
  for (const m of before.matchAll(HARD_HEADING)) lastHard = m.index + m[0].length;
  if (lastHard >= 0) before = before.slice(lastHard);
  const after = text.slice(end, end + 60).split(/[.,;!?\n]/)[0];
  return SOFT_QUALIFIER.test(before) || SOFT_QUALIFIER.test(after);
}

// Returns the first local language stated as a hard requirement, or null. Phrases marked
// nice to have / a plus / von Vorteil / un plus / ein Plus are skipped.
export function detectRequiredLanguagePhrase(text: string): string | null {
  const t = text ?? '';
  for (const { language, patterns } of REQUIREMENT_PHRASE_PATTERNS) {
    for (const p of patterns) {
      for (const m of t.matchAll(new RegExp(p.source, 'gi'))) {
        if (!isSoftPhrase(t, m.index, m.index + m[0].length)) return language;
      }
    }
  }
  return null;
}

// ── Posting language ───────────────────────────────────────────────────────────
// detectLanguage() in sources/language-detect.ts only separates en/fr/de (Dutch reads as
// English, Swedish as German), so the posting language is judged here by counting common
// function words per language. No dependency needed, and it can say "unclear".
const EN_WORDS = new Set([
  'the', 'and', 'you', 'your', 'our', 'with', 'will', 'are', 'this', 'that', 'to', 'of',
  'or', 'be', 'as', 'who', 'what', 'about', 'from', 'it', 'can',
]);
const LOCAL_WORDS: Record<string, string[]> = {
  fr: ['le', 'la', 'les', 'des', 'et', 'vous', 'nous', 'pour', 'avec', 'une', 'du', 'est', 'sur', 'dans', 'au', 'aux', 'votre', 'notre', 'qui', 'que', 'ou', 'sont', 'pas', 'par', 'ce', 'ces'],
  de: ['und', 'der', 'die', 'das', 'wir', 'sie', 'mit', 'für', 'ist', 'ein', 'eine', 'zu', 'auf', 'den', 'dem', 'ihr', 'ihre', 'unser', 'unsere', 'bei', 'im', 'von', 'dich', 'dein', 'deine', 'oder', 'nicht', 'auch', 'sich', 'werden'],
  nl: ['het', 'een', 'en', 'wij', 'jij', 'je', 'met', 'voor', 'van', 'ons', 'onze', 'zijn', 'bij', 'naar', 'ook', 'als', 'wat', 'niet', 'worden', 'deze', 'dat', 'wordt', 'jouw', 'heb', 'hebt'],
  sv: ['och', 'att', 'det', 'som', 'för', 'med', 'vi', 'är', 'på', 'av', 'ett', 'till', 'har', 'oss', 'din', 'vår', 'inte', 'kommer', 'du'],
  da: ['og', 'det', 'som', 'med', 'vi', 'er', 'på', 'af', 'et', 'til', 'har', 'os', 'din', 'vores', 'ikke', 'du'],
  no: ['og', 'å', 'det', 'som', 'med', 'vi', 'er', 'på', 'av', 'et', 'til', 'har', 'oss', 'din', 'vår', 'ikke', 'du', 'være'],
  fi: ['ja', 'että', 'sinä', 'olet', 'kanssa', 'sekä', 'tai', 'meidän', 'sinun', 'joka', 'ovat', 'myös', 'kun', 'olla', 'tämä', 'meillä', 'sinulla', 'haemme'],
};
const LOCAL_WORD_SETS = Object.entries(LOCAL_WORDS).map(([code, words]) => [code, new Set(words)] as const);
const ANY_LOCAL_WORD = new Set(Object.values(LOCAL_WORDS).flat());

const MIN_FUNCTION_WORDS = 8;
const DOMINANT_SHARE = 0.7;

export interface PostingLanguage {
  language: 'en' | 'local' | 'unclear';
  localCode: string | null; // best guess when local, e.g. 'de'
}

export function detectPostingLanguage(text: string): PostingLanguage {
  const tokens = (text ?? '').toLowerCase().match(/\p{L}+/gu) ?? [];
  let en = 0;
  let local = 0;
  const perCode = new Map<string, number>();
  for (const token of tokens) {
    if (EN_WORDS.has(token)) en++;
    else if (ANY_LOCAL_WORD.has(token)) {
      local++;
      for (const [code, set] of LOCAL_WORD_SETS) {
        if (set.has(token)) perCode.set(code, (perCode.get(code) ?? 0) + 1);
      }
    }
  }
  const total = en + local;
  const localCode = [...perCode.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (total < MIN_FUNCTION_WORDS) return { language: 'unclear', localCode };
  if (en / total >= DOMINANT_SHARE) return { language: 'en', localCode: null };
  if (local / total >= DOMINANT_SHARE) return { language: 'local', localCode };
  return { language: 'unclear', localCode };
}

// The word "English" in any target language, a stated English working language, or an
// international team.
const ENGLISH_SIGNAL =
  /\benglish\b|\benglisch\p{L}*|\banglais\p{L}*|\bengels\p{L}*|\bengelsk\p{L}*|\benglan\p{L}*|working language is english|international(?:es|e|en)?\s+team|équipe internationale|internationaal team|internationellt team|internationalt team|internasjonalt team|kansainvälinen tiimi|kansainvälisessä tiimissä/iu;

export function hasEnglishSignal(text: string): boolean {
  return ENGLISH_SIGNAL.test(text ?? '');
}

export interface PostingLanguageResult {
  decision: 'keep' | 'reject' | 'unclear';
  reason: string | null; // LOCAL_LANGUAGE_REQUIRED | NO_ENGLISH_SIGNAL when rejected
  detail: string | null;
  languageRequirement: LanguageRequirementResult;
}

/** Applies rules 1-4 above to one posting. */
export function evaluatePostingLanguage(
  requiredLanguages: RequiredLanguage[] | null | undefined,
  description: string,
): PostingLanguageResult {
  const languageRequirement = evaluateLanguageRequirement(requiredLanguages, description);
  if (languageRequirement.reject) {
    return { decision: 'reject', reason: LOCAL_LANGUAGE_REQUIRED, detail: languageRequirement.note, languageRequirement };
  }
  const posting = detectPostingLanguage(description);
  if (posting.language === 'local' && !hasEnglishSignal(description)) {
    return {
      decision: 'reject',
      reason: NO_ENGLISH_SIGNAL,
      detail: `description in ${posting.localCode ?? 'a local language'} with no English signal`,
      languageRequirement,
    };
  }
  if (posting.language === 'unclear') {
    return { decision: 'unclear', reason: null, detail: 'posting language unclear', languageRequirement };
  }
  return { decision: 'keep', reason: null, detail: null, languageRequirement };
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
          reason: `${LOCAL_LANGUAGE_REQUIRED}: ${code.toUpperCase()} required at ${lang.level} — above candidate's level`,
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
      reason: `${LOCAL_LANGUAGE_REQUIRED}: description requires ${phraseHit} as a stated requirement`,
      note: `${phraseHit} required (description)`,
    };
  }

  return {
    reject: false,
    reason: '',
    note: notes.length ? notes.join(', ') : null,
  };
}
