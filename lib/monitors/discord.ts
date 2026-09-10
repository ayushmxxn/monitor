import type { Monitor } from './types';
import type { ValueChangeSummary } from './changeSummary';
import { sendMessage, withTimeout } from '@/lib/messaging';

/** How long a single Discord POST may take before it is aborted. */
export const DISCORD_TIMEOUT_MS = 8000;

/**
 * Per-part caps keep every alert well under Discord's own embed
 * limits, with the whole JSON body staying inside the historical
 * ~2000-character safety budget.
 */
const MAX_TITLE_LENGTH = 150;
const MAX_VALUE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 800;

const COLOR_INCREASE = 0x57f287;
const COLOR_DECREASE = 0xed4245;
const COLOR_NEUTRAL = 0x95a5a6;

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
}

export interface DiscordWebhookPayload {
  /** Exactly one embed per alert - never a raw content message. */
  embeds: [DiscordEmbed];
  /** Never allow a monitored value to trigger a mass mention. */
  allowed_mentions: { parse: [] };
}

/**
 * Only genuine Discord channel webhook URLs are accepted: https,
 * a Discord host, and an `/api/webhooks/{id}/{token}` path. Anything
 * else (including a plain generic http(s) URL) is rejected so a
 * Discord-shaped message is never POSTed somewhere unexpected.
 */
export function isValidDiscordWebhookUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const isDiscordHost =
    host === 'discord.com' ||
    host.endsWith('.discord.com') ||
    host === 'discordapp.com' ||
    host.endsWith('.discordapp.com');
  if (!isDiscordHost) return false;
  const parts = parsed.pathname.split('/').filter(Boolean);
  return parts.length >= 4 && parts[0] === 'api' && parts[1] === 'webhooks' && !parts[2]!.includes(' ') && !parts[3]!.includes(' ');
}

export function buildDiscordPayload(
  monitor: Monitor,
  previousValue: string | null,
  newValue: string,
  change: ValueChangeSummary,
  checkedAt: number,
): DiscordWebhookPayload {
  // Hierarchy: bold value transition first, direction-colored change
  // second, linked domain + relative-time metadata last. No fields, no
  // footer, no bare URL anywhere - so nothing can unfurl a link preview.
  const transition = previousValue
    ? `**${truncate(previousValue, MAX_VALUE_LENGTH)} → ${truncate(newValue, MAX_VALUE_LENGTH)}**`
    : `**${truncate(newValue, MAX_VALUE_LENGTH)}**`;
  const lines = [transition, ''];
  const changeLine = formatChangeLine(change);
  if (changeLine) lines.push(changeLine, '');
  lines.push(`${formatSource(monitor.url)} · <t:${formatUnixTime(checkedAt)}:R>`);
  return {
    embeds: [
      {
        title: truncate(`${monitor.name} changed`, MAX_TITLE_LENGTH),
        description: truncate(lines.join('\n'), MAX_DESCRIPTION_LENGTH),
        color:
          change.direction === 'decrease'
            ? COLOR_DECREASE
            : change.direction === 'increase'
              ? COLOR_INCREASE
              : COLOR_NEUTRAL,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/** Compact change line (e.g. "↑ +$25.00 · +25.0%"); null when there is no numeric delta to show. */
function formatChangeLine(change: ValueChangeSummary): string | null {
  if (!change.isNumeric || !change.formattedDelta) return null;
  // Plain embed text by design: no code fences, inline code, or
  // preformatted blocks anywhere - they render as tinted boxes and
  // copy-paste as formatted code. Direction color lives on the
  // embed accent and the arrow glyph, never in a container.
  const arrow = change.direction === 'decrease' ? '↓' : change.direction === 'increase' ? '↑' : '';
  const parts = arrow ? `${arrow} ${change.formattedDelta}` : change.formattedDelta;
  return change.formattedPercentage ? `${parts} · ${change.formattedPercentage}` : parts;
}

/**
 * Clickable domain text. A markdown link never unfurls a preview the
 * way a bare URL would. Falls back to plain text when the URL is
 * missing or unparseable.
 */
function formatSource(url: string): string {
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname && !/\s/.test(url)) {
      return `[${parsed.hostname}](${url})`;
    }
  } catch {
    // Fall through to the unavailable marker below.
  }
  return 'Link unavailable';
}

function formatUnixTime(checkedAt: number): number {
  if (Number.isFinite(checkedAt)) {
    const seconds = Math.floor(checkedAt / 1000);
    if (Number.isSafeInteger(seconds)) return seconds;
  }
  return Math.floor(Date.now() / 1000);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Sends one alert to a Discord channel webhook. Best-effort by design:
 * it never throws - every failure path (invalid URL, timeout, network
 * error, non-2xx status including 429 rate-limiting) resolves to
 * `false` so a failing webhook can never fail the check that
 * triggered it. Rate limits are deliberately not retried here: the
 * alert path is fire-and-forget, so retrying would risk delaying or
 * duplicating alerts; the next genuine change delivers fresh state.
 */
export async function postDiscordAlert(url: string, payload: DiscordWebhookPayload): Promise<boolean> {
  if (!isValidDiscordWebhookUrl(url)) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const response = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Upper bound for a manual Test action (poster timeout plus messaging round-trip). */
const TEST_DELIVERY_TIMEOUT_MS = 15_000;

/**
 * Sends one test alert via the background worker instead of POSTing
 * from the caller: panel content scripts run under the page's origin
 * and CSP, which can block the identical request the background
 * worker delivers fine. Same boolean contract as `postDiscordAlert`;
 * never throws.
 */
export async function testWebhookDelivery(url: string, payload: DiscordWebhookPayload): Promise<boolean> {
  try {
    return await withTimeout(
      sendMessage('testWebhookDelivery', { kind: 'discord', url, payload }),
      TEST_DELIVERY_TIMEOUT_MS,
    );
  } catch {
    return false;
  }
}
