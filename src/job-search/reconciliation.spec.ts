import { reconcileScores } from './reconciliation';

describe('reconcileScores', () => {
  it('both agree relevant: passes and logs both scores', () => {
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Acme',
      codeScore: 78,
      codeHardSkip: false,
      geminiScore: 85,
      geminiHardSkip: false,
    });
    expect(result.relevant).toBe(true);
    expect(result.reason).toBe('relevant');
    expect(result.logLine).toContain('code_score=78');
    expect(result.logLine).toContain('gemini_score=85');
    expect(result.logLine).toContain('final=RELEVANT');
  });

  it('both agree not relevant: code flags a skip and Gemini also scores it low', () => {
    const result = reconcileScores({
      jobLabel: '"Team Lead" @ Acme',
      codeScore: 40,
      codeHardSkip: true,
      geminiScore: 20,
      geminiHardSkip: true,
      geminiHardSkipReason: 'Rule 4: primary responsibility is people management',
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe('hard_skip');
    expect(result.logLine).toContain('hard_skip=[code:true, gemini:true]');
    expect(result.logLine).toContain('final=NOT_RELEVANT');
  });

  it('code flags a hard skip but Gemini does not: code veto wins, no averaging', () => {
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Theodo',
      codeScore: 70,
      codeHardSkip: true,
      geminiScore: 92,
      geminiHardSkip: false,
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe('hard_skip');
  });

  it('Gemini flags a hard skip but code does not: Gemini veto wins, no averaging', () => {
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Acme',
      codeScore: 65,
      codeHardSkip: false,
      geminiScore: 95,
      geminiHardSkip: true,
      geminiHardSkipReason: 'Rule 1: primary stack is Python, Node.js not mentioned',
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe('hard_skip');
    expect(result.logLine).toContain('code_score=65');
    expect(result.logLine).toContain('gemini_score=95');
    expect(result.logLine).toContain('reason=hard_skip (Rule 1: primary stack is Python, Node.js not mentioned)');
  });

  it('high divergence with neither flagging a skip: Gemini score above threshold wins, resolves clearly', () => {
    // This is the exact 65/95 divergence from the bug report, with no hard skip on
    // either side — the fix makes the outcome unambiguous instead of a mystery.
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Acme',
      codeScore: 65,
      codeHardSkip: false,
      geminiScore: 95,
      geminiHardSkip: false,
    });
    expect(result.relevant).toBe(true);
    expect(result.reason).toBe('relevant');
    expect(result.logLine).toBe(
      '[scoring] job="\"Backend Engineer\" @ Acme" code_score=65 gemini_score=95 hard_skip=[code:false, gemini:false] final=RELEVANT',
    );
  });

  it('high divergence the other way: below-threshold Gemini score rejects even with a high code score', () => {
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Acme',
      codeScore: 90,
      codeHardSkip: false,
      geminiScore: 30,
      geminiHardSkip: false,
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe('below_threshold');
  });

  it('rejects on fraud suspicion even when the score clears the threshold and no hard skip fired', () => {
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Acme',
      codeScore: 70,
      codeHardSkip: false,
      geminiScore: 80,
      geminiHardSkip: false,
      isSuspicious: true,
      fraudScore: 90,
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe('suspicious_fraud');
  });

  it('passes an unenriched job through when Gemini enrichment did not run (null score) and code found no skip', () => {
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Acme',
      codeScore: 70,
      codeHardSkip: false,
      geminiScore: null,
      geminiHardSkip: false,
    });
    expect(result.relevant).toBe(true);
    expect(result.reason).toBe('no_ai_data');
    expect(result.logLine).toContain('gemini_score=n/a');
  });

  it('still rejects an unenriched job if the code-side filter itself flagged a hard skip', () => {
    const result = reconcileScores({
      jobLabel: '"Backend Engineer" @ Theodo',
      codeScore: 70,
      codeHardSkip: true,
      geminiScore: null,
      geminiHardSkip: false,
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe('hard_skip');
  });
});
