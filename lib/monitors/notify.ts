import { settingsItem } from '@/lib/storage/items';
import type { Monitor } from './types';
import type { SemanticValue } from './semanticValue';
import { calculateValueChange, formatChangeAlertMessage } from './changeSummary';
import { buildWebhookPayload, isValidWebhookUrl, postWebhookAlert } from './webhook';
import { buildDiscordPayload, isValidDiscordWebhookUrl, postDiscordAlert } from './discord';

/**
 * Single alert fan-out for a confirmed, condition-matched value change.
 * `checker.ts` calls this exactly once per such change (after its
 * per-monitor in-flight dedup), so no channel below can duplicate an
 * alert. The system notification is awaited (fast, local). Webhook and
 * Discord POSTs are awaited too, concurrently: the background message
 * handler stays alive until this promise settles (the messaging layer
 * wires async results to sendResponse), which is what keeps an
 * in-flight POST from being killed by service-worker suspension. Each
 * POST carries its own 8s timeout, persistence already completed above
 * this call, and extraction long before that - so awaiting here never
 * blocks extraction or delays the stored result. All channels are
 * best-effort: delivery failures resolve to false and can never fail
 * the check.
 */
export async function notifyChange(
  monitor: Monitor,
  newValue: string,
  previousValue?: string | null,
  previousSemantic?: SemanticValue | null,
  currentSemantic?: SemanticValue | null,
): Promise<void> {
  let settings: Awaited<ReturnType<typeof settingsItem.getValue>>;
  try {
    settings = await settingsItem.getValue();
  } catch {
    // A failed settings read must not fail an otherwise successful
    // check: skip every alert channel silently rather than inventing
    // fallback defaults that could alert to the wrong endpoints.
    return;
  }

  const prev = previousValue !== undefined ? previousValue : monitor.lastValue;
  const prevSem = previousSemantic !== undefined ? previousSemantic : monitor.lastSemanticValue;
  const currSem = currentSemantic !== undefined ? currentSemantic : null;

  const change = calculateValueChange(prev, prevSem, newValue, currSem);
  const message = formatChangeAlertMessage(change, monitor.alertCondition);

  if (settings.notificationsEnabled) {
    try {
      await browser.notifications.create(`monitor-changed-${monitor.id}-${Date.now()}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: monitor.name,
        message: truncate(message, 150),
      });
    } catch {
      // Notifications are best-effort; a failure here shouldn't fail the check.
    }
  }

  const deliveries: Array<Promise<boolean>> = [];

  if (settings.webhookEnabled && isValidWebhookUrl(settings.webhookUrl)) {
    const payload = buildWebhookPayload(monitor, newValue, prev, message, Date.now());
    deliveries.push(postWebhookAlert(settings.webhookUrl, payload));
  }

  if (settings.discordEnabled && isValidDiscordWebhookUrl(settings.discordWebhookUrl)) {
    const payload = buildDiscordPayload(monitor, prev, newValue, change, Date.now());
    deliveries.push(postDiscordAlert(settings.discordWebhookUrl, payload));
  }

  // Awaited (not fire-and-forget) for the lifetime reason above.
  // `allSettled` over never-rejecting posters: runs each channel exactly
  // once, concurrently, and delivery problems stay delivery problems.
  await Promise.allSettled(deliveries);
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
