import { listMonitors } from './store';
import { checkMonitor } from './checker';
import type { Monitor } from './types';

const TICK_ALARM_NAME = 'monitor-tick';
/** Chrome enforces a 1-minute floor on repeating alarms outside dev mode. */
const TICK_PERIOD_MINUTES = 1;

export async function ensureScheduler(): Promise<void> {
  const existing = await browser.alarms.get(TICK_ALARM_NAME);
  if (existing) return;
  browser.alarms.create(TICK_ALARM_NAME, { periodInMinutes: TICK_PERIOD_MINUTES });
}

export function isSchedulerAlarm(alarmName: string): boolean {
  return alarmName === TICK_ALARM_NAME;
}

/** Checks every enabled monitor whose interval has elapsed. Failures are isolated per-monitor. */
export async function runDueMonitors(): Promise<void> {
  await ensureScheduler();
  const result = await listMonitors();
  if (!result.ok) {
    console.error('[scheduler] Failed to list monitors:', result.error);
    return;
  }

  const due = result.value.filter((monitor) => isDue(monitor));
  await Promise.allSettled(
    due.map((monitor) =>
      checkMonitor(monitor).catch((error) => {
        console.error(`[scheduler] Check failed for monitor "${monitor.id}":`, error);
      }),
    ),
  );
}

function isDue(monitor: Monitor): boolean {
  if (!monitor.enabled) return false;
  if (monitor.lastCheckedAt === null) return true;
  const elapsedMinutes = (Date.now() - monitor.lastCheckedAt) / 60_000;
  return elapsedMinutes >= monitor.intervalMinutes;
}

let checkAllInFlight: Promise<void> | null = null;

/** Checks every enabled monitor right now, ignoring each one's schedule. Failures are isolated per-monitor. */
export function checkAllMonitorsNow(): Promise<void> {
  if (checkAllInFlight) {
    return checkAllInFlight;
  }

  checkAllInFlight = (async () => {
    try {
      const result = await listMonitors();
      if (!result.ok) {
        console.error('[scheduler] Failed to list monitors:', result.error);
        return;
      }

      const enabled = result.value.filter((monitor) => monitor.enabled);
      await Promise.allSettled(
        enabled.map((monitor) =>
          checkMonitor(monitor).catch((error) => {
            console.error(`[scheduler] Check failed for monitor "${monitor.id}":`, error);
          }),
        ),
      );
    } finally {
      checkAllInFlight = null;
    }
  })();

  return checkAllInFlight;
}
