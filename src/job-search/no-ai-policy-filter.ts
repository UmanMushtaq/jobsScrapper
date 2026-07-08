// Deterministic filter — same layer as stack-filter.ts and language-requirement-filter.ts.
// Uman's application workflow (cover letters, short answers) is AI-assisted end to end,
// so a posting that disqualifies AI-assisted applications is unusable regardless of how
// well the role otherwise fits. Patterns are scoped to the APPLICATION PROCESS itself —
// a JD that simply discusses AI as part of the job's own tech stack or daily work must
// never be rejected by this filter.

export interface NoAiPolicyResult {
  reject: boolean;
  reason: string;
}

const NO_AI_APPLICATION_PATTERNS: RegExp[] = [
  /without any ai[- ]generated assistance/i,
  /use of ai\b.{0,40}(?:will result in disqualification|disqualified)/i,
  /no ai(?:-generated)? (?:applications|content)/i,
  /ai tools? (?:are )?(?:not permitted|prohibited) in (?:the )?application/i,
];

export function hasNoAiApplicationPolicy(description: string): NoAiPolicyResult {
  const text = description ?? '';
  const matched = NO_AI_APPLICATION_PATTERNS.find((p) => p.test(text));
  if (matched) {
    return { reject: true, reason: `application disqualifies AI-assisted applications (matched: ${matched})` };
  }
  return { reject: false, reason: '' };
}
