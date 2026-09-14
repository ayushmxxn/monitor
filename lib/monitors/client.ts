import { sendMessage, withTimeout } from '@/lib/messaging';
import { tryCatch, AppError, type Result } from '@/lib/errors';

/** Generous enough to cover a live-tab fallback check (tab load timeout + locate budget + margin). */
const CHECK_NOW_TIMEOUT_MS = 35_000;
/**
 * Live-tab checks (see `liveTabStrategy.ts`) run one at a time by
 * design, so several monitors needing that fallback are effectively
 * serialized even though `checkAllMonitorsNow` fires them all at once -
 * this has to cover that full chain (worst case ~8 monitors' worth of
 * live checks back to back), not just one check's worth of headroom.
 * A client-side timeout firing early wouldn't stop the background
 * worker from finishing anyway - it would just report a spurious
 * failure while the real work was still in progress.
 */
const CHECK_ALL_TIMEOUT_MS = 180_000;

const inFlightChecks = new Map<string, Promise<Result<void>>>();
const checkingListeners = new Set<() => void>();

function notifyCheckingListeners(): void {
  for (const listener of checkingListeners) {
    listener();
  }
}

export function isMonitorChecking(monitorId: string, lastCheckedAt?: number | null): boolean {
  if (inFlightChecks.has(monitorId)) return true;
  if (checkAllStartedAt == null || !checkAllIds.has(monitorId)) return false;
  // The batch already wrote this monitor's result back (every completed
  // check stamps lastCheckedAt): show its real state, not Checking, so
  // each card returns to normal the moment its own result lands rather
  // than waiting for the slowest monitor in the batch.
  if (lastCheckedAt != null && lastCheckedAt >= checkAllStartedAt) return false;
  return true;
}

export function subscribeChecking(listener: () => void): () => void {
  checkingListeners.add(listener);
  return () => {
    checkingListeners.delete(listener);
  };
}

/** Asks the background worker to check one monitor right now, outside its schedule. */
export function checkMonitorNow(monitorId: string): Promise<Result<void>> {
  const existing = inFlightChecks.get(monitorId);
  if (existing) {
    return existing;
  }

  const promise: Promise<Result<void>> = (async (): Promise<Result<void>> => {
    try {
      const result = await tryCatch(
        () => withTimeout(sendMessage('checkMonitorNow', monitorId), CHECK_NOW_TIMEOUT_MS),
        'MESSAGING_FAILED',
      );
      if (!result.ok) return result;
      if (!result.value.ok) {
        return {
          ok: false,
          error: new AppError({
            code: 'UNKNOWN',
            message: result.value.error ?? 'The check failed.',
          }),
        };
      }
      return { ok: true, value: undefined };
    } finally {
      inFlightChecks.delete(monitorId);
      notifyCheckingListeners();
    }
  })();

  inFlightChecks.set(monitorId, promise);
  notifyCheckingListeners();
  return promise;
}

let checkAllInFlight: Promise<Result<void>> | null = null;
// Monitors covered by the in-flight global refresh, with the batch start
// time. Purely presentational: lets cards show Checking the instant the
// user clicks refresh instead of sitting on stale states until each
// background result streams back through storage. The background
// check/recovery/error pipeline itself is untouched.
const checkAllIds = new Set<string>();
let checkAllStartedAt: number | null = null;

/**
 * Asks the background worker to check every enabled monitor right now, outside their individual schedules.
 * Pass the enabled monitor ids so their cards can show Checking immediately; each card flips back to its
 * real state as soon as its own result lands (see `isMonitorChecking`).
 */
export function checkAllMonitorsNow(monitorIds: string[] = []): Promise<Result<void>> {
  if (checkAllInFlight) {
    return checkAllInFlight;
  }

  for (const id of monitorIds) checkAllIds.add(id);
  checkAllStartedAt = Date.now();
  notifyCheckingListeners();

  checkAllInFlight = (async (): Promise<Result<void>> => {
    try {
      const result = await tryCatch(
        () => withTimeout(sendMessage('checkAllMonitorsNow', undefined), CHECK_ALL_TIMEOUT_MS),
        'MESSAGING_FAILED',
      );
      if (!result.ok) return result;
      return { ok: true, value: undefined };
    } finally {
      checkAllInFlight = null;
      checkAllIds.clear();
      checkAllStartedAt = null;
      notifyCheckingListeners();
    }
  })();

  return checkAllInFlight;
}
