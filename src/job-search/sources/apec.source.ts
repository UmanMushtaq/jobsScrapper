import { proxyFetch } from '../proxy-fetch';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'apec.fr';

// APEC — Association Pour l'Emploi des Cadres
// France's primary professional job board for experienced engineers and managers.
//
// Auth strategy: their Angular API (/cms/api/v1/offres/recherche) requires a
// JavaScript-generated XSRF token we can't obtain without a real browser.
// Fallback: their RSS feed (?flux=rss) is public and requires no auth.

const API_URL = 'https://www.apec.fr/cms/api/v1/offres/recherche';
const RSS_BASE = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi';
const PREFLIGHT_URL = 'https://www.apec.fr/candidat/recherche-emploi.html';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface ApecOffer {
  numeroOffre?: string | number;
  intitule?: string;
  description?: string;
  datePublication?: string;
  dateModification?: string;
  lieuTravail?: {
    libelle?: string;
    codePostal?: string;
    codeDepartement?: string;
  };
  entreprise?: {
    nom?: string;
    description?: string;
    effectif?: string;
  };
  salaire?: {
    libelle?: string;
    commentaire?: string;
  };
  modaliteTravail?: {
    libelle?: string;
  };
  experience?: {
    libelle?: string;
    code?: string;
  };
  statut?: number;
}

interface ApecResponse {
  resultats?: ApecOffer[];
  totalItems?: number;
}

export class ApecJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

    // Try RSS feed first — no auth required, completely bypasses the XSRF issue.
    const rssJobs = await fetchViaRss(settings.maxAgeHours);
    for (const job of rssJobs) jobs.set(job.canonicalUrl, job);

    if (rssJobs.length > 0) {
      console.log(`[apec] RSS: ${rssJobs.length} jobs fetched`);
      return Array.from(jobs.values());
    }

    // RSS returned nothing — fall back to the API with session cookies.
    // This still 403s without XSRF but keeps the attempt in case APEC changes behaviour.
    const session = await fetchSession();
    for (const query of queries) {
      try {
        const results = await fetchOffers(query, settings.maxAgeHours, session);
        for (const offer of results) {
          const job = mapOffer(offer);
          if (job) jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED') && !msg.includes('404')) {
          console.error(`[apec] error for "${query}": ${msg}`);
        }
      }
    }

    return Array.from(jobs.values());
  }
}

// ── RSS approach (no auth) ────────────────────────────────────────────────────

const RSS_QUERIES = ['nodejs typescript', 'nestjs', 'node.js backend'];

async function fetchViaRss(maxAgeHours: number): Promise<JobPosting[]> {
  const jobs = new Map<string, JobPosting>();
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  for (const q of RSS_QUERIES) {
    try {
      const params = new URLSearchParams({
        motsCles: q,
        typeContrat: '102888', // CDI
        flux: 'rss',
      });
      const url = `${RSS_BASE}?${params}`;
      const res = await proxyFetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Referer': 'https://www.apec.fr/',
        },
      });

      if (res.status === 403 || res.status === 404 || res.status === 429 || res.status === 530) {
        console.log(`[apec] RSS ${res.status} for "${q}" — trying API fallback`);
        return [];
      }
      if (!res.ok) continue;

      const xml = await res.text();
      if (!xml.includes('<item>')) continue;

      const items = parseRssItems(xml, cutoff);
      for (const job of items) jobs.set(job.canonicalUrl, job);
    } catch {
      // ignore — will fall back to API
    }
  }

  return Array.from(jobs.values());
}

interface RssItem { title: string; link: string; description: string; pubDate: number; }

