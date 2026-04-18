import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addUrlsToStore, readUrlSet, writeJsonFile } from './storage';

describe('storage', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'job-search-storage-'));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('expires seen urls when ttl is reached', async () => {
    const filePath = join(workdir, 'seen.json');
    await writeJsonFile(filePath, {
      seen_urls: ['https://example.com/old'],
      seen_entries: [
        {
          url: 'https://example.com/old',
          timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });

    const urls = await readUrlSet(filePath, 'seen_urls', { ttlMs: 60 * 60 * 1000 });
    expect(urls.size).toBe(0);

    const stored = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(stored.seen_urls).toEqual([]);
  });

  it('stores normalized applied urls', async () => {
    const filePath = join(workdir, 'applied.json');
    await addUrlsToStore(filePath, 'applied_urls', [
      'https://example.com/job?utm_source=test',
    ]);

    const urls = await readUrlSet(filePath, 'applied_urls');
    expect(Array.from(urls)).toEqual(['https://example.com/job']);
  });
});
