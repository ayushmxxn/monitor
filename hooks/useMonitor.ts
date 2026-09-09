import { useMemo } from 'react';
import { useStorage } from '@/hooks/useStorage';
import { monitorsItem } from '@/lib/storage/items';
import type { Monitor } from '@/lib/monitors/types';

/** Reactively reads one monitor from the shared list by id. */
export function useMonitor(id: string | null): {
  monitor: Monitor | null;
  isLoading: boolean;
} {
  const [monitors, , isLoading] = useStorage(monitorsItem);
  const monitor = useMemo(
    () => (id ? (monitors.find((m) => m.id === id) ?? null) : null),
    [monitors, id],
  );
  return { monitor, isLoading };
}
