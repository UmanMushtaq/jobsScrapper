import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface UrlStore {
  seen_urls?: string[];
  applied_urls?: string[];
  dismissed_urls?: string[];
  seen_entries?: UrlEntry[];
  applied_entries?: UrlEntry[];
  dismissed_entries?: UrlEntry[];
}

interface UrlEntry {
  url: string;
  timestamp: string;
}

type UrlKey = 'seen_urls' | 'applied_urls' | 'dismissed_urls';
type EntryKey = 'seen_entries' | 'applied_entries' | 'dismissed_entries';
const ENTRY_KEY_MAP: Record<UrlKey, EntryKey> = {
  seen_urls: 'seen_entries',
  applied_urls: 'applied_entries',
  dismissed_urls: 'dismissed_entries',
};

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
  key: UrlKey,
  options?: {
    ttlMs?: number;
  },
): Promise<Set<string>> {
  const absolutePath = resolve(filePath);
  const store = await readStore(absolutePath);
  const entryKey = ENTRY_KEY_MAP[key];
  const now = Date.now();
  const ttlMs = options?.ttlMs;

  const rawEntries = store[entryKey] as UrlEntry[] | undefined;
  const entries = rawEntries?.filter((entry) => {
    if (!ttlMs) {
      return true;
    }

    return now - new Date(entry.timestamp).getTime() <= ttlMs;
  });

  if (ttlMs && rawEntries?.length !== entries?.length) {
    (store as UrlStore & Record<EntryKey, UrlEntry[] | undefined>)[entryKey] = entries;
    store[key] = (entries ?? []).map((entry) => normalizeUrl(entry.url));
    await writeStore(absolutePath, store);
  }

  if (entries && entries.length > 0) {
    return new Set(entries.map((entry) => normalizeUrl(entry.url)));
  }

  return new Set((store[key] ?? []).map(normalizeUrl));
}

export async function addUrlsToStore(
  filePath: string,
  key: UrlKey,
  urls: string[],
): Promise<void> {
  const absolutePath = resolve(filePath);
  const store = await readStore(absolutePath);
  const currentValues = new Set((store[key] ?? []).map(normalizeUrl));
  const entryKey = ENTRY_KEY_MAP[key];
  const currentEntries = new Map<string, UrlEntry>(
    (((store[entryKey] as UrlEntry[] | undefined) ?? []).map((entry) => [
      normalizeUrl(entry.url),
      { url: normalizeUrl(entry.url), timestamp: entry.timestamp },
    ])),
  );
  const timestamp = new Date().toISOString();

  for (const url of urls) {
    const normalizedUrl = normalizeUrl(url);
    currentValues.add(normalizedUrl);
    currentEntries.set(normalizedUrl, {
      url: normalizedUrl,
      timestamp,
    });
  }

  store[key] = Array.from(currentValues).sort();
  (store as UrlStore & Record<EntryKey, UrlEntry[] | undefined>)[entryKey] = Array.from(
    currentEntries.values(),
  ).sort((left, right) => left.url.localeCompare(right.url));
  await writeStore(absolutePath, store);
}

export async function removeUrlsFromStore(
  filePath: string,
  key: UrlKey,
  urls: string[],
): Promise<void> {
  const absolutePath = resolve(filePath);
  const store = await readStore(absolutePath);
  const entryKey = ENTRY_KEY_MAP[key];
  const removeSet = new Set(urls.map(normalizeUrl));

  store[key] = (store[key] ?? [])
    .map(normalizeUrl)
    .filter((url) => !removeSet.has(url));

  const entries = ((store[entryKey] as UrlEntry[] | undefined) ?? []).filter(
    (entry) => !removeSet.has(normalizeUrl(entry.url)),
  );
  (store as UrlStore & Record<EntryKey, UrlEntry[] | undefined>)[entryKey] = entries;

  await writeStore(absolutePath, store);
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const absolutePath = resolve(filePath);
    const content = await readFile(absolutePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  const absolutePath = resolve(filePath);
  await ensureParentDir(absolutePath);
  await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
