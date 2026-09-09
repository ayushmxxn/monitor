import type { Monitor } from './types';

/** How long a single Discord POST may take before it is aborted. */
export const DISCORD_TIMEOUT_MS = 8000;

/** Discord rejects `content` longer than 2000 characters. */
const MAX_CONTENT_LENGTH = 2000;

export interface DiscordWebhookPayload {
  content: string;
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

export function buildDiscordPayload(monitor: Monitor, message: string): DiscordWebhookPayload {
  const content = `**${monitor.name}** changed\n${message}\n${monitor.url}`;
  return {
    content: content.length > MAX_CONTENT_LENGTH ? `${content.slice(0, MAX_CONTENT_LENGTH)}…` : content,
    allowed_mentions: { parse: [] },
  };
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
