import { useMemo } from 'react';
import { useStorage } from '@/hooks/useStorage';
import { historyItem } from '@/lib/storage/items';
import type { MonitorCheck } from '@/lib/monitors/types';

/** Reactively reads one monitor's check history (newest first, capped). */
export function useMonitorHistory(monitorId: string | null): {
  history: MonitorCheck[];
  isLoading: boolean;
} {
  const item = useMemo(() => historyItem(monitorId ?? '__none__'), [monitorId]);
  const [history, , isLoading] = useStorage(item);
  return { history: monitorId ? history : [], isLoading };
}
