import { chromium } from 'playwright';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { JobSource } from './registry';
import { acquirePlaywrightLock } from './playwright-queue';

const SOURCE = 'eurobrussels.com';
const BASE_URL = 'https://www.eurobrussels.com';

const SEARCH_QUERIES = ['nodejs', 'node.js', 'nestjs', 'typescript backend', 'backend node'];

export class EuroBrusselsSource implements JobSource {
  name = SOURCE;
  priority = 4;

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
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
      });

      for (const query of SEARCH_QUERIES) {
        try {
          const fetched = await fetchQuery(context, query, cutoff);
          for (const job of fetched) jobs.set(job.canonicalUrl, job);
          await sleep(2000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
            console.error(`[eurobrussels] error for "${query}": ${msg}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[eurobrussels] browser launch failed: ${msg}`);
    } finally {
      await browser?.close();
    }

    if (jobs.size === 0) console.log(`[eurobrussels] 0 jobs — may be blocked or no results`);
    else console.log(`[eurobrussels] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchQuery(context: import('playwright').BrowserContext, query: string, _cutoff: number): Promise<JobPosting[]> {
  const page = await context.newPage();
  const jobs: JobPosting[] = [];

  try {
    await page.goto(`${BASE_URL}/jobs/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for job cards to appear
    await page.waitForSelector('a[href*="/job/"], .job-card, .job-listing, .vacancy, article', { timeout: 10_000 }).catch(() => {/* may not match */ });

    // Extract all job links + titles from the page
    const cards = await page.evaluate((baseUrl: string) => {
      const results: Array<{ title: string; company: string; location: string; url: string }> = [];
      // Try links that point to /job/ paths
      const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const seen = new Set<string>();
      for (const a of anchors) {
        const href = a.getAttribute('href') ?? '';
        // Only match actual job detail pages — must have /job/ followed by a slug/id, not query params
        // Exclude navigation links like /jobs/?category=... or /jobs/search/...
        if (!href.match(/\/job\/[a-z0-9_-]+/i)) continue;
        // Exclude links that are clearly filter/search navigation
        if (href.includes('?') && !href.includes('/job/')) continue;
        const url = href.startsWith('http') ? href : `${baseUrl}${href}`;
        if (seen.has(url)) continue;
        seen.add(url);
        const title = a.textContent?.trim() ?? '';
        if (!title || title.length < 5) continue;
        const card = a.closest('li, article, div[class*="job"], div[class*="vacancy"]');
        const company = card?.querySelector('[class*="company"], [class*="employer"], [class*="organisation"]')?.textContent?.trim() ?? '';
        const location = card?.querySelector('[class*="location"], [class*="city"]')?.textContent?.trim() ?? 'Brussels';
        results.push({ title, company, location, url });
      }
      return results;
    }, BASE_URL);

    for (const card of cards) {
      if (!card.title || !card.url) continue;
      const text = card.title.toLowerCase();
      jobs.push({
        source: SOURCE, sourcePriority: 4, canonicalUrl: card.url,
        title: card.title, company: card.company || 'Unknown', companySummary: '',
        companySlug: (card.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        locationLabel: `${card.location}, Belgium`,
        countryCode: inferCountryCode(`${card.location} Belgium`) || 'BE',
        city: card.location || null,
        workMode: text.includes('remote') ? 'remote' : text.includes('hybrid') ? 'hybrid' : 'on-site',
        language: detectLanguage(card.title),
        description: '', keyMissions: [], experienceLevelMinimum: null,
        salaryCurrency: null, salaryPeriod: null, salaryMinimum: null,
        salaryMaximum: null, salaryYearlyMinimum: null,
        publishedAt: new Date().toISOString(),
        publishedAtTimestamp: Math.floor(Date.now() / 1000),
        startupSignals: [], applyUrl: card.url,
        offersRelocation: false, isStartup: false,
        employeeCount: null, companyCreationYear: null,
      });
    }
  } finally {
    await page.close();
  }

  return jobs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
