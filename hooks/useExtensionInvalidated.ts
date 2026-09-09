import { useEffect, useState } from 'react';

/**
 * Dispatched on `window` from `entrypoints/panel.content.tsx`'s
 * `ctx.onInvalidated` the moment WXT detects this content script's
 * extension context has gone stale (extension reloaded, updated, or
 * uninstalled while this page stayed open). Plain DOM event rather than
 * an extension message, deliberately: by definition nothing that goes
 * through `chrome.runtime` can be trusted to still work at that point.
 */
export const EXTENSION_INVALIDATED_EVENT = 'monitor-ext:extension-invalidated';

/**
 * True once this content script's extension context has been
 * invalidated. Nothing that touches `chrome.*` APIs can recover from
 * this on its own - every `sendMessage`/storage call will keep failing
 * the same way until the page is reloaded - so callers should use this
 * to stop attempting those calls and prompt for a reload instead of
 * surfacing the raw failures one at a time as they happen.
 */
export function useExtensionInvalidated(): boolean {
  const [invalidated, setInvalidated] = useState(false);

  useEffect(() => {
    if (invalidated) return;
    const handler = () => setInvalidated(true);
    window.addEventListener(EXTENSION_INVALIDATED_EVENT, handler);
    return () => window.removeEventListener(EXTENSION_INVALIDATED_EVENT, handler);
  }, [invalidated]);

  return invalidated;
}
