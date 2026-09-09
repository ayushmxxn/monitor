import { storage, type WxtStorageItem } from 'wxt/utils/storage';
import { DEFAULT_SETTINGS, type AppSettings } from './schema';
import type { Monitor, MonitorCheck } from '@/lib/monitors/types';
import { STORAGE_KEYS } from '@/lib/constants';

function isExtensionEnvironment(): boolean {
  try {
    return (
      (typeof chrome !== 'undefined' && !!chrome?.runtime?.id) ||
      (typeof (globalThis as any).browser !== 'undefined' && !!(globalThis as any).browser?.runtime?.id)
    );
  } catch {
    return false;
  }
}

type StorageKey = Parameters<typeof storage.defineItem>[0];

function createFallbackItem<T>(key: StorageKey, fallback: T): WxtStorageItem<T, Record<string, unknown>> {
  return {
    key,
    defaultValue: fallback,
    fallback,
    getValue: async () => fallback,
    getMeta: async () => ({}),
    setValue: async () => {},
    setMeta: async () => {},
    removeValue: async () => {},
    removeMeta: async () => {},
    watch: () => () => {},
    migrate: async () => {},
  } as WxtStorageItem<T, Record<string, unknown>>;
}

function safeDefineItem<T>(
  key: StorageKey,
  opts: Parameters<typeof storage.defineItem<T>>[1],
): WxtStorageItem<T, Record<string, unknown>> {
  const fallback = (opts?.fallback ?? opts?.defaultValue ?? null) as T;
  if (!isExtensionEnvironment()) {
    return createFallbackItem(key, fallback);
  }
  try {
    const item = storage.defineItem<T>(key, opts as any);
    return {
      ...item,
      watch: (cb: any) => {
        try {
          const unwatch = item.watch(cb);
          return () => {
            try {
              unwatch();
            } catch {
              // Ignore context invalidation
            }
          };
        } catch {
          return () => {};
        }
      },
      getValue: async () => {
        // A failed read must never masquerade as fallback data: callers
        // (createMonitor/updateMonitor/scheduler) treat the result as
        // truth, so returning `[]` here would let the next write silently
        // destroy real data. Failures propagate to the existing
        // Result/error handling instead.
        const res = await item.getValue();
        return (res ?? fallback) as T;
      },
      setValue: async (val: T) => {
        // A failed write must reach the caller's Result/error handling
        // (store.ts relies on the throw for STORAGE_WRITE_FAILED) rather
        // than reporting success while dropping the write.
        await item.setValue(val);
      },
    } as WxtStorageItem<T, Record<string, unknown>>;
  } catch {
    return createFallbackItem(key, fallback);
  }
}

/**
 * Typed, versioned storage items. Use these instead of calling
 * `chrome.storage` directly anywhere else in the codebase - it keeps
 * reads/writes type-safe and gives every value a single migration path.
 *
 * `local:` is used everywhere (not `sync:`) to honor the local-first /
 * no-backend principle: data never leaves the device, even via Chrome's
 * own account sync.
 */
export const settingsItem = safeDefineItem<AppSettings>(STORAGE_KEYS.settings, {
  fallback: DEFAULT_SETTINGS,
  version: 4,
  migrations: {
    2: (stored: unknown) => ({ ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings>) }),
    3: (stored: unknown) => ({ ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings>) }),
    4: (stored: unknown) => ({ ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings>) }),
  },
});

/** The panel's resized width in pixels, remembered across pages/tabs since it's a UI preference rather than page-specific state. */
export const panelWidthItem = safeDefineItem<number>('local:panelWidth', {
  fallback: 360,
  version: 1,
});

/**
 * The window/tab id of the shared, minimized background window that
 * `liveTabStrategy` reuses for every live check instead of opening a
 * fresh popup window per check (see lib/monitors/strategies/liveTabStrategy.ts
 * for why re-opening one every time was the source of a visible flash).
 *
 * `session:` rather than `local:`: this is a live handle to an actual
 * open browser window, not durable data. It has to disappear on its
 * own the moment that's no longer true - a service worker restart
 * shouldn't lose it (session storage survives that, unlike a plain
 * module-level variable would), but a full browser restart closes
 * every window anyway, so the stored id would otherwise point at
 * nothing and every check would fail until the stale id happened to
 * collide with something else. `local:`/`sync:` don't get cleared on
 * browser restart, so either would leak exactly that stale reference.
 */
export const liveCheckWindowItem = safeDefineItem<{ windowId: number; tabId: number } | null>(
  'session:liveCheckWindow',
  { fallback: null },
);

/** All monitors, stored as a single list. Kept as one item since the
 * list itself is small (a handful to a few hundred entries of metadata,
 * not check history) and reads/writes to it are infrequent.
 *
 * v2 replaced the bare `selector: string` field with a full
 * `fingerprint: ElementFingerprint`. A v1 monitor can't be upgraded in
 * place — there's no element on the live page to re-fingerprint from a
 * stored selector string alone — so the migration drops v1 monitors
 * rather than carrying forward a broken shape the rest of the app no
 * longer understands. This only affects installs from before the
 * fingerprinting rewrite; the user is left with an empty list instead
 * of a crash, and can re-add monitors via the picker.
 *
 * v3 added `lastSemanticValue` (semantic type + normalized number
 * derived from `lastValue`). Unlike the v2 rewrite, this one carries
 * forward cleanly — a stored monitor's `lastValue` is still perfectly
 * valid text, it just predates classification — so existing monitors
 * are kept as-is with the new field defaulted to `null` rather than
 * dropped; it gets backfilled naturally on their next successful check. */
export const monitorsItem = safeDefineItem<Monitor[]>('local:monitors', {
  fallback: [],
  version: 3,
  migrations: {
    2: (stored: unknown) => {
      if (!Array.isArray(stored)) return [];
      return stored.filter((m): m is Monitor => !!m && typeof m === 'object' && 'fingerprint' in m);
    },
    3: (stored: unknown) => {
      if (!Array.isArray(stored)) return [];
      return stored.map((m) => ({ lastSemanticValue: null, ...(m as object) }));
    },
  },
});

const historyItemsCache = new Map<string, WxtStorageItem<MonitorCheck[], Record<string, unknown>>>();

/** Per-monitor check history, capped and stored under its own key so
 * that reading the monitor list never has to load every history entry.
 *
 * v2 added `semanticValue` alongside each entry's `value`, backfilled
 * to `null` for pre-existing entries for the same reason as the
 * `monitorsItem` v3 migration above. */
export function historyItem(monitorId: string) {
  let item = historyItemsCache.get(monitorId);
  if (!item) {
    item = safeDefineItem<MonitorCheck[]>(`local:history:${monitorId}`, {
      fallback: [],
      version: 2,
      migrations: {
        2: (stored: unknown) => {
          if (!Array.isArray(stored)) return [];
          return stored.map((c) => ({ semanticValue: null, ...(c as object) }));
        },
      },
    });
    historyItemsCache.set(monitorId, item);
  }
  return item;
}
