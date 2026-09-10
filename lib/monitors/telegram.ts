import type { Monitor } from './types';
import type { ValueChangeSummary } from './changeSummary';
import { sendMessage, withTimeout } from '@/lib/messaging';

/** How long a single Telegram API call may take before it is aborted. */
export const TELEGRAM_TIMEOUT_MS = 8000;

/** Upper bound for a manual Test action (poster timeout plus messaging round-trip). */
const TEST_DELIVERY_TIMEOUT_MS = 15_000;

/** Total message cap, mirroring the other channels' safety budget. */
const MAX_MESSAGE_LENGTH = 2000;
const MAX_NAME_LENGTH = 150;
const MAX_VALUE_LENGTH = 500;

/**
 * Bot tokens look like `<numeric-id>:<secret>` (e.g. `123456:ABC-DEF...`).
 * Structural check only - validity itself is proven by the API answering.
 */
export function isValidTelegramBotToken(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(trimmed);
}

/** Chat IDs are integers (negative for groups/channels). */
export function isValidTelegramChatId(chatId: string): boolean {
  const trimmed = chatId.trim();
  if (!trimmed) return false;
  return /^-?\d+$/.test(trimmed);
}

/** Escapes dynamic text for Telegram's HTML parse mode. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Compact change line (e.g. "↑ +$51.48 · +0.1%"); null when there is no numeric delta to show. */
function formatChangeLine(change: ValueChangeSummary): string | null {
  if (!change.isNumeric || !change.formattedDelta) return null;
  const arrow = change.direction === 'decrease' ? '↓' : change.direction === 'increase' ? '↑' : '';
  const parts = arrow ? `${arrow} ${change.formattedDelta}` : change.formattedDelta;
  return change.formattedPercentage ? `${parts} · ${change.formattedPercentage}` : parts;
}

/**
 * Clickable domain text. Falls back to plain text when the URL is
 * missing or unparseable - still no bare URL, so no large preview.
 */
function formatSource(url: string): string {
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname && !/\s/.test(url)) {
      return `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(parsed.hostname)}</a>`;
    }
  } catch {
    // Fall through to the unavailable marker below.
  }
  return 'Link unavailable';
}

export function buildTelegramMessage(
  monitor: Monitor,
  previousValue: string | null,
  newValue: string,
  change: ValueChangeSummary,
): string {
  const lines = [`<b>${escapeHtml(truncate(monitor.name, MAX_NAME_LENGTH))} changed</b>`, ''];
  lines.push(
    previousValue
      ? `${escapeHtml(truncate(previousValue, MAX_VALUE_LENGTH))} → ${escapeHtml(truncate(newValue, MAX_VALUE_LENGTH))}`
      : escapeHtml(truncate(newValue, MAX_VALUE_LENGTH)),
  );
  const changeLine = formatChangeLine(change);
  if (changeLine) lines.push('', changeLine);
  lines.push('', `Source: ${formatSource(monitor.url)}`);
  const message = lines.join('\n');
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
}

/**
 * Sends one alert through the official Telegram Bot API. Best-effort
 * by design: it never throws - every failure path (invalid
 * credentials, unknown chat, unreachable API, non-2xx status
 * including 429 rate-limiting, timeout) resolves to `false` so a
 * failing integration can never fail the check that triggered it.
 * Rate limits are deliberately not retried: retrying would risk
 * delaying or duplicating alerts; the next genuine change delivers
 * fresh state. Never logs the token or full API URL.
 */
export async function sendTelegramAlert(botToken: string, chatId: string, text: string): Promise<boolean> {
  if (!isValidTelegramBotToken(botToken) || !isValidTelegramChatId(chatId)) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken.trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId.trim(),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sends one test alert via the background worker instead of POSTing
 * from the caller: panel content scripts run under the page's origin
 * and CSP, which can block the identical request the background
 * worker delivers fine. Same boolean contract as `sendTelegramAlert`;
 * never throws.
 */
export async function testTelegramDelivery(
  botToken: string,
  chatId: string,
  text: string,
): Promise<boolean> {
  try {
    return await withTimeout(
      sendMessage('testWebhookDelivery', { kind: 'telegram', url: '', payload: text, botToken, chatId }),
      TEST_DELIVERY_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
}
