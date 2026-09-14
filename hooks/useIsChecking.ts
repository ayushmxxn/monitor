import { useState, useEffect } from 'react';
import { isMonitorChecking, subscribeChecking } from '@/lib/monitors/client';

/**
 * Reactively reports whether a manual check is currently in flight for `monitorId`.
 * Pass the monitor's `lastCheckedAt` so a card whose result already landed
 * mid-batch flips back to its real state instead of showing Checking until
 * the slowest monitor in a global refresh finishes.
 */
export function useIsChecking(monitorId: string | null | undefined, lastCheckedAt?: number | null): boolean {
  const compute = (id: string | null | undefined, checkedAt: number | null | undefined): boolean =>
    id ? isMonitorChecking(id, checkedAt ?? null) : false;
  const [checking, setChecking] = useState(() => compute(monitorId, lastCheckedAt));

  useEffect(() => {
    setChecking(compute(monitorId, lastCheckedAt));
    return subscribeChecking(() => {
      setChecking(compute(monitorId, lastCheckedAt));
    });
    // `lastCheckedAt` is an input on purpose: every background result
    // write changes it, which re-evaluates exactly the card whose check
    // just finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorId, lastCheckedAt]);

  return checking;
}
