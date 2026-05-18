import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'apec.fr';

// APEC — Association Pour l'Emploi des Cadres
// France's primary professional job board for experienced engineers and managers.
// Public search endpoint used by their Angular frontend.

const API_URL = 'https://www.apec.fr/cms/api/v1/offres/recherche';

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

    for (const query of queries) {
      try {
        const results = await fetchOffers(query, settings.maxAgeHours);
        for (const offer of results) {
          const job = mapOffer(offer);
          if (job) jobs.set(job.canonicalUrl, job);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Only log non-connectivity errors to avoid noise if endpoint changes
        if (!msg.includes('fetch failed') && !msg.includes('ECONNREFUSED') && !msg.includes('404')) {
          console.error(`[apec] error for "${query}": ${msg}`);
        }
      }
    }

    return Array.from(jobs.values());
  }
}

async function fetchOffers(query: string, maxAgeHours: number): Promise<ApecOffer[]> {
  const dateMin = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString().split('T')[0];

  const body = {
    motsCles: query,
    nbResultat: 50,
    debut: 0,
    typesContrats: ['102888'], // CDI
    datePublication: dateMin,
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://www.apec.fr/offres/offres-emploi.html',
      'Origin': 'https://www.apec.fr',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 204) return [];
  if (res.status === 403 || res.status === 429) return []; // cloud IP blocked — fail silently
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
  const val = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
  return val || null;
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
