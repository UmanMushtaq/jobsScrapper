import { chromium } from 'playwright';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { detectLanguage } from './language-detect';
import { acquirePlaywrightLock } from './playwright-queue';

const SOURCE = 'nofluffjobs.com';
const BASE_URL = 'https://nofluffjobs.com';

const SEARCH_PAGES = [
  '/jobs/backend?criteria=requirement%3Dnode.js',
  '/jobs/backend?criteria=requirement%3Dnestjs',
  '/jobs/backend?criteria=requirement%3Dtypescript',
];

export class NoFluffJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(_queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    return acquirePlaywrightLock(() => this._fetch(settings));
  }

  private async _fetch(settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();
    const cutoff = Date.now() - Math.max(settings.maxAgeHours, 168) * 60 * 60 * 1000;

    let browser;
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
        locale: 'en-US',
      });

      for (const path of SEARCH_PAGES) {
        try {
          const fetched = await fetchSearchPage(context, `${BASE_URL}${path}`, cutoff);
          console.log(`[nofluffjobs] found ${fetched.length} jobs for "${path}"`);
          for (const job of fetched) jobs.set(job.canonicalUrl, job);
          await sleep(2000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[nofluffjobs] error for "${path}": ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[nofluffjobs] browser launch failed: ${msg}`);
    } finally {
      await browser?.close();
    }

    console.log(`[nofluffjobs] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchSearchPage(
  context: import('playwright').BrowserContext,
  url: string,
  cutoff: number,
): Promise<JobPosting[]> {
  const page = await context.newPage();
  const jobs: JobPosting[] = [];

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4000);

    // Accept cookies if banner appears
    try {
      const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("Agree"), #onetrust-accept-btn-handler, [class*="cookie"] button');
      if (await cookieBtn.first().isVisible({ timeout: 3000 })) {
        await cookieBtn.first().click();
        await page.waitForTimeout(1000);
      }
    } catch { /* no cookie banner */ }

    const cards = await page.evaluate(() => {
      const results: Array<{
        title: string;
        company: string;
        location: string;
        url: string;
        salary: string;
        workMode: string;
        date: string;
        skills: string;
      }> = [];

      const seen = new Set<string>();

      // nofluffjobs renders job cards as list items with postings links
      const links = Array.from(
        document.querySelectorAll('a[href*="/job/"], a[href*="/posting/"]')
      ) as HTMLAnchorElement[];

      for (const link of links) {
        const href = link.getAttribute('href') ?? '';
        const url = href.startsWith('http') ? href : `https://nofluffjobs.com${href}`;
        if (seen.has(url)) continue;
        seen.add(url);

        const card = link.closest('li, article, [class*="posting"], [class*="job-item"]') ?? link.parentElement;

        const title = (
          card?.querySelector('h2, h3, h4, [class*="title"], [class*="position"]')?.textContent ??
          link.textContent ?? ''
        ).trim();

        if (!title || title.length < 5) continue;

        const company = (
          card?.querySelector('[class*="company"], [class*="employer"], [class*="name"]')?.textContent ?? ''
        ).trim();

        const location = (
          card?.querySelector('[class*="location"], [class*="city"], [class*="place"]')?.textContent ?? 'Poland'
        ).trim();

        const salary = (
          card?.querySelector('[class*="salary"], [class*="pay"], [class*="rate"]')?.textContent ?? ''
        ).trim();

        const workMode = (
          card?.querySelector('[class*="remote"], [class*="workplace"], [class*="work-mode"]')?.textContent ?? ''
        ).trim().toLowerCase();

        const date = (
          card?.querySelector('time')?.getAttribute('datetime') ??
          card?.querySelector('[class*="date"], [class*="posted"]')?.textContent ?? ''
        ).trim();

        const skills = Array.from(
          card?.querySelectorAll('[class*="skill"], [class*="tech"], [class*="tag"], [class*="requirement"]') ?? []
        ).map((el) => el.textContent?.trim() ?? '').filter(Boolean).join(', ');

        results.push({ title, company, location, url, salary, workMode, date, skills });
      }

      return results;
    });

    if (cards.length === 0) {
      const preview = await page.evaluate(() => document.body.innerHTML.slice(0, 300).replace(/\s+/g, ' '));
      console.log(`[nofluffjobs] 0 cards for "${url}" — preview: ${preview}`);
    }

    for (const card of cards) {
      if (!card.title || !card.url) continue;

      if (card.date) {
        const pubMs = new Date(card.date).getTime();
        if (!isNaN(pubMs) && pubMs < cutoff) continue;
      }

      const publishedAt = card.date ? new Date(card.date).toISOString() : new Date().toISOString();
      const publishedAtTimestamp = card.date
        ? Math.floor(new Date(card.date).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

      const workMode = inferWorkMode(card.workMode);
      const salary = parseSalary(card.salary);
      const description = card.skills ? `Skills: ${card.skills}` : '';

      jobs.push({
        source: SOURCE,
        sourcePriority: 5,
        canonicalUrl: card.url,
        title: card.title,
        company: card.company || 'Unknown',
        companySummary: '',
        companySlug: (card.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        locationLabel: card.location ? `${card.location}, Poland` : 'Poland',
        countryCode: 'PL',
        city: card.location || null,
        workMode,
        language: detectLanguage(card.title),
        description,
        keyMissions: [],
        experienceLevelMinimum: null,
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
        isStartup: false,
        employeeCount: null,
        companyCreationYear: null,
      });
    }
  } finally {
    await page.close();
  }

  return jobs;
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  const lower = text.toLowerCase();
  if (lower.includes('remote') || lower.includes('fully remote')) return 'remote';
  if (lower.includes('hybrid')) return 'hybrid';
  return 'on-site';
}

function parseSalary(salaryText: string): {
  currency: string | null;
  period: string | null;
  min: number | null;
  max: number | null;
  yearlyMin: number | null;
} {
  if (!salaryText) return { currency: null, period: null, min: null, max: null, yearlyMin: null };
  const currency = salaryText.includes('PLN') ? 'PLN' : salaryText.includes('EUR') ? 'EUR' : salaryText.includes('USD') ? 'USD' : null;
  const numbers = salaryText.match(/[\d\s]+/g)?.map((n) => parseInt(n.replace(/\s/g, ''), 10)).filter((n) => !isNaN(n) && n > 100) ?? [];
  const min = numbers[0] ?? null;
  const max = numbers[1] ?? null;
  return { currency, period: min ? 'monthly' : null, min, max, yearlyMin: min && currency === 'PLN' ? min * 12 : min };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
