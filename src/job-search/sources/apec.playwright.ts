import { redisGet } from '../redis-store';

// Kept for app.service.ts dashboard compatibility — Playwright scraping removed.

export interface ApecPlaywrightJob {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  date: string;
}

export interface ApecPlaywrightStatus {
  lastRun: string | null;
  jobsFound: number;
  status: 'ok' | 'timeout' | 'blocked' | 'error' | 'never run';
  nextRun: string | null;
}

const REDIS_STATUS_KEY = 'apec:playwright:status';

export async function getApecPlaywrightStatus(): Promise<ApecPlaywrightStatus> {
  const raw = await redisGet(REDIS_STATUS_KEY);
  if (!raw) return { lastRun: null, jobsFound: 0, status: 'never run', nextRun: null };
  try {
    return JSON.parse(raw) as ApecPlaywrightStatus;
  } catch {
    return { lastRun: null, jobsFound: 0, status: 'never run', nextRun: null };
  }
}
