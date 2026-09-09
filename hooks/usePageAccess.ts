import { useCallback, useEffect, useState } from 'react';
import { sendMessage } from '@/lib/messaging';

export type PageAccessState = 'checking' | 'granted' | 'denied' | 'error';

/**
 * Whether the extension currently holds persistent access to the page
 * this content script is running on. `chrome.permissions` isn't
 * reachable from a content script at all, so this goes through the
 * background worker.
 *
 * Access itself is requested up front, when the panel is opened (see
 * `registerActionClick` in entrypoints/background.ts) - by the time
 * this resolves, the answer is normally already "granted" for a site
 * the user has used Monitor on before. `'denied'` mainly shows up
 * right after the user declines the native permission prompt, or on a
 * page the browser won't allow the extension to touch at all.
 *
 * A messaging/API failure is reported as `'error'`, not `'denied'`:
 * the check itself failed, so nothing is known about access. Callers
 * offer `retry()` (which simply re-runs this same check) instead of
 * locking the panel into a denial for its whole lifetime.
 */
export function usePageAccess(): { state: PageAccessState; retry: () => void } {
  const [state, setState] = useState<PageAccessState>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('checking');
    const url = window.location.href;

    sendMessage('checkOriginPermissions', [url])
      .then((granted) => {
        if (!cancelled) setState(granted[url] ? 'granted' : 'denied');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return { state, retry };
}