function parseRssItems(xml: string, cutoff: number): JobPosting[] {
  const jobs: JobPosting[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;

  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractXmlTag(block, 'title');
    const link = extractXmlTag(block, 'link') || extractXmlTag(block, 'guid');
    const description = extractXmlTag(block, 'description');
    const pubDateStr = extractXmlTag(block, 'pubDate');
    if (!title || !link) continue;

    const pubMs = pubDateStr ? new Date(pubDateStr).getTime() : Date.now();
    if (isNaN(pubMs) || pubMs < cutoff) continue;

    const id = link.split('/').pop() ?? link;
    const canonicalUrl = `https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/${id}`;
    const desc = stripHtml(description);
    const text = `${title} ${desc}`.toLowerCase();

    jobs.push({
      source: SOURCE,
      sourcePriority: 4,
      canonicalUrl,
      title,
      company: extractXmlTag(block, 'author') || 'Non communiqué',
      companySummary: '',
      companySlug: 'apec',
      locationLabel: 'France',
      countryCode: 'FR',
      city: null,
      workMode: inferWorkMode('', text),
      language: detectLanguage(`${title} ${desc}`),
      description: desc,
      keyMissions: [],
      experienceLevelMinimum: null,
      salaryCurrency: null,
      salaryPeriod: null,
      salaryMinimum: null,
      salaryMaximum: null,
      salaryYearlyMinimum: null,
      publishedAt: new Date(pubMs).toISOString(),
      publishedAtTimestamp: Math.floor(pubMs / 1000),
      startupSignals: [],
      applyUrl: link,
      offersRelocation: false,
      isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
      employeeCount: null,
      companyCreationYear: null,
    });
  }

  return jobs;
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  return xml.match(re)?.[1]?.trim() ?? '';
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── API approach (fallback) ───────────────────────────────────────────────────

interface ApecSession { cookie: string; xsrfToken: string; }

async function fetchSession(): Promise<ApecSession> {
  try {
    const res = await proxyFetch(PREFLIGHT_URL, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    });
    const raw = res.headers.get('x-set-cookie') ?? '';
    if (!raw) {
      console.warn('[apec] preflight: no cookies received');
      return { cookie: '', xsrfToken: '' };
    }
    const pairs = raw.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean);
    const cookieStr = pairs.join('; ');
    const cookieNames = pairs.map((p) => p.split('=')[0]).join(', ');
    const xsrfPair = pairs.find((p) => /^xsrf-token=/i.test(p));
    const xsrfToken = xsrfPair ? xsrfPair.split('=').slice(1).join('=') : '';
    console.log(`[apec] preflight: [${cookieNames}] — xsrf=${xsrfToken ? 'present' : 'missing'}`);
    return { cookie: cookieStr, xsrfToken };
  } catch (err) {
    console.warn(`[apec] preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    return { cookie: '', xsrfToken: '' };
  }
}

async function fetchOffers(query: string, maxAgeHours: number, session: ApecSession): Promise<ApecOffer[]> {
  const dateMin = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString().split('T')[0];

  const body = {
    motsCles: query,
    nbResultat: 50,
    debut: 0,
    typesContrats: ['102888'],
    datePublication: dateMin,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': BROWSER_UA,
    'Referer': 'https://www.apec.fr/offres/offres-emploi.html',
    'Origin': 'https://www.apec.fr',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  };
  if (session.cookie) headers['Cookie'] = session.cookie;
  if (session.xsrfToken) headers['X-XSRF-TOKEN'] = session.xsrfToken;

  const res = await proxyFetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 204) return [];
  if (res.status === 403 || res.status === 429 || res.status === 502 || res.status === 530) {
    if (res.status === 403) console.warn(`[apec] 403 — cookie=${session.cookie ? 'present' : 'missing'} xsrf=${session.xsrfToken ? 'present' : 'missing'}`);
    return [];
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`APEC API ${res.status}${text ? ': ' + text.slice(0, 150) : ''}`);
  }

  const data = (await res.json()) as ApecResponse;
  return data.resultats ?? [];
}

function mapOffer(offer: ApecOffer): JobPosting | null {
  const id = offer.numeroOffre;
  if (!id) return null;

  const canonicalUrl = `https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/${id}`;
  const title = offer.intitule ?? '';
  if (!title) return null;

  const company = offer.entreprise?.nom ?? 'Non communiqué';
  const description = offer.description ?? '';
  const text = `${title} ${description}`.toLowerCase();

  const publishedAt = offer.datePublication ?? offer.dateModification ?? new Date().toISOString();
  const publishedAtTimestamp = Math.floor(new Date(publishedAt).getTime() / 1000);
  if (isNaN(publishedAtTimestamp)) return null;

  const modalite = offer.modaliteTravail?.libelle ?? '';
  const workMode = inferWorkMode(modalite, text);
  const locationLabel = offer.lieuTravail?.libelle ?? 'France';
  const city = extractCity(locationLabel);

  return {
    source: SOURCE,
    sourcePriority: 4,
    canonicalUrl,
    title,
    company,
    companySummary: offer.entreprise?.description ?? '',
    companySlug: company.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel,
    countryCode: 'FR',
    city,
    workMode,
    language: detectLanguage(`${title} ${description}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: parseExperience(offer.experience?.libelle),
    salaryCurrency: parseSalaryCurrency(offer.salaire?.libelle),
    salaryPeriod: parseSalaryPeriod(offer.salaire?.libelle),
    salaryMinimum: parseSalaryMin(offer.salaire?.libelle),
    salaryMaximum: parseSalaryMax(offer.salaire?.libelle),
    salaryYearlyMinimum: parseSalaryYearly(offer.salaire?.libelle),
    publishedAt,
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl: canonicalUrl,
    offersRelocation: false,
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage']),
    employeeCount: parseEmployeeCount(offer.entreprise?.effectif),
    companyCreationYear: null,
  };
}

