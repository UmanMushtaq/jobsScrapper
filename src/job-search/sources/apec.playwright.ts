import { chromium } from 'playwright';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { detectLanguage } from './language-detect';
import { redisGet, redisSetEx } from '../redis-store';
import { acquirePlaywrightLock } from './playwright-queue';

const SOURCE = 'apec.fr';
const BASE_URL = 'https://www.apec.fr';
const SEARCH_URL = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi';
const REDIS_STATUS_KEY = 'apec:playwright:status';

const SEARCH_QUERIES = [
  'nodejs',
  'node.js',
  'nestjs',
  'backend typescript',
  'développeur nodejs',
  'ingénieur backend nodejs',
];

export interface ApecPlaywrightStatus {
  lastRun: string | null;
  jobsFound: number;
  status: 'ok' | 'timeout' | 'blocked' | 'error' | 'never run';
  nextRun: string | null;
  playwrightEnabled: boolean;
}

export async function getApecPlaywrightStatus(): Promise<ApecPlaywrightStatus> {
  const raw = await redisGet(REDIS_STATUS_KEY);
  if (!raw) return { lastRun: null, jobsFound: 0, status: 'never run', nextRun: null, playwrightEnabled: true };
  try {
    return JSON.parse(raw) as ApecPlaywrightStatus;
  } catch {
    return { lastRun: null, jobsFound: 0, status: 'never run', nextRun: null, playwrightEnabled: true };
  }
}

export class ApecPlaywrightSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    return acquirePlaywrightLock(() => this._fetch(settings));
  }

  private async _fetch(settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    let browser;
    let status: ApecPlaywrightStatus['status'] = 'error';

    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--mute-audio',
          '--no-first-run',
          '--safebrowsing-disable-auto-update',
          '--js-flags=--max-old-space-size=128',
          '--single-process',
        ],
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        locale: 'fr-FR',
        extraHTTPHeaders: {
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      for (const query of SEARCH_QUERIES) {
        try {
          console.log(`[apec-playwright] searching: "${query}"`);
          const fetched = await fetchSearchPage(browser, context, query, cutoff);
          console.log(`[apec-playwright] found ${fetched.length} jobs for "${query}"`);
          for (const job of fetched) {
            jobs.set(job.canonicalUrl, job);
          }
          await sleep(2000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[apec-playwright] error for "${query}": ${msg}`);
        }
      }

      status = jobs.size > 0 ? 'ok' : 'blocked';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[apec-playwright] browser launch failed: ${msg}`);
      status = 'error';
    } finally {
      await browser?.close();
    }

    const result = Array.from(jobs.values());
    console.log(`[apec-playwright] ${result.length} unique jobs fetched`);

    const INTERVAL_MS = 180 * 60 * 1000;
    await redisSetEx(REDIS_STATUS_KEY, JSON.stringify({
      lastRun: new Date().toISOString(),
      jobsFound: result.length,
      status,
      nextRun: new Date(Date.now() + INTERVAL_MS).toISOString(),
      playwrightEnabled: true,
    }), 86400 * 7);

    return result;
  }
}

