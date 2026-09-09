import { useEffect, useState } from 'react';
import { sendMessage } from '@/lib/messaging';

export type PageAccessState = 'checking' | 'granted' | 'denied';

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
 */
export function usePageAccess(): PageAccessState {
  const [state, setState] = useState<PageAccessState>('checking');

  useEffect(() => {
    let cancelled = false;
    const url = window.location.href;

    sendMessage('checkOriginPermissions', [url])
      .then((granted) => {
        if (!cancelled) setState(granted[url] ? 'granted' : 'denied');
      })
      .catch(() => {
        if (!cancelled) setState('denied');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
