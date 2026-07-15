import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 10,
    });
  }
  return pool;
}

export async function initDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn('[postgres] DATABASE_URL not set, skipping PostgreSQL init');
    return;
  }
  const p = getPool()!;
  // Verify connectivity before creating tables
  await p.query('SELECT 1');
  console.log('[postgres] connected to Supabase successfully');
  await p.query(`
    CREATE TABLE IF NOT EXISTS job_decisions (
      id SERIAL PRIMARY KEY,
      job_url TEXT NOT NULL UNIQUE,
      job_title TEXT,
      company TEXT,
      source TEXT,
      matcher_score INTEGER,
      ai_score INTEGER,
      decision TEXT NOT NULL CHECK (decision IN ('applied', 'dismissed')),
      decided_at TIMESTAMP DEFAULT NOW(),
      country TEXT,
      salary_min INTEGER,
      salary_max INTEGER,
      primary_stack TEXT,
      role_type TEXT,
      job_description TEXT,
      cover_letter TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_job_decisions_decision
      ON job_decisions(decision);
    CREATE INDEX IF NOT EXISTS idx_job_decisions_decided_at
      ON job_decisions(decided_at DESC);
  `);
  console.log('[postgres] job_decisions table ready');
}

export async function saveJobDecision(params: {
  jobUrl: string;
  jobTitle: string;
  company: string;
  source: string;
  matcherScore: number;
  aiScore: number;
  decision: 'applied' | 'dismissed';
  country?: string;
  salaryMin?: number;
  salaryMax?: number;
  primaryStack?: string;
  roleType?: string;
  jobDescription?: string;
  coverLetter?: string;
}): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO job_decisions (
        job_url, job_title, company, source, matcher_score,
        ai_score, decision, country, salary_min, salary_max,
        primary_stack, role_type, job_description, cover_letter
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (job_url)
      DO UPDATE SET
        decision = EXCLUDED.decision,
        decided_at = NOW(),
        ai_score = EXCLUDED.ai_score,
        cover_letter = EXCLUDED.cover_letter`,
      [
        params.jobUrl, params.jobTitle, params.company,
        params.source, params.matcherScore, params.aiScore,
        params.decision, params.country ?? null,
        params.salaryMin ?? null, params.salaryMax ?? null,
        params.primaryStack ?? null, params.roleType ?? null,
        params.jobDescription ?? null, params.coverLetter ?? null,
      ],
    );
  } catch (err) {
    console.error('[postgres] saveJobDecision failed:', (err as Error).message);
  }
}

export interface PgDecisionRow {
  job_title: string;
  company: string;
  matcher_score: number;
  ai_score: number;
  primary_stack: string | null;
  role_type: string | null;
  job_description: string | null;
  country: string | null;
}

export interface AnalyticsDecisionRow {
  source: string;
  country: string | null;
  decision: 'applied' | 'dismissed';
  decidedAt: string; // ISO
}

// Broader than getJobDecisionHistory below (which caps at 20/50 rows specifically for
// Gemini calibration prompt size) — this powers the /analytics page's historical charts,
// so it needs the full decided-jobs population within a bounded cap, not just the most
// recent handful. No new table: same job_decisions rows, a different SELECT.
export async function getAllJobDecisionsForAnalytics(limit = 5000): Promise<AnalyticsDecisionRow[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const result = await p.query<{
      source: string | null;
      country: string | null;
      decision: 'applied' | 'dismissed';
      decided_at: string;
    }>(
      `SELECT source, country, decision, decided_at
       FROM job_decisions
       ORDER BY decided_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((r) => ({
      source: r.source ?? 'unknown',
      country: r.country,
      decision: r.decision,
      decidedAt: new Date(r.decided_at).toISOString(),
    }));
  } catch (err) {
    console.error('[postgres] getAllJobDecisionsForAnalytics failed:', (err as Error).message);
    return [];
  }
}

export async function getJobDecisionHistory(appliedLimit = 20, dismissedLimit = 50): Promise<{
  applied: PgDecisionRow[];
  dismissed: PgDecisionRow[];
}> {
  const p = getPool();
  if (!p) return { applied: [], dismissed: [] };
  try {
    const [applied, dismissed] = await Promise.all([
      p.query<PgDecisionRow>(
        `SELECT job_title, company, matcher_score, ai_score,
                primary_stack, role_type, job_description, country
         FROM job_decisions
         WHERE decision = 'applied'
         ORDER BY decided_at DESC
         LIMIT $1`,
        [appliedLimit],
      ),
      p.query<PgDecisionRow>(
        `SELECT job_title, company, matcher_score, ai_score,
                primary_stack, role_type, job_description, country
         FROM job_decisions
         WHERE decision = 'dismissed'
         ORDER BY decided_at DESC
         LIMIT $1`,
        [dismissedLimit],
      ),
    ]);
    return { applied: applied.rows, dismissed: dismissed.rows };
  } catch (err) {
    console.error('[postgres] getJobDecisionHistory failed:', (err as Error).message);
    return { applied: [], dismissed: [] };
  }
}
