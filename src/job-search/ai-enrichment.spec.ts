import {
  buildGoogleGenAIOptions,
  buildHistoryContext,
  buildHistoryDescExcerpt,
  CANDIDATE_PROFILE,
  enrichMatch,
  evaluateGeminiScoring,
  GeminiRawScoring,
  HARD_SKIP_RULEBOOK,
  MODELS,
  parseGeminiReply,
  SYSTEM_INSTRUCTION,
} from './ai-enrichment';
import { reconcileScores, UNSCORED_TAG } from './reconciliation';
import { MatchResult, SearchProfile } from './types';

describe('buildGoogleGenAIOptions', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GEMINI_RELAY_URL;
    delete process.env.GEMINI_RELAY_SECRET;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('uses the direct Google client with no httpOptions when GEMINI_RELAY_URL is unset', () => {
    const options = buildGoogleGenAIOptions('test-key');
    expect(options).toEqual({ apiKey: 'test-key' });
    expect(options.httpOptions).toBeUndefined();
  });

  it('routes through the relay URL with the secret header when GEMINI_RELAY_URL is set', () => {
    process.env.GEMINI_RELAY_URL = 'https://jobsscrapper-gemini-relay.example.workers.dev';
    process.env.GEMINI_RELAY_SECRET = 'super-secret';

    const options = buildGoogleGenAIOptions('test-key');

    expect(options.apiKey).toBe('test-key');
    expect(options.httpOptions?.baseUrl).toBe('https://jobsscrapper-gemini-relay.example.workers.dev');
    expect(options.httpOptions?.headers).toEqual({ 'x-relay-secret': 'super-secret' });
  });
});

describe('evaluateGeminiScoring', () => {
  // Fixture: Gemini correctly identifies a hard-skip case (rule 1 — wrong primary stack)
  // but, left ungoverned, still hands back a high relevanceScore based on generic "job
  // quality". This is exactly the 65/95-style divergence the rulebook exists to prevent —
  // the server-side force to 0 must win regardless of what the model put in the field.
  const hardSkipFixture: GeminiRawScoring = {
    hardSkipTriggered: true,
    hardSkipReason: 'Rule 1: primary stack is Python/Django, Node.js not mentioned',
    languageAssessment: 'No language requirement stated, JD is in English',
    stackMatch: 'Primary stack is Python/Django, Node.js not mentioned anywhere',
    experienceNote: 'Requires 4+ years, matches candidate experience',
    confidence: 'high',
    reasoning: 'Strong company and comp, but wrong primary backend language rules this out.',
    relevanceScore: 95,
  };

  const cleanPassFixture: GeminiRawScoring = {
    hardSkipTriggered: false,
    hardSkipReason: null,
    languageAssessment: 'English explicitly required, international team mentioned',
    stackMatch: 'Node.js and NestJS both explicitly required, strong match',
    experienceNote: 'Requires 3-5 years, candidate has 4 — within range',
    confidence: 'high',
    reasoning: 'Pure backend Node.js/NestJS role, TypeScript required, EU based, strong fit.',
    relevanceScore: 88,
  };

  const ambiguousLanguageFixture: GeminiRawScoring = {
    hardSkipTriggered: false,
    hardSkipReason: null,
    languageAssessment: 'No explicit language requirement stated, no non-English signal detected, company site did not clarify',
    stackMatch: 'Node.js explicitly required as primary backend',
    experienceNote: 'No experience requirement stated',
    confidence: 'low',
    reasoning: 'Strong stack match but working language could not be confirmed either way.',
    relevanceScore: 70,
  };

  it('forces relevanceScore to 0 when hardSkipTriggered is true, regardless of the score Gemini supplied', () => {
    const result = evaluateGeminiScoring(hardSkipFixture);
    expect(result.hardSkipTriggered).toBe(true);
    expect(result.relevanceScore).toBe(0);
    expect(result.hardSkipReason).toBe('Rule 1: primary stack is Python/Django, Node.js not mentioned');
  });

  it('passes through the score and null hard-skip reason for a clean-pass case', () => {
    const result = evaluateGeminiScoring(cleanPassFixture);
    expect(result.hardSkipTriggered).toBe(false);
    expect(result.hardSkipReason).toBeNull();
    expect(result.relevanceScore).toBe(88);
    expect(result.confidence).toBe('high');
  });

  it('lowers confidence rather than hard-skipping for an unconfirmed/ambiguous language case', () => {
    const result = evaluateGeminiScoring(ambiguousLanguageFixture);
    expect(result.hardSkipTriggered).toBe(false);
    expect(result.confidence).toBe('low');
    expect(result.relevanceScore).toBe(70);
    expect(result.languageAssessment).toContain('no non-English signal detected');
  });

  it('defaults hardSkipReason to a fallback string when Gemini omits it despite triggering', () => {
    const result = evaluateGeminiScoring({ hardSkipTriggered: true, relevanceScore: 60 });
    expect(result.relevanceScore).toBe(0);
    expect(result.hardSkipReason).toBe('hard skip rule triggered (no reason given)');
  });

  it('defaults confidence to "medium" when Gemini returns an unrecognized value', () => {
    const result = evaluateGeminiScoring({ confidence: 'sure', relevanceScore: 50 } as unknown as GeminiRawScoring);
    expect(result.confidence).toBe('medium');
  });

  it('clamps relevanceScore into 0-100 and defaults to 50 when missing', () => {
    expect(evaluateGeminiScoring({ relevanceScore: 150 }).relevanceScore).toBe(100);
    expect(evaluateGeminiScoring({ relevanceScore: -10 }).relevanceScore).toBe(0);
    expect(evaluateGeminiScoring({}).relevanceScore).toBe(50);
  });
});

