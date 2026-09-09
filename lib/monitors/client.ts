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

/** Asks the background worker to check one monitor right now, outside its schedule. */
export async function checkMonitorNow(monitorId: string): Promise<Result<void>> {
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
}

/** Asks the background worker to check every enabled monitor right now, outside their individual schedules. */
export async function checkAllMonitorsNow(): Promise<Result<void>> {
  const result = await tryCatch(
    () => withTimeout(sendMessage('checkAllMonitorsNow', undefined), CHECK_ALL_TIMEOUT_MS),
    'MESSAGING_FAILED',
  );
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}
