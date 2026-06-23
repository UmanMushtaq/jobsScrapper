import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { JobPosting, SearchSettings } from '../types';
import { detectLanguage } from './language-detect';
import { JobSource } from './registry';
import { redisSetApecStatus } from '../redis-store';

const SOURCE = 'apec.fr';

interface ApecDetailResponse {
  data?: {
    texteHtml?: string;
    texte?: string;
    description?: string;
  };
  texteHtml?: string;
  texte?: string;
  description?: string;
}

const SESSION_URL = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi';
const API_URL = 'https://www.apec.fr/cms/webservices/rechercheOffre';
const DETAIL_BASE_URL = 'https://api.apec.fr/api-job-offer/v2/job-offers';
const DETAIL_BATCH_SIZE = 10;
const DETAIL_BATCH_DELAY_MS = 500;

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

// Queries sent to the APEC search API — broad coverage to maximise recall
const APEC_QUERIES = [
  'nodejs',
  'node.js',
  'node js',
  'NodeJS',
  'nestjs',
  'nest.js',
  'NestJS',
  'backend typescript',
  'ingénieur backend nodejs',
  'développeur nodejs',
];

export class ApecJobsSource implements JobSource {
  name = SOURCE;
  priority = 4;

  async fetch(_queries: string[], _settings: SearchSettings): Promise<JobPosting[]> {
    // Dedup raw offers by numeroOffre before mapping so the same job from
    // multiple queries is never counted twice.
    const rawOffers = new Map<string, ApecApiJob>();
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

    // Step 2: prerequisite identification calls the browser fires before the search POST
    try {
      await client.get('https://www.apec.fr/cms/webservices/identification/cadre', { headers: HEADERS });
      await new Promise((r) => setTimeout(r, 1000));
      await client.get('https://www.apec.fr/cms/webservices/identification/apecuser', { headers: HEADERS });
      await new Promise((r) => setTimeout(r, 1000));
      console.log('[apec] identification calls complete');
    } catch (err) {
      console.log(`[apec] identification calls failed: ${err instanceof Error ? err.message : String(err)}, proceeding anyway`);
    }

    // Step 3: random 1-2 second additional delay then search POST
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));

    // Step 4: query the API for each search term
    for (const motsCles of APEC_QUERIES) {
      try {
        const body = {
          motsCles,
          lieux: [],
          fonctions: [],
          statutPoste: [],
          typesContrat: [],
          typesConvention: ['143684', '143685', '143686', '143687', '143706'],
          niveauxExperience: [],
          idsEtablissement: [],
          secteursActivite: [],
          typesTeletravail: [],
          idNomZonesDeplacement: [],
          positionNumbersExcluded: [],
          typeClient: 'CADRE',
          sorts: [{ type: 'SCORE', direction: 'DESCENDING' }],
          pagination: { range: 50, startIndex: 0 },
          activeFiltre: true,
          pointGeolocDeReference: { distance: 0 },
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

        // Log all fields of the first job from the very first query to diagnose available data
        if (resultats.length > 0 && rawOffers.size === 0) {
          const sample = resultats[0];
          console.log(`[apec] listing API first job fields: ${Object.keys(sample as object).join(', ')}`);
          console.log(`[apec] texteOffre length: ${String(sample.texteOffre ?? '').length} chars | description length: ${String(sample.description ?? '').length} chars`);
          if (sample.texteOffre) console.log(`[apec] texteOffre preview: ${String(sample.texteOffre).slice(0, 200)}`);
        }

        for (const offer of resultats) {
          const key = String(offer.numeroOffre ?? offer.id ?? '');
          if (key) rawOffers.set(key, offer);
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

    // Map deduplicated offers to JobPostings
    for (const offer of rawOffers.values()) {
      const job = mapOffer(offer);
      if (job) jobs.set(job.canonicalUrl, job);
    }
    console.log(`[apec] ${rawOffers.size} unique offers → ${jobs.size} mapped jobs`);

    // Fetch full descriptions in batches of 10 to replace the short listing snippets
    const jobList = Array.from(jobs.values());
    if (jobList.length > 0) {
      console.log(`[apec] fetching full descriptions for ${jobList.length} jobs (batches of ${DETAIL_BATCH_SIZE})`);
      let fetched = 0;
      let firstJobLogged = false;
      for (let i = 0; i < jobList.length; i += DETAIL_BATCH_SIZE) {
        const batch = jobList.slice(i, i + DETAIL_BATCH_SIZE);
        await Promise.all(batch.map(async (job) => {
          // IDs include an optional letter suffix, e.g. "178880244W"
          const idMatch = job.canonicalUrl.match(/detail-offre\/([A-Z0-9]+)/i);
          if (!idMatch) return;
          const jobId = idMatch[1];

          const logFirst = !firstJobLogged;
          if (logFirst) {
            firstJobLogged = true;
            console.log(`[apec] fetching detail for job ID: ${jobId}`);
          }

          const fullDesc = await fetchApecDetail(client, jobId, job.canonicalUrl, logFirst);
          if (fullDesc && fullDesc.length > job.description.length) {
            job.description = fullDesc;
            fetched++;
          }
        }));
        if (i + DETAIL_BATCH_SIZE < jobList.length) {
          await new Promise((r) => setTimeout(r, DETAIL_BATCH_DELAY_MS));
        }
      }
      console.log(`[apec] full descriptions fetched: ${fetched}/${jobList.length}`);
    }

    const result = jobList;
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

async function fetchApecDetail(
  client: ReturnType<typeof wrapper>,
  jobId: string,
  canonicalUrl: string,
  logStatus: boolean,
): Promise<string | null> {
  // Try JSON API first
  try {
    const res = await client.get<ApecDetailResponse>(`${DETAIL_BASE_URL}/${jobId}`, {
      headers: { ...HEADERS, 'Referer': canonicalUrl },
      timeout: 15_000,
      validateStatus: (s) => s < 600,
    });
    if (logStatus) console.log(`[apec] detail response status: ${res.status}`);
    if (res.status === 200) {
      const data = res.data?.data ?? res.data;
      const raw = data?.texteHtml ?? data?.texte ?? data?.description ?? '';
      if (raw) return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      if (logStatus) console.log(`[apec] detail fetch failed for ${jobId} — status ${res.status}, trying HTML fallback`);
    }
  } catch {
    if (logStatus) console.log(`[apec] detail API error for ${jobId}, trying HTML fallback`);
  }

  // Fallback: fetch the HTML detail page and extract the description
  try {
    const res = await client.get<string>(canonicalUrl, {
      headers: {
        ...HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
      },
      timeout: 20_000,
      responseType: 'text',
      validateStatus: (s) => s < 600,
    });
    if (logStatus) console.log(`[apec] HTML fallback status: ${res.status} for ${jobId}`);
    if (res.status !== 200) {
      console.log(`[apec] detail fetch failed for ${jobId} — status ${res.status}, keeping short description`);
      return null;
    }
    const html: string = res.data;
    const result = extractDescriptionFromHtml(html, jobId, logStatus);
    if (result) return result;
  } catch {
    console.log(`[apec] detail fetch failed for ${jobId} — network error, keeping short description`);
  }

  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

function extractDescriptionFromHtml(html: string, jobId: string, logStatus: boolean): string | null {
  // Strategy 1: find heading "Job description" / "Description du poste" / "Description de l'offre"
  // then collect all content until the next heading.
  const headingPattern = /(?:job\s+description|description\s+du\s+poste|description\s+de\s+l['']offre)/i;
  // Match any h1-h4 or strong/b tag that contains the heading text
  const headingTagRe = /<(?:h[1-4]|strong|b|p)[^>]*>([\s\S]*?)<\/(?:h[1-4]|strong|b|p)>/gi;
  let headingEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = headingTagRe.exec(html)) !== null) {
    if (headingPattern.test(stripHtml(m[1]))) {
      headingEnd = m.index + m[0].length;
      break;
    }
  }

  if (headingEnd !== -1) {
    // Grab the HTML slice after the heading until the next h-tag or section boundary
    const afterHeading = html.slice(headingEnd, headingEnd + 8000);
    const nextSectionMatch = afterHeading.search(/<(?:h[1-4])[^>]*>/i);
    const contentHtml = nextSectionMatch > 0 ? afterHeading.slice(0, nextSectionMatch) : afterHeading;
    // Extract all <p> and <li> text
    const parts: string[] = [];
    for (const tag of contentHtml.matchAll(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)) {
      const t = stripHtml(tag[1]);
      if (t.length > 10) parts.push(t);
    }
    if (parts.length > 0) {
      const result = parts.join(' ');
      if (logStatus) {
        console.log(`[apec] HTML parser found description (heading strategy): ${result.slice(0, 200)}`);
        console.log(`[apec] description length: ${result.length} chars`);
      }
      return result;
    }
    // Heading found but no <p>/<li> — take raw stripped text after heading
    const raw = stripHtml(contentHtml);
    if (raw.length > 100) {
      if (logStatus) console.log(`[apec] HTML parser found description (heading+rawtext): ${raw.slice(0, 200)}`);
      return raw;
    }
  }

  // Strategy 2: CSS class selectors for known description containers
  const classSelectors = [
    /class="[^"]*(?:job-description|offer-description|description-content|texte-offre|job-detail|offer-detail)[^"]*"/i,
    /data-testid="job-description"/i,
    /class="[^"]*(?:description|content-detail)[^"]*"/i,
  ];
  for (const selectorRe of classSelectors) {
    // Find opening tag matching selector, then grab until matching close tag
    const tagMatch = selectorRe.exec(html);
    if (!tagMatch) continue;
    const tagStart = html.lastIndexOf('<', tagMatch.index);
    if (tagStart === -1) continue;
    // Walk forward to find matching closing </div> (simple depth counter)
    let depth = 0;
    let pos = tagStart;
    let end = -1;
    while (pos < html.length && pos < tagStart + 30000) {
      const open = html.indexOf('<', pos);
      if (open === -1) break;
      if (html.slice(open, open + 2) === '</') {
        if (depth <= 1) { end = html.indexOf('>', open) + 1; break; }
        depth--;
      } else if (!html.slice(open, open + 3).includes('/>')) {
        depth++;
      }
      pos = open + 1;
    }
    const contentHtml = end > -1 ? html.slice(tagStart, end) : html.slice(tagStart, tagStart + 5000);
    const text = stripHtml(contentHtml);
    if (text.length > 100) {
      if (logStatus) {
        console.log(`[apec] HTML parser found description (CSS selector): ${text.slice(0, 200)}`);
        console.log(`[apec] description length: ${text.length} chars`);
      }
      return text;
    }
  }

  // Strategy 3: any div/section containing >200 chars of text — pick the longest
  const blockMatches = [...html.matchAll(/<(?:div|section|article)[^>]*>([\s\S]{200,5000}?)<\/(?:div|section|article)>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((t) => t.length > 200 && !t.includes('<script') && !t.includes('function('));
  if (blockMatches.length > 0) {
    const longest = blockMatches.reduce((a, b) => (a.length >= b.length ? a : b));
    if (logStatus) {
      console.log(`[apec] HTML parser found description (largest block, ${blockMatches.length} candidates): ${longest.slice(0, 200)}`);
      console.log(`[apec] description length: ${longest.length} chars`);
    }
    return longest;
  }

  // Strategy 4: collect all <p> tags with >80 chars
  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((t) => t.length > 80);
  if (paragraphs.length > 0) {
    const result = paragraphs.join(' ');
    if (logStatus) {
      console.log(`[apec] HTML parser found description (paragraph fallback, ${paragraphs.length} <p> tags): ${result.slice(0, 200)}`);
      console.log(`[apec] description length: ${result.length} chars`);
    }
    return result;
  }

  if (logStatus) console.log(`[apec] HTML parser: no description found for ${jobId} — HTML length: ${html.length} chars`);
  return null;
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
