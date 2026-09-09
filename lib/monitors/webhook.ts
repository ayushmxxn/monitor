import type { Monitor } from './types';

/** How long a single webhook POST may take before it is aborted. */
export const WEBHOOK_TIMEOUT_MS = 8000;

/** Maximum body size we will ever send; alert text is truncated to fit. */
const MAX_MESSAGE_LENGTH = 500;

export interface WebhookAlertPayload {
  event: 'monitor.changed';
  monitorId: string;
  monitorName: string;
  url: string;
  previousValue: string | null;
  currentValue: string;
  message: string;
  checkedAt: number;
}

/** Only http(s) destinations are allowed - never chrome://, file://, etc. */
export function isValidWebhookUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildWebhookPayload(
  monitor: Monitor,
  newValue: string,
  previousValue: string | null,
  message: string,
  checkedAt: number,
): WebhookAlertPayload {
  return {
    event: 'monitor.changed',
    monitorId: monitor.id,
    monitorName: monitor.name,
    url: monitor.url,
    previousValue,
    currentValue: newValue,
    message: message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message,
    checkedAt,
  };
}

/**
 * POSTs one alert to `url` as JSON. Best-effort by design: it never
 * throws - every failure path (bad URL, timeout, network error,
 * non-2xx status) resolves to `false` so a failing webhook can never
 * fail the check that triggered it.
 */
export async function postWebhookAlert(url: string, payload: WebhookAlertPayload): Promise<boolean> {
  if (!isValidWebhookUrl(url)) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
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
