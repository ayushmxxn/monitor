import { useCallback, useState } from 'react';
import { useStorage } from '@/hooks/useStorage';
import { monitorsItem } from '@/lib/storage/items';
import * as store from '@/lib/monitors/store';
import type { Monitor } from '@/lib/monitors/types';
import { AppError } from '@/lib/errors';

interface UseMonitorsResult {
  monitors: Monitor[];
  isLoading: boolean;
  error: AppError | null;
  remove: (id: string) => Promise<boolean>;
  reorder: (orderedIds: string[]) => Promise<boolean>;
}

/**
 * Reads the monitor list reactively (updates across panel/options/background
 * automatically via `chrome.storage.onChanged`) and exposes CRUD actions
 * that go through `lib/monitors/store`, surfacing failures as `AppError`
 * instead of throwing into the component tree.
 *
 * Creation isn't here: monitors are created directly by the picker in
 * `entrypoints/pageAgent.content.ts` the moment a valid value is
 * clicked - see `useElementPicker` for how the panel kicks that off.
 */
export function useMonitors(): UseMonitorsResult {
  const [monitors, , isLoading] = useStorage(monitorsItem);
  const [error, setError] = useState<AppError | null>(null);

  const remove = useCallback(async (id: string): Promise<boolean> => {
    setError(null);
    const result = await store.deleteMonitor(id);
    if (!result.ok) setError(result.error);
    return result.ok;
  }, []);

  const reorder = useCallback(async (orderedIds: string[]): Promise<boolean> => {
    setError(null);
    const result = await store.reorderMonitors(orderedIds);
    if (!result.ok) setError(result.error);
    return result.ok;
  }, []);

  return { monitors, isLoading, error, remove, reorder };
}
