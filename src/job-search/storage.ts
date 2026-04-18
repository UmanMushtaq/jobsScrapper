import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface UrlStore {
  seen_urls?: string[];
  applied_urls?: string[];
}

export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const removableParams = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'source',
    'ref',
    'referrer',
    'trk',
  ];

  for (const key of removableParams) {
    url.searchParams.delete(key);
  }

  url.hash = '';

  const normalizedPath =
    url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;

  url.pathname = normalizedPath;

  return url.toString();
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readStore(filePath: string): Promise<UrlStore> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as UrlStore;
  } catch {
    return {};
  }
}

async function writeStore(filePath: string, store: UrlStore): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

export async function readUrlSet(
  filePath: string,
  key: 'seen_urls' | 'applied_urls',
): Promise<Set<string>> {
  const absolutePath = resolve(filePath);
  const store = await readStore(absolutePath);
  return new Set((store[key] ?? []).map(normalizeUrl));
}

export async function addUrlsToStore(
  filePath: string,
  key: 'seen_urls' | 'applied_urls',
  urls: string[],
): Promise<void> {
  const absolutePath = resolve(filePath);
  const store = await readStore(absolutePath);
  const currentValues = new Set((store[key] ?? []).map(normalizeUrl));

  for (const url of urls) {
    currentValues.add(normalizeUrl(url));
  }

  store[key] = Array.from(currentValues).sort();
  await writeStore(absolutePath, store);
}

