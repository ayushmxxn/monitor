import { useEffect, useState } from 'react';
import { sendMessage, withTimeout, type AppInfo } from '@/lib/messaging';
import { AppError } from '@/lib/errors';
import { MESSAGE_TIMEOUT_MS } from '@/lib/constants';

interface UseAppInfoResult {
  appInfo: AppInfo | null;
  isLoading: boolean;
  error: AppError | null;
}

/**
 * Fetches app info from the background worker on mount. Doubles as a
 * connectivity check: if the background worker is unreachable, `error`
 * is populated instead of throwing.
 */
export function useAppInfo(): UseAppInfoResult {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  useEffect(() => {
    let cancelled = false;

    withTimeout(sendMessage('getAppInfo', undefined), MESSAGE_TIMEOUT_MS)
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(AppError.from(cause, 'MESSAGING_FAILED'));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { appInfo, isLoading, error };
}