describe('buildHistoryDescExcerpt', () => {
  // Calibration must compare against real JD content, not just title/company/location —
  // this is what both the PostgreSQL-backed and Redis-backed history paths call to turn a
  // stored job description into the excerpt that actually reaches historyContext and the
  // Gemini prompt.
  it('truncates a long job description to the 500-char calibration excerpt length', () => {
    const longDescription = 'A'.repeat(2000);
    const excerpt = buildHistoryDescExcerpt(longDescription);
    expect(excerpt).toHaveLength(500);
    expect(excerpt).toBe('A'.repeat(500));
  });

  it('passes short descriptions through unchanged', () => {
    expect(buildHistoryDescExcerpt('Node.js backend role, 6 ans d\'experience requis')).toBe(
      'Node.js backend role, 6 ans d\'experience requis',
    );
  });

  it('returns undefined for null or undefined input (no JD text available)', () => {
    expect(buildHistoryDescExcerpt(null)).toBeUndefined();
    expect(buildHistoryDescExcerpt(undefined)).toBeUndefined();
  });
});

describe('parseGeminiReply — malformed replies never reject a job', () => {
  it.each([
    ['empty string', ''],
    ['undefined', undefined],
    ['truncated JSON', '{"relevanceScore": 8'],
    ['markdown-wrapped text', 'Here is the JSON: {"relevanceScore": 80}'],
    ['a JSON array', '[1, 2, 3]'],
    ['an empty object (no score)', '{}'],
    ['a non-numeric score', '{"relevanceScore": "high"}'],
  ])('returns null for %s', (_label, text) => {
    expect(parseGeminiReply(text)).toBeNull();
  });

  it('returns the parsed object for a valid reply', () => {
    expect(parseGeminiReply('{"relevanceScore": 72, "fraudScore": 5}')).toMatchObject({ relevanceScore: 72, fraudScore: 5 });
  });

  it('accepts a hard skip that omits relevanceScore (scored as 0 downstream)', () => {
    const raw = parseGeminiReply('{"hardSkipTriggered": true, "hardSkipReason": "Rule 3: 6 years minimum"}');
    expect(raw).not.toBeNull();
    expect(evaluateGeminiScoring(raw as GeminiRawScoring).relevanceScore).toBe(0);
  });

  it('an unscored job (null score) passes reconciliation with reason "unscored"', () => {
    const result = reconcileScores({ jobLabel: 'x', codeScore: 70, codeHardSkip: false, geminiScore: null, geminiHardSkip: false });
    expect(result).toMatchObject({ relevant: true, reason: 'unscored' });
  });
});