function inferWorkMode(modalite: string, text: string): 'remote' | 'hybrid' | 'on-site' {
  const m = modalite.toLowerCase();
  if (m.includes('total') || m.includes('complet')) return 'remote';
  if (m.includes('partiel') || m.includes('hybride')) return 'hybrid';
  if (m.includes('présentiel')) return 'on-site';
  if (containsAny(text, ['full remote', 'fully remote', '100% remote', 'remote only'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail partiel'])) return 'hybrid';
  return 'on-site';
}

function extractCity(locationLabel: string): string | null {
  const match = locationLabel.match(/^(?:\d+\s+-\s+)?(.+)/);
  return match ? match[1].trim() : null;
}

function parseExperience(libelle: string | undefined): number | null {
  if (!libelle) return null;
  const lower = libelle.toLowerCase();
  if (lower.includes('débutant') || lower.includes('sans expérience')) return 0;
  const match = lower.match(/(\d+)\s*an/);
  return match ? parseInt(match[1]) : null;
}

function parseSalaryMin(libelle: string | undefined): number | null {
  if (!libelle) return null;
  const match = libelle.match(/(?:de|à partir de|entre)\s*([\d\s,.]+)/i);
  if (!match) return null;
  return parseFloat(match[1].replace(/\s/g, '').replace(',', '.')) || null;
}

function parseSalaryMax(libelle: string | undefined): number | null {
  if (!libelle) return null;
  const match = libelle.match(/(?:jusqu'à|à|et)\s*([\d\s,.]+)\s*(?:k€|€|EUR|Euros)/i);
  if (!match) return null;
  return parseFloat(match[1].replace(/\s/g, '').replace(',', '.')) || null;
}

function parseSalaryYearly(libelle: string | undefined): number | null {
  if (!libelle || !libelle.toLowerCase().includes('annuel')) return null;
  return parseSalaryMin(libelle);
}

function parseSalaryCurrency(libelle: string | undefined): string | null {
  if (!libelle) return null;
  if (libelle.includes('€') || /eur/i.test(libelle)) return 'EUR';
  return null;
}

function parseSalaryPeriod(libelle: string | undefined): string | null {
  if (!libelle) return null;
  const lower = libelle.toLowerCase();
  if (lower.includes('annuel') || lower.includes('/an')) return 'yearly';
  if (lower.includes('mensuel') || lower.includes('/mois')) return 'monthly';
  return null;
}

function parseEmployeeCount(effectif: string | undefined): number | null {
  if (!effectif) return null;
  const match = effectif.match(/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
