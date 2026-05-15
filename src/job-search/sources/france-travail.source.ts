import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';

const SOURCE = 'francetravail.fr';
const AUTH_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire';
const API_BASE_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';

interface FranceTravailOffer {
  id: string;
  intitule: string;
  description?: string;
  dateCreation: string;
  dateMiseAJour?: string;
  lieuTravail: {
    libelle: string;
    codePostal?: string;
    commune?: string;
  };
  entreprise?: {
    nom?: string;
    description?: string;
    url?: string;
  };
  salaire?: {
    libelle?: string;
    complement1?: string;
  };
  typeContrat: string;
  experienceExige?: string;
  experienceLibelle?: string;
  modaliteTravail?: {
    libelle?: string;
  };
  contact?: {
    urlPostulation?: string;
  };
}

interface FranceTravailResponse {
  resultats: FranceTravailOffer[];
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'api_offresdemploiv2 o2dsoffre',
  });

  const response = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`France Travail auth failed: ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}

export class FranceTravailJobsSource implements JobSource {
  name = SOURCE;
  priority = 3;

  async fetch(queries: string[], settings: SearchSettings): Promise<JobPosting[]> {
    const clientId = process.env.FRANCE_TRAVAIL_CLIENT_ID;
    const clientSecret = process.env.FRANCE_TRAVAIL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.log('[france-travail] skipped: FRANCE_TRAVAIL_CLIENT_ID or FRANCE_TRAVAIL_CLIENT_SECRET not set');
      return [];
    }

    let token: string;
    try {
      token = await getAccessToken(clientId, clientSecret);
    } catch (error) {
      console.error('[france-travail] auth error:', error instanceof Error ? error.message : String(error));
      return [];
    }

    const maxAgeDate = new Date(Date.now() - settings.maxAgeHours * 60 * 60 * 1000);
    const minCreationDate = maxAgeDate.toISOString().split('T')[0] + 'T00:00:00Z';

    const jobs = new Map<string, JobPosting>();

    for (const query of queries) {
      try {
        const results = await fetchOffers(token, query, minCreationDate);
        for (const offer of results) {
          const job = mapOffer(offer);
          if (job) {
            jobs.set(job.canonicalUrl, job);
          }
        }
      } catch (error) {
        console.error(
          `[france-travail] error for "${query}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return Array.from(jobs.values());
  }
}

async function fetchOffers(
  token: string,
  query: string,
  minCreationDate: string,
): Promise<FranceTravailOffer[]> {
  const params = new URLSearchParams({
    motsCles: query,
    typeContrat: 'CDI',
    minCreationDate,
    range: '0-149',
  });

  const response = await fetch(`${API_BASE_URL}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 204) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`France Travail API error: ${response.status}`);
  }

  const data = (await response.json()) as FranceTravailResponse;
  return data.resultats ?? [];
}

function mapOffer(offer: FranceTravailOffer): JobPosting | null {
  const applyUrl = offer.contact?.urlPostulation ?? `https://candidat.francetravail.fr/offres/emploi/detail/${offer.id}`;
  const canonicalUrl = `https://candidat.francetravail.fr/offres/emploi/detail/${offer.id}`;
  const companyName = offer.entreprise?.nom ?? 'Non communiqué';
  const description = offer.description ?? '';
  const text = `${offer.intitule} ${description}`.toLowerCase();

  const publishedAt = offer.dateCreation ?? offer.dateMiseAJour ?? new Date().toISOString();
  const publishedAtTimestamp = Math.floor(new Date(publishedAt).getTime() / 1000);

  if (isNaN(publishedAtTimestamp)) {
    return null;
  }

  return {
    source: SOURCE,
    sourcePriority: 3,
    canonicalUrl,
    title: offer.intitule,
    company: companyName,
    companySummary: offer.entreprise?.description ?? '',
    companySlug: companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    locationLabel: offer.lieuTravail.libelle,
    countryCode: 'FR',
    city: extractCity(offer.lieuTravail.libelle),
    workMode: inferWorkMode(offer.modaliteTravail?.libelle, text),
    language: detectLanguage(`${offer.intitule} ${description}`),
    description,
    keyMissions: [],
    experienceLevelMinimum:
      parseExperienceLibelle(offer.experienceLibelle) ??
      extractExperienceMinimum(description),
    salaryCurrency: parseSalaryCurrency(offer.salaire?.libelle),
    salaryPeriod: parseSalaryPeriod(offer.salaire?.libelle),
    salaryMinimum: parseSalaryMin(offer.salaire?.libelle),
    salaryMaximum: parseSalaryMax(offer.salaire?.libelle),
    salaryYearlyMinimum: parseSalaryYearly(offer.salaire?.libelle),
    publishedAt,
    publishedAtTimestamp,
    startupSignals: [],
    applyUrl,
    offersRelocation: false,
    isStartup: containsAny(text, ['startup', 'seed', 'series a', 'early-stage', 'founding']),
    employeeCount: null,
    companyCreationYear: null,
  };
}

function extractCity(locationLabel: string): string | null {
  // France Travail location format: "75 - Paris" or "Paris 1er"
  const match = locationLabel.match(/^(?:\d+\s+-\s+)?(.+)/);
  return match ? match[1].trim() : null;
}

function extractExperienceMinimum(text: string): number | null {
  const lower = text.toLowerCase();

  const plusMatch = lower.match(/(\d+)\+\s*years?/i);
  if (plusMatch) return parseInt(plusMatch[1], 10) + 1;

  const rangeMatch = lower.match(/(\d+)\s*(?:to|-)\s*\d+\s+years?/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);

  const patterns: RegExp[] = [
    /(?:minimum|at\s+least|min\.?)\s+(\d+)\s+years?/i,
    /(\d+)\s+years?\s+(?:of\s+)?(?:professional\s+)?experience/i,
    /experience\s*(?:of\s+)?(\d+)\s+years?/i,
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) return parseInt(match[1], 10);
  }

  return null;
}

