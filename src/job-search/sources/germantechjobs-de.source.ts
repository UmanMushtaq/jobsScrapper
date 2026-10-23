import { chromium } from 'playwright';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { acquirePlaywrightLock } from './playwright-queue';

const SOURCE = 'germantechjobs.de';
const BASE_URL = 'https://germantechjobs.de';

// germantechjobs.de is a JS-hydrated listing (no job cards in the raw HTML, no RSS/XML
// feed — confirmed Oct 23 2026, see the now-deleted germantechjobs-de.source.ts.blocked.md
// for the July 12 2026 attempt that was blocked purely by this sandbox's own egress
// allowlist, not by anything about the site itself). It has no free-text search, only
// per-technology tag pages at /jobs/{Tag}/all — these four cover Uman's stack directly
// rather than crawling /jobs/all/all (769+ jobs, almost all irrelevant).
const TAG_PATHS = ['/jobs/NodeJS/all', '/jobs/TypeScript/all', '/jobs/JavaScript/all', '/jobs/Backend/all'];

// German legal-entity suffixes used to split "CompanyName GmbH" away from the trailing
// address/location text in a card's combined text block (there is no separate company
// link or location element — confirmed live Oct 23 2026).
const COMPANY_SUFFIX_RE = /^(.*?\b(?:GmbH\s*&\s*Co\.\s*KG|GmbH|AG|KG|SE|UG|mbH|Ltd\.?|Inc\.?))\b/i;

