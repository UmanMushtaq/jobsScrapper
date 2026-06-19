import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { redisSetApecStatus } from '../redis-store';

const SOURCE = 'apec.fr';

const SESSION_URL = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi';
const API_URL = 'https://www.apec.fr/cms/webservices/rechercheOffre';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.apec.fr/candidat/recherche-emploi.html/emploi',
  'Origin': 'https://www.apec.fr',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

interface ApecApiJob {
  id?: string | number;
  numeroOffre?: string | number;
  intitule?: string;
  nomCommercial?: string;
  lieuTexte?: string;
  salaireTexte?: string;
  texteOffre?: string;
  // legacy nested fields kept for fallback compatibility
  description?: string;
  datePublication?: string;
  dateModification?: string;
  lieuTravail?: { libelle?: string };
  entreprise?: { nom?: string; description?: string; effectif?: string };
  salaire?: { libelle?: string };
  modaliteTravail?: { libelle?: string };
  experience?: { libelle?: string; code?: string };
}

interface ApecApiResponse {
  resultats?: ApecApiJob[];
  totalItems?: number;
}

// Queries sent to the APEC search API
const APEC_QUERIES = [
  'nodejs nestjs',
  'nodejs typescript backend',
  'nestjs typescript',
];

export class ApecJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    const jobs = new Map<string, JobPosting>();

    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));

    // Step 1: visit the search page to get a session cookie
    try {
      await client.get(SESSION_URL, {
        headers: {
          ...HEADERS,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
        },
      });
      console.log('[apec] session established');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[apec] session request failed: ${msg}, proceeding without cookie`);
    }

    // Step 2: random 2-3 second delay
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1000));

    // Step 3: query the API for each search term
    for (const motsCles of APEC_QUERIES) {
      try {
        const body = {
          motsCles,
          nombreOffresParPage: 50,
          numPage: 1,
          typesContrat: ['CDI', 'CDD', 'MIS', 'FRE'],
          lieux: [75],
        };

        const res = await client.post<ApecApiResponse>(API_URL, body, {
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
        });

        if (res.status === 403) {
          console.log('[apec] BLOCKED - IP flagged');
          break;
        }

        const resultats = res.data?.resultats ?? [];
        console.log(`[apec] fetched ${resultats.length} jobs from API (query: "${motsCles}")`);

        for (const offer of resultats) {
          const job = mapOffer(offer);
          if (job) jobs.set(job.canonicalUrl, job);
        }
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 403) {
          console.log('[apec] BLOCKED - IP flagged');
          break;
        }
        console.log(`[apec] API call failed with status ${status ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const result = Array.from(jobs.values());
    const INTERVAL_MS = 6 * 60 * 60 * 1000;
    await redisSetApecStatus({
      lastRun: new Date().toISOString(),
      jobsFound: result.length,
      status: result.length > 0 ? 'success' : 'blocked',
      nextRun: new Date(Date.now() + INTERVAL_MS).toISOString(),
      playwrightEnabled: false,
    });

    return result;
  }
}

function mapOffer(offer: ApecApiJob): JobPosting | null {
  const id = offer.numeroOffre ?? offer.id;
  if (!id) return null;

  const title = offer.intitule ?? '';
  if (!title) return null;

  const canonicalUrl = `https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/${id}`;

  // Flat fields from the real POST response; nested fields as legacy fallback
  const company = offer.nomCommercial ?? offer.entreprise?.nom ?? 'Non communiqué';
  const description = offer.texteOffre ?? offer.description ?? '';
  const locationLabel = offer.lieuTexte ?? offer.lieuTravail?.libelle ?? 'France';
  const salaryLabel = offer.salaireTexte ?? offer.salaire?.libelle;

  const text = `${title} ${description}`.toLowerCase();
  const publishedAt = offer.datePublication ?? offer.dateModification ?? new Date().toISOString();
  const pubMs = new Date(publishedAt).getTime();
  if (isNaN(pubMs)) return null;
  const publishedAtTimestamp = Math.floor(pubMs / 1000);

  const modalite = offer.modaliteTravail?.libelle ?? '';

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
    city: extractCity(locationLabel),
    workMode: inferWorkMode(modalite, text),
    language: detectLanguage(`${title} ${description}`),
    description,
    keyMissions: [],
    experienceLevelMinimum: parseExperience(offer.experience?.libelle),
    salaryCurrency: parseSalaryCurrency(salaryLabel),
    salaryPeriod: parseSalaryPeriod(salaryLabel),
    salaryMinimum: parseSalaryMin(salaryLabel),
    salaryMaximum: parseSalaryMax(salaryLabel),
    salaryYearlyMinimum: parseSalaryYearly(salaryLabel),
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