async function fetchSearchPage(
  browser: import('playwright').Browser,
  context: import('playwright').BrowserContext,
  query: string,
  cutoff: number,
): Promise<JobPosting[]> {
  const page = await context.newPage();
  const jobs: JobPosting[] = [];

  try {
    const searchUrl = `${SEARCH_URL}?motsCles=${encodeURIComponent(query)}&typesConvention=143684&typesConvention=143685&typesConvention=143686&typesConvention=143687&typesConvention=143706`;

    await page.goto(searchUrl, {
      waitUntil: 'networkidle',
      timeout: 60_000,
    });

    // Wait for job cards to render
    await page.waitForTimeout(3000);

    // Accept cookies if banner appears
    try {
      const cookieBtn = page.locator('button:has-text("Accepter"), button:has-text("Tout accepter"), #didomi-notice-agree-button');
      if (await cookieBtn.first().isVisible({ timeout: 3000 })) {
        await cookieBtn.first().click();
        await page.waitForTimeout(1000);
      }
    } catch { /* no cookie banner */ }

    // Extract job cards from rendered DOM
    const cards = await page.evaluate(() => {
      const results: Array<{
        title: string;
        company: string;
        location: string;
        url: string;
        salary: string;
        date: string;
      }> = [];

      // APEC renders job cards as list items or article elements
      const selectors = [
        '[class*="offer-item"]',
        '[class*="offre-item"]',
        '[class*="job-item"]',
        '[class*="result-item"]',
        'article',
        '[data-id-offre]',
        '[data-offre]',
      ];

      const seen = new Set<string>();

      for (const sel of selectors) {
        const elements = Array.from(document.querySelectorAll(sel));
        for (const el of elements) {
          const link = el.querySelector('a[href*="detail-offre"]') as HTMLAnchorElement | null;
          if (!link) continue;
          const href = link.getAttribute('href') ?? '';
          if (!href.includes('detail-offre')) continue;
          const url = href.startsWith('http') ? href : `https://www.apec.fr${href}`;
          if (seen.has(url)) continue;
          seen.add(url);

          const title = (
            el.querySelector('h2, h3, [class*="title"], [class*="intitule"]')?.textContent ??
            link.textContent ??
            ''
          ).trim();

          const company = (
            el.querySelector('[class*="company"], [class*="entreprise"], [class*="employer"], [class*="nom-commercial"]')?.textContent ?? ''
          ).trim();

          const location = (
            el.querySelector('[class*="location"], [class*="lieu"], [class*="localisation"], [class*="city"]')?.textContent ?? 'France'
          ).trim();

          const salary = (
            el.querySelector('[class*="salary"], [class*="salaire"], [class*="remuneration"]')?.textContent ?? ''
          ).trim();

          const date = (
            el.querySelector('[class*="date"], time')?.getAttribute('datetime') ??
            el.querySelector('[class*="date"], time')?.textContent ?? ''
          ).trim();

          if (title && url) {
            results.push({ title, company, location, salary, date, url });
          }
        }
      }

      // Fallback: find any links to detail-offre pages
      if (results.length === 0) {
        const links = Array.from(document.querySelectorAll('a[href*="detail-offre"]')) as HTMLAnchorElement[];
        for (const link of links) {
          const href = link.getAttribute('href') ?? '';
          const url = href.startsWith('http') ? href : `https://www.apec.fr${href}`;
          if (seen.has(url)) continue;
          seen.add(url);
          const title = link.textContent?.trim() ?? '';
          if (title && title.length > 5) {
            results.push({ title, company: '', location: 'France', salary: '', date: '', url });
          }
        }
      }

      return results;
    });

    if (cards.length === 0) {
      const preview = await page.evaluate(() => document.body.innerHTML.slice(0, 300).replace(/\s+/g, ' '));
      console.log(`[apec-playwright] 0 cards for "${query}" — preview: ${preview}`);
    }

    // For each job card, navigate to detail page to get full description
    for (const card of cards) {
      try {
        // Check date cutoff if we have a date
        if (card.date) {
          const pubMs = new Date(card.date).getTime();
          if (!isNaN(pubMs) && pubMs < cutoff) continue;
        }

        const description = await fetchDetailPage(browser, card.url);
        await sleep(800);

        const publishedAt = card.date ? new Date(card.date).toISOString() : new Date().toISOString();
        const publishedAtTimestamp = card.date
          ? Math.floor(new Date(card.date).getTime() / 1000)
          : Math.floor(Date.now() / 1000);

        const text = `${card.title} ${description}`.toLowerCase();
        const salary = parseSalary(card.salary);

        jobs.push({
          source: SOURCE,
          sourcePriority: 4,
          canonicalUrl: card.url,
          title: card.title,
          company: card.company || 'Non communiqué',
          companySummary: '',
          companySlug: (card.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          locationLabel: card.location ? `${card.location}` : 'France',
          countryCode: 'FR',
          city: card.location || null,
          workMode: inferWorkMode(text),
          language: detectLanguage(`${card.title} ${description.slice(0, 400)}`),
          description,
          keyMissions: [],
          experienceLevelMinimum: extractExperience(text),
          salaryCurrency: salary.currency,
          salaryPeriod: salary.period,
          salaryMinimum: salary.min,
          salaryMaximum: salary.max,
          salaryYearlyMinimum: salary.yearlyMin,
          publishedAt,
          publishedAtTimestamp,
          startupSignals: [],
          applyUrl: card.url,
          offersRelocation: false,
          isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
          employeeCount: null,
          companyCreationYear: null,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[apec-playwright] detail fetch failed for ${card.url}: ${msg}`);
      }
    }
  } finally {
    await page.close();
  }

  return jobs;
}

async function fetchDetailPage(
  browser: import('playwright').Browser,
  url: string,
): Promise<string> {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'fr-FR',
  });
  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForTimeout(3000);

    // Accept cookies if banner appears
    try {
      const cookieBtn = page.locator('button:has-text("Accepter"), button:has-text("Tout accepter"), #didomi-notice-agree-button');
      if (await cookieBtn.first().isVisible({ timeout: 2000 })) {
        await cookieBtn.first().click();
        await page.waitForTimeout(500);
      }
    } catch { /* no cookie banner */ }

    const description = await page.evaluate(() => {
      // Try known APEC description selectors
      const selectors = [
        '[class*="job-description"]',
        '[class*="offre-description"]',
        '[class*="description-offre"]',
        '[class*="texte-offre"]',
        '[class*="offer-description"]',
        '[class*="detail-offre"]',
        '[class*="content-offre"]',
        '[id*="description"]',
        '[id*="offre"]',
        '.job-details',
        '.offre-details',
        'section[class*="description"]',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          if (text.length > 100) return text;
        }
      }

      // Fallback: find the largest text block that looks like a job description
      // Skip blocks containing legal/cookie text
      const SKIP_PHRASES = [
        'conditions générales', 'protection de données', 'politique de',
        'cookies', 'mentions légales', 'droits d\'auteur', 'cgv', 'cgu',
      ];

      const blocks = Array.from(document.querySelectorAll('div, section, article'))
        .map((el) => ({ el, text: el.textContent?.replace(/\s+/g, ' ').trim() ?? '' }))
        .filter(({ text }) => {
          if (text.length < 200) return false;
          const lower = text.toLowerCase();
          return !SKIP_PHRASES.some((phrase) => lower.includes(phrase));
        })
        .sort((a, b) => b.text.length - a.text.length);

      return blocks[0]?.text ?? '';
    });

    console.log(`[apec-playwright] detail fetched (${description.length} chars) for ${url.split('/').pop()}`);
    return description;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[apec-playwright] detail page error: ${msg}`);
    return '';
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (containsAny(text, ['full remote', '100% remote', 'fully remote', 'télétravail complet', 'full télétravail', 'remote only'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail partiel', 'partial remote', 'work from home'])) return 'hybrid';
  if (text.includes('remote') || text.includes('télétravail')) return 'remote';
  return 'on-site';
}

function extractExperience(text: string): number | null {
  const plusMatch = text.match(/(\d+)\+\s*ans?/i) ?? text.match(/(\d+)\+\s*years?/i);
  if (plusMatch) return parseInt(plusMatch[1], 10);
  const patterns = [
    /minimum\s+(\d+)\s*ans?/i,
    /au\s+moins\s+(\d+)\s*ans?/i,
    /(\d+)\s*ans?\s*d['']expérience/i,
    /(\d+)\s*years?\s*(?:of\s+)?experience/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function parseSalary(salaryText: string): {
  currency: string | null;
  period: string | null;
  min: number | null;
  max: number | null;
  yearlyMin: number | null;
} {
  if (!salaryText) return { currency: null, period: null, min: null, max: null, yearlyMin: null };
  const currency = salaryText.includes('€') || /eur/i.test(salaryText) ? 'EUR' : null;
  const period = /annuel|\/an/i.test(salaryText) ? 'yearly' : /mensuel|\/mois/i.test(salaryText) ? 'monthly' : null;
  const numbers = salaryText.match(/[\d\s,.]+/g)?.map((n) => parseFloat(n.replace(/\s/g, '').replace(',', '.'))) ?? [];
  const valid = numbers.filter((n) => !isNaN(n) && n > 0);
  const min = valid[0] ?? null;
  const max = valid[1] ?? null;
  const yearlyMin = period === 'yearly' ? min : null;
  return { currency, period, min, max, yearlyMin };
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