describe('enrichMatch — unscored tagging', () => {
  const ORIGINAL_ENV = process.env;
  beforeAll(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GEMINI_API_KEY;
    for (let i = 1; i <= 10; i++) delete process.env[`GEMINI_API_KEY_${i}`];
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns null and tags the job "unscored" exactly once when Gemini cannot score it', async () => {
    const match = { job: { company: 'Acme' }, reasons: ['Location fit: Paris'] } as unknown as MatchResult;
    const profile = {} as SearchProfile;
    expect(await enrichMatch(match, profile)).toBeNull();
    await enrichMatch(match, profile);
    expect(match.reasons).toEqual(['Location fit: Paris', UNSCORED_TAG]);
  });
});

describe('Gemini prompt content', () => {
  const prompt = SYSTEM_INSTRUCTION('Uman', 4, 'CV text', 'remote', 'FR', 'visa', 'status', 'apec.fr');

  it('states the candidate profile', () => {
    expect(prompt).toContain(CANDIDATE_PROFILE);
    for (const fact of [
      '4 years production backend',
      'Node.js, NestJS, TypeScript, PostgreSQL, MongoDB, Redis, Docker, GitHub Actions, AWS EC2 and S3',
      'Kafka and RabbitMQ',
      'English fluent, French A1',
    ]) {
      expect(CANDIDATE_PROFILE).toContain(fact);
    }
  });

  it('has the 5+ years and English-not-accepted hard-skip rules, and no 6-year cap', () => {
    expect(HARD_SKIP_RULEBOOK).toContain('9 rules');
    expect(HARD_SKIP_RULEBOOK).toContain('EXPERIENCE FLOOR OF 5+');
    expect(HARD_SKIP_RULEBOOK).toContain('ENGLISH NOT ACCEPTED AS A WORKING LANGUAGE');
    expect(HARD_SKIP_RULEBOOK).not.toMatch(/6\+|6-year/);
  });

  it('never asks Gemini to use web search', () => {
    expect(prompt.toLowerCase()).not.toContain('web search');
  });
});

describe('buildHistoryContext', () => {
  const applied = [{ title: 'Backend Engineer', company: 'A', score: 80, stack: 'NestJS', roleType: 'backend' }];
  const dismissed = [{ title: 'Fullstack Angular', company: 'B', score: 60, stack: 'Angular', roleType: 'fullstack' }];

  it('returns an empty string when there is no history', () => {
    expect(buildHistoryContext([], [])).toBe('');
  });

  it('has no hardcoded KEY LEARNINGS and only the system-instruction point values', () => {
    const ctx = buildHistoryContext(applied, dismissed);
    expect(ctx).not.toContain('KEY LEARNINGS');
    expect(ctx).toContain('reduce by 15 points');
    expect(ctx).toContain('reduce by 20 points');
    expect(ctx).toContain('increase by 15 points');
    const points = (ctx.match(/(?:reduce|increase) by (\d+) points/g) ?? []).sort();
    expect(points).toEqual(['increase by 15 points', 'reduce by 15 points', 'reduce by 20 points']);
    expect(ctx).toContain('Backend Engineer @ A');
    expect(ctx).toContain('Fullstack Angular @ B');
  });

  it('uses the same point values as the system instruction CALIBRATION section', () => {
    const prompt = SYSTEM_INSTRUCTION('Uman', 4, 'CV', 'remote', 'FR', 'visa', 'status');
    expect(prompt).toContain('Same primary stack as dismissed -> reduce by 15 points');
    expect(prompt).toContain('as dismissed -> reduce by 20 points');
    expect(prompt).toContain('Same stack and role type -> increase by 15 points');
  });
});

describe('MODELS', () => {
  it('contains no retired or non-existent model IDs', () => {
    expect(MODELS).not.toContain('gemini-2.5-flash-8b');
    expect(MODELS).not.toContain('gemini-2.0-flash-exp');
    expect(MODELS).toEqual(['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  });
});