function parseExperienceLibelle(libelle: string | undefined): number | null {
  if (!libelle) return null;
  const lower = libelle.toLowerCase();
  if (lower.includes('débutant') || lower.includes('sans expérience')) return 0;
  const match = lower.match(/(\d+)\s*an/);
  if (match) return parseInt(match[1], 10);
  return null;
}

function inferWorkMode(
  modalite: string | undefined,
  text: string,
): 'remote' | 'hybrid' | 'on-site' {
  if (modalite) {
    const m = modalite.toLowerCase();
    if (m.includes('total') || m.includes('complet')) return 'remote';
    if (m.includes('partiel') || m.includes('hybride')) return 'hybrid';
    if (m.includes('présentiel')) return 'on-site';
  }
  if (containsAny(text, ['full remote', 'fully remote', '100% remote', 'remote only'])) return 'remote';
  if (containsAny(text, ['hybrid', 'hybride', 'télétravail partiel'])) return 'hybrid';
  return 'on-site';
}


function parseSalaryMin(libelle: string | undefined): number | null {
  if (!libelle) return null;
  const match = libelle.match(/(?:de|à partir de)\s*([\d\s,]+)/i);
  if (!match) return null;
  return parseFloat(match[1].replace(/\s/g, '').replace(',', '.')) || null;
}

function parseSalaryMax(libelle: string | undefined): number | null {
  if (!libelle) return null;
  const match = libelle.match(/à\s*([\d\s,]+)\s*(?:Euros|EUR|€)/i);
  if (!match) return null;
  return parseFloat(match[1].replace(/\s/g, '').replace(',', '.')) || null;
}

function parseSalaryYearly(libelle: string | undefined): number | null {
  if (!libelle || !libelle.toLowerCase().includes('annuel')) return null;
  return parseSalaryMin(libelle);
}

function parseSalaryCurrency(libelle: string | undefined): string | null {
  if (!libelle) return null;
  if (libelle.toLowerCase().includes('euros') || libelle.includes('EUR') || libelle.includes('€')) return 'EUR';
  return null;
}

function parseSalaryPeriod(libelle: string | undefined): string | null {
  if (!libelle) return null;
  const lower = libelle.toLowerCase();
  if (lower.includes('annuel')) return 'yearly';
  if (lower.includes('mensuel')) return 'monthly';
  return null;
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((t) => text.includes(t));
}
