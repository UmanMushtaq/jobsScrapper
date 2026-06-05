import { JobHistoryEntry } from './redis-store';
import { JobPosting } from './types';

// Learns your taste from past Applied/Dismissed decisions.
//
// Two products are derived from the same history:
//   1. PreferenceModel  — deterministic word weights used by the matcher score.
//                         Works even when the AI is unavailable.
//   2. buildPreferenceContext — a short text block fed to Gemini so its
//                         relevance grading calibrates to your real choices.

export interface PreferenceModel {
  // word -> weight. Positive = appears more in jobs you APPLIED to.
  //                 Negative = appears more in jobs you DISMISSED.
  weights: Map<string, number>;
  appliedCount: number;
  dismissedCount: number;
}

// Below this many total decisions the signal is pure noise — stay neutral.
const MIN_DECISIONS_TO_ACTIVATE = 4;
// A single word needs at least this much support before it earns a weight.
const MIN_WORD_SUPPORT = 2;
// Clamp the per-job adjustment so learned preference nudges, never dominates.
const MAX_POSITIVE_DELTA = 12;
const MAX_NEGATIVE_DELTA = -15;

// Words that carry no preference signal — drop them so they never earn weight.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'a', 'an', 'of', 'in', 'to', 'on', 'at', 'by',
  'or', 'as', 'is', 'be', 'our', 'we', 'you', 'your', 'this', 'that', 'from',
  'month', 'months', 'fixed', 'term', 'contract', 'permanent', 'time', 'full',
  'part', 'remote', 'hybrid', 'onsite', 'on-site', 'role', 'job', 'position',
  'team', 'new', 'all', 'are', 'will', 'have', 'has',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9.+#]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export function buildPreferenceModel(history: JobHistoryEntry[]): PreferenceModel {
  const appliedWords = new Map<string, number>();
  const dismissedWords = new Map<string, number>();
  let appliedCount = 0;
  let dismissedCount = 0;

  for (const entry of history) {
    const words = new Set(tokenize(`${entry.title} ${entry.company}`));
    if (entry.type === 'applied') {
      appliedCount++;
      for (const w of words) appliedWords.set(w, (appliedWords.get(w) ?? 0) + 1);
    } else {
      dismissedCount++;
      for (const w of words) dismissedWords.set(w, (dismissedWords.get(w) ?? 0) + 1);
    }
  }

  const weights = new Map<string, number>();
  const allWords = new Set([...appliedWords.keys(), ...dismissedWords.keys()]);
  for (const w of allWords) {
    const a = appliedWords.get(w) ?? 0;
    const d = dismissedWords.get(w) ?? 0;
    const n = a + d;
    if (n < MIN_WORD_SUPPORT) continue;
    // lean in [-1, 1]: +1 only-applied, -1 only-dismissed.
    const lean = (a - d) / n;
    // confidence grows with support, saturating at 4 occurrences.
    const confidence = Math.min(n, 4) / 4;
    const weight = lean * confidence * 4; // ~[-4, 4] per word
    if (Math.abs(weight) >= 1) weights.set(w, Number(weight.toFixed(2)));
  }

  return { weights, appliedCount, dismissedCount };
}

export interface PreferenceResult {
  delta: number;
  reasons: string[];
}

export function scorePreference(model: PreferenceModel, job: JobPosting): PreferenceResult {
  if (model.appliedCount + model.dismissedCount < MIN_DECISIONS_TO_ACTIVATE) {
    return { delta: 0, reasons: [] };
  }

  const words = new Set(tokenize(`${job.title} ${job.company}`));
  let delta = 0;
  const positive: Array<{ w: string; wt: number }> = [];
  const negative: Array<{ w: string; wt: number }> = [];
  for (const w of words) {
    const wt = model.weights.get(w);
    if (!wt) continue;
    delta += wt;
    if (wt > 0) positive.push({ w, wt });
    else negative.push({ w, wt });
  }

  delta = Math.max(MAX_NEGATIVE_DELTA, Math.min(MAX_POSITIVE_DELTA, delta));

  const reasons: string[] = [];
  if (delta >= 4 && positive.length) {
    const top = positive.sort((x, y) => y.wt - x.wt).slice(0, 2).map((p) => p.w);
    reasons.push(`Learned fit: similar to roles you apply to (${top.join(', ')})`);
  }
  if (delta <= -4 && negative.length) {
    const top = negative.sort((x, y) => x.wt - y.wt).slice(0, 2).map((p) => p.w);
    reasons.push(`Learned caution: you often dismiss roles like "${top.join(', ')}"`);
  }

  return { delta: Math.round(delta), reasons };
}

// Compact natural-language summary of recent decisions for the AI prompt.
// Titles + companies only, capped so the prompt stays small.
export function buildPreferenceContext(history: JobHistoryEntry[], limit = 8): string {
  const applied = history.filter((e) => e.type === 'applied').slice(0, limit);
  const dismissed = history.filter((e) => e.type === 'dismissed').slice(0, limit);
  if (applied.length === 0 && dismissed.length === 0) return '';

  const fmt = (e: JobHistoryEntry) => `${e.title} @ ${e.company}`;
  const lines: string[] = ['=== CANDIDATE PAST DECISIONS (learn their taste) ==='];
  if (applied.length) {
    lines.push(`APPLIED to (wants more like these): ${applied.map(fmt).join('; ')}`);
  }
  if (dismissed.length) {
    lines.push(`DISMISSED (wants fewer like these): ${dismissed.map(fmt).join('; ')}`);
  }
  lines.push(
    'Weigh relevanceScore UP for jobs similar to the applied set and DOWN for jobs similar to the dismissed set.',
  );
  return lines.join('\n');
}
