import { redisGet, redisSetJson } from '../redis-store';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApecPlaywrightJob {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  date: string;
}

export interface ApecPlaywrightStatus {
  lastRun: string | null;   // ISO 8601
  jobsFound: number;
  status: 'ok' | 'timeout' | 'blocked' | 'error' | 'never run';
  nextRun: string | null;   // ISO 8601
}

// ── Constants ────────────────────────────────────────────────────────────────

const PLAYWRIGHT_ENABLED = process.env.PLAYWRIGHT_ENABLED === 'true';
const REDIS_LAST_RUN_KEY = 'apec:playwright:lastRun';
const REDIS_STATUS_KEY = 'apec:playwright:status';
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const BROWSER_TIMEOUT_MS = 60_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SEARCH_URLS = [
  'https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=nodejs&typeContrat=101888&experienceMin=2&experienceMax=6',
  'https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=nestjs&typeContrat=101888',
  'https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=typescript+backend&typeContrat=101888',
];

// ── Public API ───────────────────────────────────────────────────────────────

export async function scrapeApecWithPlaywright(): Promise<ApecPlaywrightJob[]> {
  if (!PLAYWRIGHT_ENABLED) {
    console.log('[apec] Playwright disabled, set PLAYWRIGHT_ENABLED=true in Render env to enable');
    return [];
  }

  // Rate-limit: only run once every 6 hours
  const lastRunRaw = await redisGet(REDIS_LAST_RUN_KEY);
  if (lastRunRaw) {
    const lastRunMs = Number(lastRunRaw);
    if (!isNaN(lastRunMs) && Date.now() - lastRunMs < COOLDOWN_MS) {
      const nextRun = new Date(lastRunMs + COOLDOWN_MS).toISOString();
      console.log(`[apec] playwright cooldown active — next run at ${nextRun}`);
      return [];
    }
  }

  const heapBefore = process.memoryUsage().heapUsed;
  console.log(`[apec] playwright heap before: ${Math.round(heapBefore / 1024 / 1024)}MB`);

  let jobs: ApecPlaywrightJob[] = [];
  let statusResult: ApecPlaywrightStatus['status'] = 'ok';

  // Race the entire scrape against a hard timeout
  try {
    jobs = await Promise.race([
      runPlaywrightScrape(),
      new Promise<ApecPlaywrightJob[]>((_, reject) =>
        setTimeout(() => reject(new Error('PLAYWRIGHT_TIMEOUT')), BROWSER_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'PLAYWRIGHT_TIMEOUT' || msg.includes('TimeoutError') || msg.includes('timeout')) {
      console.log('[apec] playwright timeout, DataDome may have updated');
      statusResult = 'timeout';
    } else if (msg.toLowerCase().includes('executable') || msg.toLowerCase().includes('chromium')) {
      console.log('[apec] Chromium not installed, run npx playwright install chromium');
      statusResult = 'error';
    } else {
      console.log(`[apec] playwright error: ${msg}`);
      statusResult = jobs.length === 0 ? 'blocked' : 'error';
    }
  }

  const heapAfter = process.memoryUsage().heapUsed;
  console.log(`[apec] playwright heap after: ${Math.round(heapAfter / 1024 / 1024)}MB`);

  // Persist run metadata to Redis
  const now = new Date().toISOString();
  const nowMs = Date.now();
  await Promise.all([
    redisSetJson(REDIS_LAST_RUN_KEY, String(nowMs)),
    redisSetJson<ApecPlaywrightStatus>(REDIS_STATUS_KEY, {
      lastRun: now,
      jobsFound: jobs.length,
      status: statusResult,
      nextRun: new Date(nowMs + COOLDOWN_MS).toISOString(),
    }),
  ]);

  return jobs;
}

export async function getApecPlaywrightStatus(): Promise<ApecPlaywrightStatus> {
  const raw = await redisGet(REDIS_STATUS_KEY);
  if (!raw) return { lastRun: null, jobsFound: 0, status: 'never run', nextRun: null };
  try {
    return JSON.parse(raw) as ApecPlaywrightStatus;
  } catch {
    return { lastRun: null, jobsFound: 0, status: 'never run', nextRun: null };
  }
}

// ── Internal scrape ──────────────────────────────────────────────────────────

async function runPlaywrightScrape(): Promise<ApecPlaywrightJob[]> {
  // Dynamic import so the module loads even when playwright packages are absent.
  // The PLAYWRIGHT_ENABLED guard above will have already returned [] before reaching here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require('playwright-extra') as typeof import('playwright-extra');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stealth = require('playwright-extra-plugin-stealth')();
  chromium.use(stealth);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  });

  const jobMap = new Map<string, ApecPlaywrightJob>();

  try {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();

    for (const url of SEARCH_URLS) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

        // Wait for job results or 8s, whichever comes first
        await Promise.race([
          page.waitForSelector('.result-item', { timeout: 8_000 }).catch(() => {}),
          new Promise((r) => setTimeout(r, 8_000)),
        ]);

        const pageJobs = await extractJobs(page);
        for (const job of pageJobs) {
          if (job.url) jobMap.set(job.url, job);
        }

        // Random 3–5s delay between navigations
        const delay = 3000 + Math.random() * 2000;
        await new Promise((r) => setTimeout(r, delay));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[apec] playwright page error for ${url}: ${msg}`);
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return Array.from(jobMap.values());
}

async function extractJobs(page: import('playwright').Page): Promise<ApecPlaywrightJob[]> {
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.result-item, [class*="offer-item"], [class*="job-item"]'));
    return items.map((el) => {
      const titleEl = el.querySelector('[class*="title"], h2, h3, .offer-title');
      const companyEl = el.querySelector('[class*="company"], [class*="entreprise"], .company-name');
      const locationEl = el.querySelector('[class*="location"], [class*="lieu"], .location');
      const linkEl = el.querySelector('a[href]');
      const descEl = el.querySelector('[class*="description"], [class*="excerpt"], p');
      const dateEl = el.querySelector('[class*="date"], time, .date');

      const href = linkEl?.getAttribute('href') ?? '';
      const url = href.startsWith('http') ? href : href ? `https://www.apec.fr${href}` : '';

      return {
        title: titleEl?.textContent?.trim() ?? '',
        company: companyEl?.textContent?.trim() ?? '',
        location: locationEl?.textContent?.trim() ?? '',
        url,
        description: descEl?.textContent?.trim() ?? '',
        date: dateEl?.textContent?.trim() ?? '',
      };
    }).filter((j) => j.title && j.url);
  });
}
