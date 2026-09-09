import { useState, useEffect } from 'react';
import { isMonitorChecking, subscribeChecking } from '@/lib/monitors/client';

/** Reactively reports whether a manual check is currently in flight for `monitorId`. */
export function useIsChecking(monitorId: string | null | undefined): boolean {
  const [checking, setChecking] = useState(() => (monitorId ? isMonitorChecking(monitorId) : false));

  useEffect(() => {
    if (!monitorId) {
      setChecking(false);
      return;
    }
    setChecking(isMonitorChecking(monitorId));
    return subscribeChecking(() => {
      setChecking(isMonitorChecking(monitorId));
    });
  }, [monitorId]);

  return checking;
}
