import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sendTelegramMessages } from './telegram';

const FOLLOWUP_DAYS = 7;
const WINDOW_HOURS = 20; // send reminder once within ±20h of the 7-day mark

interface UrlEntry {
  url: string;
  timestamp: string;
}

interface Store {
  applied_entries?: UrlEntry[];
  sent_urls?: string[];
}

async function readJson(path: string): Promise<Store> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8')) as Store;
  } catch {
    return {};
  }
}

async function writeJson(path: string, data: Store): Promise<void> {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export async function checkFollowups(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const appliedFile = process.env.JOB_SEARCH_APPLIED_FILE ?? 'job_search_applied.json';
  const sentFile = process.env.JOB_SEARCH_FOLLOWUP_SENT_FILE ?? 'job_search_followup_sent.json';

  const [appliedStore, sentStore] = await Promise.all([
    readJson(appliedFile),
    readJson(sentFile),
  ]);

  const entries: UrlEntry[] = appliedStore.applied_entries ?? [];
  const alreadySent = new Set<string>(sentStore.sent_urls ?? []);

  const now = Date.now();
  const targetMs = FOLLOWUP_DAYS * 24 * 60 * 60 * 1000;
  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;

  const due = entries.filter((e) => {
    if (alreadySent.has(e.url)) return false;
    const age = now - new Date(e.timestamp).getTime();
    return age >= targetMs - windowMs && age <= targetMs + windowMs;
  });

  if (due.length === 0) return;

  const messages = due.map((e) => {
    const appliedDate = new Date(e.timestamp).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
    return (
      `⏰ Follow-up reminder\n` +
      `You applied ${FOLLOWUP_DAYS} days ago (${appliedDate}).\n` +
      `\nJob: ${e.url}\n` +
      `\nConsider sending a short follow-up email to the hiring manager: confirm your application is complete and express continued interest. Keep it under 3 sentences.`
    );
  });

  await sendTelegramMessages(botToken, chatId, messages);

  for (const e of due) alreadySent.add(e.url);
  sentStore.sent_urls = Array.from(alreadySent);
  await writeJson(sentFile, sentStore);

  console.log(`[followup] sent ${due.length} reminder(s)`);
}
