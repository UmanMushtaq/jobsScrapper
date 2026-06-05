import { createHash } from 'crypto';
import { redisGet, redisSetEx } from './redis-store';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramOutgoingMessage {
  text: string;
  inlineKeyboard?: InlineButton[][];
}

// 14-day TTL — buttons stay functional for two weeks after sending.
const JOB_REF_TTL_SECONDS = 14 * 24 * 60 * 60;

export function hashJobUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 20);
}

export interface JobRefMeta {
  title: string;
  company: string;
  score: number;
  source: string;
}

export async function storeJobRef(url: string, meta?: JobRefMeta): Promise<string> {
  const hash = hashJobUrl(url);
  await redisSetEx(`job:ref:${hash}`, url, JOB_REF_TTL_SECONDS);
  if (meta) {
    await redisSetEx(`job:meta:${hash}`, JSON.stringify(meta), JOB_REF_TTL_SECONDS);
  }
  return hash;
}

export async function resolveJobRef(hash: string): Promise<string | null> {
  return redisGet(`job:ref:${hash}`);
}

export async function resolveJobMeta(hash: string): Promise<JobRefMeta | null> {
  const raw = await redisGet(`job:meta:${hash}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as JobRefMeta; } catch { return null; }
}

function splitMessage(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if ((current + line).length > maxLength) {
      chunks.push(current.trim());
      current = '';
    }
    current += `${line}\n`;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function sendTelegramMessages(
  botToken: string,
  chatId: string,
  messages: TelegramOutgoingMessage[],
): Promise<void> {
  for (const message of messages) {
    const chunks = splitMessage(message.text);

    for (let i = 0; i < chunks.length; i++) {
      // Only attach the inline keyboard to the last chunk of a multi-part message.
      const isLast = i === chunks.length - 1;
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[i],
        disable_web_page_preview: true,
      };

      if (isLast && message.inlineKeyboard) {
        body.reply_markup = { inline_keyboard: message.inlineKeyboard };
      }

      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Telegram send failed: ${response.status} ${errorText}`);
      }
    }
  }
}

export async function editTelegramMessage(
  botToken: string,
  chatId: number | string,
  messageId: number,
  newText: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: newText,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [] },
    }),
  });
}

export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

export async function registerWebhook(botToken: string, webhookUrl: string): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/setWebhook`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    },
  );
  const data = (await response.json()) as { ok: boolean; description?: string };
  if (data.ok) {
    console.log(`[telegram] webhook registered: ${webhookUrl}`);
  } else {
    console.error(`[telegram] webhook registration failed: ${data.description ?? 'unknown'}`);
  }
}