export class GermanTechJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    return acquirePlaywrightLock(() => this._fetch());
  }

  private async _fetch(): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

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
        locale: 'de-DE',
      });

      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
          return route.abort();
        }
        return route.continue();
      });

      for (const path of TAG_PATHS) {
        try {
          const fetched = await fetchTagPage(context, path);
          for (const job of fetched) jobs.set(job.canonicalUrl, job);
          await sleep(1500);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[germantechjobs-de] error for "${path}": ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[germantechjobs-de] browser launch failed: ${msg}`);
    } finally {
      await browser?.close();
    }

    if (jobs.size === 0) console.log(`[germantechjobs-de] 0 jobs — may be blocked or markup changed`);
    else console.log(`[germantechjobs-de] ${jobs.size} unique jobs fetched`);
    return Array.from(jobs.values());
  }
}

async function fetchTagPage(
  context: import('playwright').BrowserContext,
  path: string,
): Promise<JobPosting[]> {
  const page = await context.newPage();
  const jobs: JobPosting[] = [];

  try {
    await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('a[href^="/jobs/"]', { timeout: 15_000 }).catch(() => undefined);
    // Client-side hydration settle time (confirmed JS-rendered — no job cards in the raw
    // response).
    await page.waitForTimeout(2500);

    const cards = await page.evaluate((baseUrl: string) => {
      const results: Array<{ title: string; url: string; blob: string; salary: string }> = [];
      const seen = new Set<string>();

      const anchors = Array.from(document.querySelectorAll('a[href^="/jobs/"]')) as HTMLAnchorElement[];
      for (const a of anchors) {
        const href = a.getAttribute('href') ?? '';
        // Job detail links are a single path segment after /jobs/ (e.g.
        // "/jobs/Acme-GmbH-Backend-Developer"). Tag/category links have a second
        // segment ("/jobs/NodeJS/all") and are excluded by this pattern.
        if (!/^\/jobs\/[^/]+$/.test(href)) continue;

        const url = `${baseUrl}${href}`;
        if (seen.has(url)) continue;

        const title = a.textContent?.trim() ?? '';
        if (!title || title.length < 3) continue;
        seen.add(url);

        // Walk up from the anchor to find a container with meaningfully more text than
        // just the title (the card's company/location/salary block) — exact class names
        // are unknown (JS-hydrated markup, not inspectable from this sandbox), so this
        // climbs a few levels rather than relying on a specific selector.
        let container: Element | null = a;
        for (let i = 0; i < 4 && container; i++) {
          const text = container.textContent?.trim() ?? '';
          if (text.length > title.length + 15) break;
          container = container.parentElement;
        }

        const blob = (container?.textContent ?? title).replace(/\s+/g, ' ').trim();
        const salaryMatch = blob.match(/[\d.,]+\s*-\s*[\d.,]+\s*(?:€|EUR)(?:\s*\/\s*\p{L}+)?/u) ?? blob.match(/[\d.,]+\s*(?:€|EUR)(?:\s*\/\s*\p{L}+)?/u);

        results.push({ title, url, blob, salary: salaryMatch?.[0] ?? '' });
      }

      return results;
    }, BASE_URL);

    for (const card of cards) {
      const job = mapCard(card);
      if (job) jobs.push(job);
    }
  } finally {
    await page.close();
  }

  return jobs;
}

function mapCard(card: { title: string; url: string; blob: string; salary: string }): JobPosting | null {
  if (!card.title || !card.url) return null;

  // Strip the title and salary substrings out of the card's full text blob, leaving
  // (best-effort) the company name + address/location text that sits between them —
  // there is no separate company link or location element on this site.
  let remainder = card.blob.replace(card.title, '').replace(card.salary, '').trim();
  remainder = remainder.replace(/^(Speichern|Save)\b/i, '').trim();

  const suffixMatch = remainder.match(COMPANY_SUFFIX_RE);
  const company = suffixMatch?.[1]?.trim() || remainder.split(',')[0]?.trim() || 'Unknown';
  const location = suffixMatch
    ? remainder.slice(suffixMatch[0].length).replace(/^[,\s]+/, '').trim()
    : remainder.split(',').slice(1).join(',').trim();

  const text = `${card.title} ${card.blob}`.toLowerCase();
  const salary = parseSalary(card.salary);

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl: card.url,
    title: card.title,
    company: company || 'Unknown',
    companySummary: '',
    companySlug: (company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: location || 'Germany',
    countryCode: 'DE',
    city: location ? location.split(',')[0]?.trim() || null : null,
    workMode: inferWorkMode(text),
    language: detectLanguage(card.title),
    description: '',
    keyMissions: [],
    experienceLevelMinimum: null,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    salaryMinimum: salary.min,
    salaryMaximum: salary.max,
    salaryYearlyMinimum: salary.yearlyMin,
    publishedAt: null,
    publishedAtTimestamp: null,
    startupSignals: [],
    applyUrl: card.url,
    offersRelocation: false,
    isStartup: false,
    employeeCount: null,
    companyCreationYear: null,
    descriptionPartial: true,
  };
}

function inferWorkMode(text: string): 'remote' | 'hybrid' | 'on-site' {
  if (text.includes('remote') && text.includes('hybrid')) return 'hybrid';
  if (text.includes('remote')) return 'remote';
  return 'on-site';
}

function parseSalary(salaryText: string): {
  currency: string | null;
  period: 'yearly' | 'monthly' | 'hourly' | null;
  min: number | null;
  max: number | null;
  yearlyMin: number | null;
} {
  if (!salaryText) return { currency: null, period: null, min: null, max: null, yearlyMin: null };
  const currency = /€|EUR/i.test(salaryText) ? 'EUR' : null;
  const period = /stunde|hour/i.test(salaryText) ? 'hourly' : /monat|month/i.test(salaryText) ? 'monthly' : 'yearly';
  const numbers = salaryText
    .match(/[\d.,]+/g)
    ?.map((n) => parseFloat(n.replace(/\./g, '').replace(',', '.')))
    .filter((n) => !isNaN(n) && n > 0) ?? [];
  const min = numbers[0] ?? null;
  const max = numbers[1] ?? null;
  const yearlyMin = period === 'yearly' ? min : null;
  return { currency, period, min, max, yearlyMin };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
