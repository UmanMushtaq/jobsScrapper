// Combines the code-based filter score with Gemini's structured scoring into one
// auditable final relevance decision. Extracted as a pure function (rather than left
// inline in run.ts) specifically so the reconciliation rules can be unit tested without
// mocking the whole enrichment pipeline.
export interface ReconciliationInput {
  jobLabel: string;
  codeScore: number;
  // Always false for jobs reaching this stage in the real pipeline — matcher.ts's own
  // hard-skip filters (rejected companies, frontend-primary stack, language requirement,
  // location, experience cap, internship titles, etc.) already return null before a job
  // is ever enriched. Kept as a real input (not hardcoded false) so this function stays
  // correct and testable independent of that architectural detail.
  codeHardSkip: boolean;
  // null when Gemini enrichment did not run or failed (e.g. all API keys exhausted) —
  // the job passes through unenriched, same as before this change.
  geminiScore: number | null;
  geminiHardSkip: boolean;
  geminiHardSkipReason?: string | null;
  isSuspicious?: boolean;
  fraudScore?: number;
  relevanceThreshold?: number;
}

export type ReconciliationReason =
  | 'hard_skip'
  | 'below_threshold'
  | 'suspicious_fraud'
  | 'no_ai_data'
  | 'relevant';

export interface ReconciliationResult {
  relevant: boolean;
  reason: ReconciliationReason;
  logLine: string;
}

const DEFAULT_RELEVANCE_THRESHOLD = 55;

export function reconcileScores(input: ReconciliationInput): ReconciliationResult {
  const threshold = input.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const hardSkip = input.codeHardSkip || input.geminiHardSkip;

  let relevant = true;
  let reason: ReconciliationReason = 'relevant';

  if (input.geminiScore === null) {
    relevant = !input.codeHardSkip;
    reason = input.codeHardSkip ? 'hard_skip' : 'no_ai_data';
  } else if (hardSkip) {
    relevant = false;
    reason = 'hard_skip';
  } else if (input.geminiScore < threshold) {
    relevant = false;
    reason = 'below_threshold';
  } else if (input.isSuspicious) {
    relevant = false;
    reason = 'suspicious_fraud';
  }

  const reasonSuffix = reason === 'hard_skip' && input.geminiHardSkipReason
    ? ` (${input.geminiHardSkipReason})`
    : '';

  const logLine =
    `[scoring] job="${input.jobLabel}" code_score=${input.codeScore} ` +
    `gemini_score=${input.geminiScore ?? 'n/a'} ` +
    `hard_skip=[code:${input.codeHardSkip}, gemini:${input.geminiHardSkip}] ` +
    `final=${relevant ? 'RELEVANT' : 'NOT_RELEVANT'}` +
    (reason !== 'relevant' ? ` reason=${reason}${reasonSuffix}` : '');

  return { relevant, reason, logLine };
}
