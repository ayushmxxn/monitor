import { tryCatch, AppError, type Result } from '@/lib/errors';
import { monitorsItem, historyItem, settingsItem } from '@/lib/storage/items';
import { serializeByKey } from './concurrency';
import {
  HISTORY_RETENTION_MS,
  MAX_HISTORY_ENTRIES,
  MIN_INTERVAL_MINUTES,
  UNCHANGED_SAMPLE_INTERVAL_MS,
  type CreateMonitorInput,
  type Monitor,
  type MonitorCheck,
} from './types';

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `mon_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Per-key write queue (see `serializeByKey` in `concurrency.ts`).
 * `monitorsItem`/`historyItem` are plain `getValue()`/`setValue()` pairs
 * with no atomic compare-and-swap, and every mutation below is
 * read-modify-write over the *whole* array — "add this monitor", "patch
 * this monitor", "trim this monitor's history" all start by reading the
 * current array and end by writing a new one back. Two such calls that
 * overlap (the common case: `checkMonitor` runs concurrently for several
 * monitors via `checkAllMonitorsNow`'s `Promise.allSettled`, and each
 * check itself calls `updateMonitor` more than once — "checking" at the
 * start, then a success/failure patch at the end) can each read the
 * same starting array before either has written back, so whichever
 * write lands second silently clobbers the first — a classic
 * lost-update race. A self-healing fingerprint update from recovery is
 * exactly the kind of write this can quietly drop.
 *
 * Scoped per key (the monitors list is one key; each monitor's history
 * is its own key) so unrelated writes never wait on each other.
 *
 * This only serializes calls made from *this* JS execution context. All
 * of the check-driven mutations this exists to protect happen in the
 * background worker (`checkMonitor`'s only call sites — see
 * `scheduler.ts` and `entrypoints/background.ts`), which is the race
 * this fixes. A write issued from the panel/options UI at the exact
 * same instant runs in a separate context with its own queue and isn't
 * covered by this — see the audit notes for why that residual gap is
 * out of scope here.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return serializeByKey(writeQueues, key, fn);
}

const MONITORS_LOCK_KEY = 'monitors';
const historyLockKey = (monitorId: string): string => `history:${monitorId}`;

export function listMonitors(): Promise<Result<Monitor[]>> {
  return tryCatch(() => monitorsItem.getValue(), 'STORAGE_READ_FAILED');
}

export async function getMonitor(id: string): Promise<Result<Monitor>> {
  const result = await listMonitors();
  if (!result.ok) return result;
  const monitor = result.value.find((m) => m.id === id);
  if (!monitor) {
    return {
      ok: false,
      error: new AppError({
        code: 'NOT_FOUND',
        message: `Monitor "${id}" was not found.`,
      }),
    };
  }
  return { ok: true, value: monitor };
}

export function createMonitor(
  input: CreateMonitorInput,
): Promise<Result<Monitor>> {
  return tryCatch(() => withWriteLock(MONITORS_LOCK_KEY, async () => {
    const now = Date.now();
    const settings = await settingsItem.getValue();
    const monitor: Monitor = {
      id: newId(),
      name: input.name.trim() || new URL(input.url).hostname,
      url: input.url,
      fingerprint: input.fingerprint,
      extractMode: input.extractMode,
      attributeName: input.attributeName ?? null,
      intervalMinutes: Math.max(
        input.intervalMinutes ?? settings.defaultIntervalMinutes,
        MIN_INTERVAL_MINUTES,
      ),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
      lastValue: null,
      lastSemanticValue: null,
      lastStatus: 'idle',
      lastError: null,
      lastDiagnosticCode: null,
      checkStrategy: null,
      consecutiveFailures: 0,
      lastConfidence: null,
      consecutiveRelocations: 0,
      totalSuccessfulChecks: 0,
      lastFingerprintUpdateAt: null,
      stats: null,
    };

    const current = await monitorsItem.getValue();
    await monitorsItem.setValue([...current, monitor]);
    return monitor;
  }), 'STORAGE_WRITE_FAILED');
}

export function updateMonitor(
  id: string,
  patch: Partial<Omit<Monitor, 'id' | 'createdAt'>>,
): Promise<Result<Monitor>> {
  return tryCatch(() => withWriteLock(MONITORS_LOCK_KEY, async () => {
    const current = await monitorsItem.getValue();
    const index = current.findIndex((m) => m.id === id);
    if (index === -1) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: `Monitor "${id}" was not found.`,
      });
    }
    const updated: Monitor = {
      ...current[index]!,
      ...patch,
      updatedAt: Date.now(),
    };
    const next = [...current];
    next[index] = updated;
    await monitorsItem.setValue(next);
    return updated;
  }), 'STORAGE_WRITE_FAILED');
}

/**
 * Applies a new check interval to every existing monitor at once, so
 * the global "check every" setting takes effect immediately instead of
 * only on monitors created from now on.
 */
export function setAllMonitorsInterval(minutes: number): Promise<Result<void>> {
  return tryCatch(() => withWriteLock(MONITORS_LOCK_KEY, async () => {
    const current = await monitorsItem.getValue();
    const now = Date.now();
    await monitorsItem.setValue(
      current.map((m) => ({ ...m, intervalMinutes: minutes, updatedAt: now })),
    );
  }), 'STORAGE_WRITE_FAILED');
}

export function deleteMonitor(id: string): Promise<Result<void>> {
  return tryCatch(() => withWriteLock(MONITORS_LOCK_KEY, async () => {
    const current = await monitorsItem.getValue();
    await monitorsItem.setValue(current.filter((m) => m.id !== id));
    await withWriteLock(historyLockKey(id), () => historyItem(id).removeValue());
  }), 'STORAGE_WRITE_FAILED');
}

/** Deletes every monitor and its history in one go, for the "Clear all monitors" settings action. */
export function clearAllMonitors(): Promise<Result<void>> {
  return tryCatch(() => withWriteLock(MONITORS_LOCK_KEY, async () => {
    const current = await monitorsItem.getValue();
    await monitorsItem.setValue([]);
    await Promise.all(
      current.map((m) => withWriteLock(historyLockKey(m.id), () => historyItem(m.id).removeValue())),
    );
  }), 'STORAGE_WRITE_FAILED');
}

export function getHistory(monitorId: string): Promise<Result<MonitorCheck[]>> {
  return tryCatch(
    () => historyItem(monitorId).getValue(),
    'STORAGE_READ_FAILED',
  );
}

/**
 * Appends a check result with 30-day retention and a hard safety ceiling.
 * Unchanged checks are sampled periodically (preserving exact observation timestamps)
 * while real events, changes, and error recoveries are always recorded.
 */
export function appendHistory(
  check: MonitorCheck,
): Promise<Result<MonitorCheck[]>> {
  return tryCatch(() => withWriteLock(historyLockKey(check.monitorId), async () => {
    const item = historyItem(check.monitorId);
    const current = await item.getValue();

    const last = current[0];
    const isErrorRecovery = !!(last && last.error !== null && check.error === null);
    const isValueChanged = !!(last && last.value !== check.value);
    const isPeriodicSample = !!(last && (check.checkedAt - last.checkedAt >= UNCHANGED_SAMPLE_INTERVAL_MS));

    const shouldRecord =
      current.length === 0 ||
      check.changed ||
      check.error !== null ||
      isErrorRecovery ||
      isValueChanged ||
      isPeriodicSample;

    let next = shouldRecord ? [check, ...current] : current;

    // Primary retention: 30 days
    const now = check.checkedAt;
    const cutoff = now - HISTORY_RETENTION_MS;
    next = next.filter((entry) => entry.checkedAt >= cutoff);

    // Hard safety ceiling
    if (next.length > MAX_HISTORY_ENTRIES) {
      next = next.slice(0, MAX_HISTORY_ENTRIES);
    }

    if (shouldRecord || next.length !== current.length) {
      await item.setValue(next);
    }
    return next;
  }), 'STORAGE_WRITE_FAILED');
}
