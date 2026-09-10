import { useCallback, useEffect, useState } from 'react';
import type { WxtStorageItem } from 'wxt/utils/storage';

const storageCache = new Map<string, unknown>();

/**
 * Subscribes a React component to a WXT storage item, keeping it in sync
 * across every extension surface (panel, options, background) via
 * `chrome.storage.onChanged`.
 *
 * @example
 * const [settings, setSettings, isLoading] = useStorage(settingsItem);
 */
export function useStorage<TValue>(
  item: WxtStorageItem<TValue, Record<string, unknown>>,
): [TValue, (value: TValue) => Promise<boolean>, boolean] {
  const [value, setValue] = useState<TValue>(() => {
    if (storageCache.has(item.key)) {
      return storageCache.get(item.key) as TValue;
    }
    return item.fallback;
  });
  const [isLoading, setIsLoading] = useState<boolean>(() => !storageCache.has(item.key));

  useEffect(() => {
    let cancelled = false;

    item
      .getValue()
      .then((current) => {
        if (!cancelled) {
          storageCache.set(item.key, current);
          setValue(current);
          setIsLoading(false);
        }
      })
      .catch((error) => {
        // Most commonly a stale extension context (see lib/errors.ts) -
        // without this, a rejection here left `isLoading` stuck `true`
        // forever with no indication anything had gone wrong.
        console.error('[useStorage] Failed to read', item.key, error);
        if (!cancelled) setIsLoading(false);
      });

    let unwatch: (() => void) | undefined;
    try {
      unwatch = item.watch((next) => {
        storageCache.set(item.key, next);
        if (!cancelled) setValue(next);
      });
    } catch (error) {
      // `watch` can throw synchronously against a stale context too.
      console.error('[useStorage] Failed to watch', item.key, error);
    }

    return () => {
      cancelled = true;
      try {
        unwatch?.();
      } catch {
        // Stale or invalidated context on unmount - ignore.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key]);

  const update = useCallback(
    async (next: TValue): Promise<boolean> => {
      const previous = (storageCache.has(item.key) ? storageCache.get(item.key) : item.fallback) as TValue;
      storageCache.set(item.key, next);
      setValue(next);
      try {
        await item.setValue(next);
        return true;
      } catch (error) {
        console.error('[useStorage] Failed to set', item.key, error);
        // Revert the optimistic update so the UI never claims a change
        // that storage rejected. The boolean lets multi-write callers
        // stop before a second write diverges from the reverted first.
        storageCache.set(item.key, previous);
        setValue(previous);
        return false;
      }
    },
    [item],
  );

  return [value, update, isLoading];
}
