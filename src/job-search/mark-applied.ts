import { addUrlsToStore } from './storage';

async function main(): Promise<void> {
  const [rawUrl] = process.argv.slice(2);
  if (!rawUrl) {
    throw new Error('Usage: npm run jobs:applied:add -- <job-url>');
  }

  const appliedFile = process.env.JOB_SEARCH_APPLIED_FILE ?? 'job_search_applied.json';
  await addUrlsToStore(appliedFile, 'applied_urls', [rawUrl]);
  console.log(`Saved applied job URL to ${appliedFile}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

