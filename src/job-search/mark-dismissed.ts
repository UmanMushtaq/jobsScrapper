import { markJobDecision } from './run';

async function main(): Promise<void> {
  const [rawUrl] = process.argv.slice(2);
  if (!rawUrl) {
    throw new Error('Usage: npm run jobs:dismiss:add -- <job-url>');
  }

  await markJobDecision('dismissed', rawUrl);
  console.log('Saved dismissed job URL');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
