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
const MAX_FOOTER_LENGTH = 250;

const COLOR_INCREASE = 0x57f287;
const COLOR_DECREASE = 0xed4245;
const COLOR_NEUTRAL = 0x95a5a6;

export interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

export interface DiscordEmbed {
  title: string;
  url?: string;
  description: string;
  color: number;
  timestamp?: string;
  footer?: DiscordEmbedFooter;
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
  const transition = previousValue
    ? `**${truncate(previousValue, MAX_VALUE_LENGTH)} → ${truncate(newValue, MAX_VALUE_LENGTH)}**`
    : `**${truncate(newValue, MAX_VALUE_LENGTH)}**`;
  const lines = [transition];

  const changeLine = formatChangeLine(change);
  if (changeLine) {
    lines.push(changeLine);
  }

  const embedUrl = parseEmbedUrl(monitor.url);
  const favicon = resolveFaviconUrl(monitor.url);
  const footerText = formatSource(monitor.url);

  const embed: DiscordEmbed = {
    title: truncate(`${monitor.name} changed`, MAX_TITLE_LENGTH),
    description: truncate(lines.join('\n'), MAX_DESCRIPTION_LENGTH),
    color:
      change.direction === 'decrease'
        ? COLOR_DECREASE
        : change.direction === 'increase'
          ? COLOR_INCREASE
          : COLOR_NEUTRAL,
    timestamp: formatIsoTimestamp(checkedAt),
    footer: {
      text: truncate(footerText, MAX_FOOTER_LENGTH),
      ...(favicon ? { icon_url: favicon } : {}),
    },
  };

  if (embedUrl) {
    embed.url = embedUrl;
  }

  return {
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Direction-colored change line (green for increase, red for decrease)
 * displaying delta and percentage formatted with ANSI escape sequences.
 */
function formatChangeLine(change: ValueChangeSummary): string | null {
  if (!change.isNumeric || !change.formattedDelta) return null;
  const arrow = change.direction === 'decrease' ? '↓' : change.direction === 'increase' ? '↑' : '';
  const parts = arrow ? `${arrow} ${change.formattedDelta}` : change.formattedDelta;
  const text = change.formattedPercentage ? `${parts} · ${change.formattedPercentage}` : parts;

  if (change.direction === 'increase') {
    return `\`\`\`ansi\n\u001b[32m${text}\u001b[0m\n\`\`\``;
  }
  if (change.direction === 'decrease') {
    return `\`\`\`ansi\n\u001b[31m${text}\u001b[0m\n\`\`\``;
  }
  return text;
}

/**
 * Safely parses and normalizes a web URL, forgiving missing schemes
 * (e.g. "coinmarketcap.com") and stripping trailing garbage.
 */
function normalizeHttpUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
      return parsed;
    }
  } catch {
    // Malformed or unsupported URL
  }
  return null;
}

/**
 * Resolves a safe, publicly accessible favicon URL for Discord's image proxy.
 * Uses Google's S2 favicon service for the domain with a 64px PNG resolution,
 * which fetches the site's actual favicon and provides a safe fallback image
 * if the site's favicon cannot be loaded or is unavailable.
 * Returns null if the URL is missing or malformed.
 */
export function resolveFaviconUrl(url: string): string | null {
  const parsed = normalizeHttpUrl(url);
  if (!parsed) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname.toLowerCase())}&sz=64`;
}

function parseEmbedUrl(url: string): string | undefined {
  const parsed = normalizeHttpUrl(url);
  return parsed?.href;
}

function formatSource(url: string): string {
  const parsed = normalizeHttpUrl(url);
  if (parsed?.hostname) {
    return parsed.hostname;
  }
  return 'Link unavailable';
}

function formatIsoTimestamp(checkedAt: number): string {
  if (Number.isFinite(checkedAt)) {
    const d = new Date(checkedAt);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
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
