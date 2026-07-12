import { chromium } from 'playwright';
import { JobPosting, SearchSettings } from '../types';
import { JobSource } from './registry';
import { detectLanguage } from './language-detect';
import { inferCountryCode } from './country-codes';
import { acquirePlaywrightLock } from './playwright-queue';
import { CORE_KEYWORDS_MINIMAL, FRENCH_KEYWORDS } from '../keywords';

const SOURCE = 'cadremploi.fr';
const BASE_URL = 'https://www.cadremploi.fr';
// Playwright source — each query is a full browser navigation on a 512MB instance, so
// this uses the minimal English set plus full French coverage rather than the full
// combined English+French list (July 13 2026 keyword consolidation).
const SEARCH_QUERIES = [...CORE_KEYWORDS_MINIMAL, ...FRENCH_KEYWORDS];

export class CadremploiSource implements JobSource {
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
        locale: 'fr-FR',
      });

      for (const query of SEARCH_QUERIES) {
        try {
          const fetched = await fetchQuery(context, query, cutoff);
          for (const job of fetched) jobs.set(job.canonicalUrl, job);
          await sleep(2000);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('ECONNREFUSED') && !msg.includes('ETIMEDOUT')) {
            console.error(`[cadremploi] error for "${query}": ${msg}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cadremploi] browser launch failed: ${msg}`);
    } finally {
      await browser?.close();
    }

    if (jobs.size === 0) console.log(`[cadremploi] 0 jobs — may be blocked or structure changed`);
    else console.log(`[cadremploi] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchQuery(context: import('playwright').BrowserContext, query: string, _cutoff: number): Promise<JobPosting[]> {
  const page = await context.newPage();
  const jobs: JobPosting[] = [];

  try {
    await page.goto(`${BASE_URL}/emploi/liste_offres.html?kw=${encodeURIComponent(query)}&lieux=france`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);

    const { cards, preview } = await page.evaluate((baseUrl: string) => {
      const results: Array<{ title: string; company: string; location: string; url: string }> = [];

      const selectors = ['article', '.job-card', '.offer', '[data-id]', 'h2 a', 'h3 a'];
      const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      for (const a of anchors) {
        const href = a.getAttribute('href') ?? '';
        if (!href.includes('/emploi/') && !href.includes('/offre/') && !href.includes('/job')) continue;
        const title = a.textContent?.trim() ?? a.getAttribute('title') ?? '';
        if (!title || title.length < 5 || title.length > 200) continue;
        const card = a.closest('article, li, [class*="job"], [class*="offer"], [class*="card"], [data-id]');
        const company = card?.querySelector('[class*="company"], [class*="entreprise"], [class*="employer"]')?.textContent?.trim() ?? '';
        const location = card?.querySelector('[class*="location"], [class*="lieu"], [class*="city"], [class*="localisation"]')?.textContent?.trim() ?? 'France';
        const canonicalUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;
        results.push({ title, company, location, url: canonicalUrl });
      }

      // Also try named selectors directly
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const a = el.tagName === 'A' ? (el as HTMLAnchorElement) : el.querySelector('a[href]') as HTMLAnchorElement | null;
          if (!a) continue;
          const href = a.getAttribute('href') ?? '';
          if (!href) continue;
          const title = (el.tagName === 'A' ? el.textContent : el.querySelector('h2, h3, [class*="title"]')?.textContent ?? a.textContent)?.trim() ?? '';
          if (!title || title.length < 5 || title.length > 200) continue;
          const canonicalUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;
          if (results.some((r) => r.url === canonicalUrl)) continue;
          results.push({ title, company: '', location: 'France', url: canonicalUrl });
        }
      }

      const preview = document.body.innerHTML.slice(0, 300).replace(/\s+/g, ' ');
      return { cards: results, preview };
    }, BASE_URL);

    if (cards.length === 0) {
      console.log(`[cadremploi] 0 cards for "${query}" — HTML preview: ${preview}`);
    }

    for (const card of cards) {
      if (!card.title || !card.url) continue;
      const text = card.title.toLowerCase();
      jobs.push({
        source: SOURCE, sourcePriority: 4, canonicalUrl: card.url,
        title: card.title, company: card.company || 'Unknown', companySummary: '',
        companySlug: (card.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        locationLabel: `${card.location}, France`,
        countryCode: inferCountryCode(`${card.location} France`) || 'FR',
        city: card.location || null,
        workMode: text.includes('remote') || text.includes('télétravail') ? 'remote' : text.includes('hybrid') ? 'hybrid' : 'on-site',
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
