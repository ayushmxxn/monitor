import { settingsItem } from '@/lib/storage/items';
import type { Monitor } from './types';
import type { SemanticValue } from './semanticValue';
import { calculateValueChange, formatChangeAlertMessage } from './changeSummary';

/** Shows a system notification for a changed value, if the user has them enabled. */
export async function notifyChange(
  monitor: Monitor,
  newValue: string,
  previousValue?: string | null,
  previousSemantic?: SemanticValue | null,
  currentSemantic?: SemanticValue | null,
): Promise<void> {
  const settings = await settingsItem.getValue();
  if (!settings.notificationsEnabled) return;

  const prev = previousValue !== undefined ? previousValue : monitor.lastValue;
  const prevSem = previousSemantic !== undefined ? previousSemantic : monitor.lastSemanticValue;
  const currSem = currentSemantic !== undefined ? currentSemantic : null;

  const change = calculateValueChange(prev, prevSem, newValue, currSem);
  const message = formatChangeAlertMessage(change, monitor.alertCondition);

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

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
